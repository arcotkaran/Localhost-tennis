// Local WebSocket host: instant launch, 4-digit room code, up to 4 phones.
// If a phone drops mid-match the game pauses elegantly, the exact state is
// snapshotted, and the same player can reconnect and resume losslessly.

import { WebSocketServer } from 'ws';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { MSG, MAX_PLAYERS, encode, decode, cleanName } from '../shared/protocol.js';
import { LagCompensator } from './lag-compensator.js';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary', '.json': 'application/json',
};

export class TennisServer extends EventEmitter {
  constructor({ port = 0, staticRoot = null, lanHost = null, now = () => performance.now() } = {}) {
    super();
    this.port = port;
    this.staticRoot = staticRoot;
    this.lanHost = lanHost; // LAN IP phones should reach (for the QR join URL)
    this.now = now;
    this.roomCode = String(Math.floor(1000 + Math.random() * 9000));
    this.players = new Map(); // playerId -> { slot, name, ws, connected }
    this.slots = new Array(MAX_PLAYERS).fill(null); // slot -> playerId
    this.hostWs = null;
    this.lag = new LagCompensator();
    this.atMenu = true;        // TV is showing the menu (vs. in a match) — last value the host reported
    this.gameState = {
      phase: 'lobby',      // lobby | playing | paused
      snapshot: null,      // exact state saved at pause
      match: null,         // live match state (set by game loop)
      pausedFor: [],       // playerIds we are waiting on
    };
  }

  async start() {
    this.http = createServer((req, res) => this.serveStatic(req, res));
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', ws => this.onConnection(ws));
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, () => resolve());
    });
    this.port = this.http.address().port;
    return this;
  }

  async stop() {
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    await new Promise(r => this.wss.close(r));
    await new Promise(r => this.http.close(r));
  }

  async serveStatic(req, res) {
    // Dev-only visual verification: the TV page POSTs a rendered frame here
    // (loopback only) so automated checks can inspect actual pixels.
    if (req.url === '/api/debug/frame' && req.method === 'POST') {
      const remote = req.socket.remoteAddress;
      if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') || !this.staticRoot) {
        res.writeHead(403); res.end(); return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const dataUrl = Buffer.concat(chunks).toString('utf8');
          const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
          const { writeFile, mkdir } = await import('node:fs/promises');
          await mkdir(join(this.staticRoot, '.debug'), { recursive: true });
          await writeFile(join(this.staticRoot, '.debug', 'last-render.jpg'), Buffer.from(b64, 'base64'));
          res.writeHead(200); res.end('saved');
        } catch {
          res.writeHead(500); res.end();
        }
      });
      return;
    }
    // The TV view (running on the host machine) fetches the room code here.
    // Loopback-only: phones on the LAN must read the code off the TV screen.
    if (req.url === '/api/info') {
      const remote = req.socket.remoteAddress;
      const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (isLoopback) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const lanUrl = this.lanHost ? `http://${this.lanHost}:${this.port}/` : null;
        res.end(JSON.stringify({ roomCode: this.roomCode, port: this.port, lanUrl }));
      } else {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'room code is only served to the host machine' }));
      }
      return;
    }
    if (!this.staticRoot) { res.writeHead(404); res.end(); return; }
    // Resolve the file from the PATHNAME only — a query/hash (e.g. the TV opened
    // as /client_host/index.html?code=1234) must not become part of the path or
    // readFile fails and the page 404s.
    const pathname = req.url.split(/[?#]/)[0];
    // Redirect instead of serving the controller at '/': the page's relative
    // asset URLs (js/controller.js, ../shared/*.js) must resolve against its
    // real path or the phone gets dead HTML with no script.
    if (pathname === '/') {
      res.writeHead(302, { Location: '/client_mobile/index.html' });
      res.end();
      return;
    }
    let path = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    try {
      const file = await readFile(join(this.staticRoot, path));
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(file);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  }

  onConnection(ws) {
    ws.on('message', raw => {
      const msg = decode(raw);
      if (!msg) return;
      this.onMessage(ws, msg);
    });
    ws.on('close', () => this.onClose(ws));
  }

  onMessage(ws, msg) {
    switch (msg.type) {
      case MSG.HOST_REGISTER:
        if (msg.code === this.roomCode) this.hostWs = ws;
        return;
      case MSG.JOIN: return this.handleJoin(ws, msg);
      case MSG.SET_NAME: {
        // A phone changed its display name mid-session — update it and tell
        // everyone (re-using PLAYER_JOINED so the TV's one handler updates).
        const playerId = ws._playerId;
        const player = playerId && this.players.get(playerId);
        const cleaned = cleanName(msg.name);
        if (!player || !cleaned) return;
        player.name = cleaned;
        this.broadcast(MSG.PLAYER_JOINED, { slot: player.slot, name: cleaned });
        return;
      }
      case MSG.MATCH_PHASE: {
        // The TV reports when play starts and ends. Without this, the
        // pause-on-disconnect machinery would never engage mid-match.
        if (ws !== this.hostWs) return;
        if (msg.phase === 'playing') {
          this.startMatch(msg.snapshot ?? { hostManaged: true });
        } else {
          this.endMatch();
        }
        return;
      }
      case MSG.HAPTIC: {
        // Only the registered TV renderer may drive phone haptics.
        if (ws !== this.hostWs) return;
        if (msg.slot === null || msg.slot === undefined) {
          for (const p of this.players.values()) this.sendHaptic(this.slots[p.slot], msg.pattern);
        } else {
          this.sendHaptic(this.slots[msg.slot], msg.pattern);
        }
        return;
      }
      case MSG.SERVE_CUE: {
        // TV → the serving phone only ('toss' then 'strike' phase).
        if (ws !== this.hostWs) return;
        this.sendToSlot(msg.slot, MSG.SERVE_CUE, { on: msg.on, phase: msg.phase });
        return;
      }
      case MSG.PAUSE_REQUEST: {
        // Any phone may ask to pause/resume — forward to the TV, which owns
        // the sim and decides.
        if (ws === this.hostWs) return;
        if (this.hostWs?.readyState === 1) this.hostWs.send(encode(MSG.PAUSE_REQUEST, {}));
        return;
      }
      case MSG.PAUSE_STATE: {
        // TV announces the pause state to every phone (it already knows it
        // itself, so exclude the host from the echo).
        if (ws !== this.hostWs) return;
        this.broadcast(MSG.PAUSE_STATE, { paused: !!msg.paused }, this.hostWs);
        return;
      }
      case MSG.LAUNCH: {
        // A phone wants to start the match from its "Start Game" panel — forward
        // the chosen config to the TV, which owns the start flow and only honors
        // it while it's actually at the menu.
        if (ws === this.hostWs) return;
        if (this.hostWs?.readyState === 1) this.hostWs.send(encode(MSG.LAUNCH, { config: msg.config ?? {} }));
        return;
      }
      case MSG.END_MATCH: {
        // A phone tapped "End Match" — forward to the TV, which stops the
        // director and returns to the menu (and then reports MATCH_PHASE lobby).
        if (ws === this.hostWs) return;
        if (this.hostWs?.readyState === 1) this.hostWs.send(encode(MSG.END_MATCH, {}));
        return;
      }
      case MSG.LOBBY_STATE: {
        // TV tells phones whether it's at the menu (show the Start Game panel)
        // or in a match (show the gamepad). Cache it so a phone that joins later
        // is told the current state immediately (see handleJoin).
        if (ws !== this.hostWs) return;
        this.atMenu = !!msg.atMenu;
        this.broadcast(MSG.LOBBY_STATE, { atMenu: this.atMenu }, this.hostWs);
        return;
      }
      case MSG.PING: {
        const serverT = this.now();
        ws.send(encode(MSG.PONG, { t: msg.t, serverT }));
        return;
      }
      case MSG.INPUT: {
        const playerId = ws._playerId;
        if (!playerId || this.gameState.phase === 'paused') return;
        this.lag.submit(playerId, msg.seq, msg.t, { move: msg.move, action: msg.action });
        this.emit('input', { playerId, seq: msg.seq });
        // Relay to the TV renderer with the player's slot attached.
        if (this.hostWs?.readyState === 1) {
          this.hostWs.send(encode(MSG.INPUT, {
            slot: this.players.get(playerId)?.slot, seq: msg.seq,
            move: msg.move, action: msg.action,
            aim: msg.aim, power: msg.power, sens: msg.sens, // swipe placement/power + sensitivity
          }));
        }
        return;
      }
    }
  }

  handleJoin(ws, { code, playerId, name }) {
    if (code !== this.roomCode) {
      ws.send(encode(MSG.JOIN_ERROR, { reason: 'bad_code' }));
      return;
    }
    if (!playerId) {
      ws.send(encode(MSG.JOIN_ERROR, { reason: 'missing_player_id' }));
      return;
    }
    const existing = this.players.get(playerId);
    if (existing) {
      // Reconnection path — restore exact slot and resume if everyone is back.
      existing.ws = ws;
      existing.connected = true;
      ws._playerId = playerId;
      // A reconnecting phone may carry an updated name (changed while away).
      const cleaned = cleanName(name);
      if (cleaned) existing.name = cleaned;
      ws.send(encode(MSG.JOINED, {
        slot: existing.slot, roomCode: this.roomCode,
        resumed: true, snapshot: this.gameState.snapshot,
      }));
      ws.send(encode(MSG.LOBBY_STATE, { atMenu: this.atMenu }));
      this.broadcast(MSG.PLAYER_JOINED, { slot: existing.slot, name: existing.name });
      this.gameState.pausedFor = this.gameState.pausedFor.filter(id => id !== playerId);
      this.emit('reconnect', { playerId, slot: existing.slot });
      if (this.gameState.phase === 'paused' && this.gameState.pausedFor.length === 0) {
        this.resumeGame();
      }
      return;
    }
    const slot = this.slots.indexOf(null);
    if (slot === -1) {
      ws.send(encode(MSG.JOIN_ERROR, { reason: 'room_full' }));
      return;
    }
    const displayName = cleanName(name) ?? `Player ${slot + 1}`;
    this.slots[slot] = playerId;
    this.players.set(playerId, { slot, name: displayName, ws, connected: true });
    ws._playerId = playerId;
    ws.send(encode(MSG.JOINED, { slot, roomCode: this.roomCode, resumed: false }));
    ws.send(encode(MSG.LOBBY_STATE, { atMenu: this.atMenu }));
    this.broadcast(MSG.PLAYER_JOINED, { slot, name: displayName }, ws);
    this.emit('join', { playerId, slot });
  }

  onClose(ws) {
    const playerId = ws._playerId;
    if (!playerId) return;
    const player = this.players.get(playerId);
    if (!player || player.ws !== ws) return; // stale socket from a prior connection
    player.connected = false;
    this.emit('disconnect', { playerId, slot: player.slot });
    this.broadcast(MSG.PLAYER_LEFT, { slot: player.slot });
    if (this.gameState.phase === 'playing') this.pauseGame(playerId);
    else if (this.gameState.phase === 'paused') {
      if (!this.gameState.pausedFor.includes(playerId)) this.gameState.pausedFor.push(playerId);
    } else {
      // Lobby: nothing to resume into — free the seat so a different phone
      // can take it instead of the room filling up forever.
      this.releaseSlot(playerId);
    }
  }

  releaseSlot(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.slots[player.slot] = null;
    this.players.delete(playerId);
  }

  pauseGame(forPlayerId) {
    this.gameState.phase = 'paused';
    // Exact mid-point snapshot: deep clone so subsequent mutation can't corrupt it.
    this.gameState.snapshot = structuredClone(this.gameState.match);
    this.gameState.pausedFor.push(forPlayerId);
    this.broadcast(MSG.GAME_PAUSED, { reason: 'player_disconnected', snapshot: this.gameState.snapshot });
    this.emit('pause', { snapshot: this.gameState.snapshot });
  }

  resumeGame() {
    this.gameState.match = structuredClone(this.gameState.snapshot);
    this.gameState.phase = 'playing';
    this.broadcast(MSG.GAME_RESUMED, { snapshot: this.gameState.snapshot });
    this.emit('resume', { snapshot: this.gameState.snapshot });
  }

  startMatch(initialMatchState) {
    this.gameState.match = initialMatchState;
    this.gameState.phase = 'playing';
    this.gameState.pausedFor = [];
  }

  // Back to the lobby between matches: clear pause bookkeeping and purge
  // players who left during play so their seats open up again.
  endMatch() {
    this.gameState.phase = 'lobby';
    this.gameState.match = null;
    this.gameState.snapshot = null;
    this.gameState.pausedFor = [];
    for (const [playerId, player] of [...this.players]) {
      if (!player.connected) this.releaseSlot(playerId);
    }
  }

  sendHaptic(playerId, pattern) {
    const p = this.players.get(playerId);
    if (p?.connected && p.ws.readyState === 1) p.ws.send(encode(MSG.HAPTIC, { pattern }));
  }

  // Send a typed message to whoever currently holds a slot (null-safe).
  sendToSlot(slot, type, payload) {
    const playerId = this.slots[slot];
    const p = playerId && this.players.get(playerId);
    if (p?.connected && p.ws.readyState === 1) p.ws.send(encode(type, payload));
  }

  broadcast(type, payload, exceptWs = null) {
    const data = encode(type, payload);
    for (const p of this.players.values()) {
      if (p.connected && p.ws !== exceptWs && p.ws.readyState === 1) p.ws.send(data);
    }
    if (this.hostWs && this.hostWs.readyState === 1 && this.hostWs !== exceptWs) {
      this.hostWs.send(data);
    }
  }
}

export async function createTennisServer(opts) {
  return new TennisServer(opts).start();
}
