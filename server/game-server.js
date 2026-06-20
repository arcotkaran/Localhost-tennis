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
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary', '.json': 'application/json',
};

// The TV renderer always runs on the host machine (it drives the HDMI TV), so
// it connects over loopback; LAN phones never do. Used to gate host-only auth.
export function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

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
      if (!isLoopback(req.socket.remoteAddress) || !this.staticRoot) {
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
    // Dev-only: the Test Lab POSTs flight-recorder trace entries here (loopback
    // only) so a live testing session can be persisted to logs/ for diagnosis.
    if (req.url === '/api/debug/log' && req.method === 'POST') {
      if (!isLoopback(req.socket.remoteAddress) || !this.staticRoot) {
        res.writeHead(403); res.end(); return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const { appendFile, mkdir } = await import('node:fs/promises');
          await mkdir(join(this.staticRoot, 'logs'), { recursive: true });
          // Body is newline-delimited JSON entries; append verbatim.
          await appendFile(join(this.staticRoot, 'logs', 'lab-session.jsonl'), text.endsWith('\n') ? text : text + '\n');
          res.writeHead(200); res.end('logged');
        } catch {
          res.writeHead(500); res.end();
        }
      });
      return;
    }
    // The TV view fetches the room code + LAN url here. Any device on the Wi-Fi
    // may now be the TV/host (open /host on it), so this is served to the whole
    // LAN — the code is already shown on the TV screen, so there's nothing extra
    // to leak, and a host page needs it to register and display.
    if (req.url === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const lanUrl = this.lanHost ? `http://${this.lanHost}:${this.port}/` : null;
      res.end(JSON.stringify({ roomCode: this.roomCode, port: this.port, lanUrl }));
      return;
    }
    if (!this.staticRoot) { res.writeHead(404); res.end(); return; }
    // Resolve the file from the PATHNAME only — a query/hash (e.g. the TV opened
    // as /client_host/index.html?code=1234) must not become part of the path or
    // readFile fails and the page 404s.
    const pathname = req.url.split(/[?#]/)[0];
    const query = req.url.slice(pathname.length); // '?bot' etc. — forwarded on redirect
    // A stable, memorable URL for the TV/host: open http://<lan-ip>:<port>/host
    // (or /tv) on ANY device on the Wi-Fi and it becomes the TV renderer. We
    // redirect to the real page so its relative asset URLs resolve — preserving
    // the query string (e.g. /host?bot enables the hands-free auto-player).
    if (pathname === '/host' || pathname === '/host/' || pathname === '/tv' || pathname === '/tv/') {
      res.writeHead(302, { Location: '/client_host/index.html' + query });
      res.end();
      return;
    }
    // The Test Lab — a watchable 2D testing console served at a friendly URL.
    if (pathname === '/lab' || pathname === '/lab/') {
      res.writeHead(302, { Location: '/client_host/lab.html' + query });
      res.end();
      return;
    }
    // Redirect instead of serving the controller at '/': the page's relative
    // asset URLs (js/controller.js, ../shared/*.js) must resolve against its
    // real path or the phone gets dead HTML with no script. Preserve the query
    // so the QR's '/?code=1234' carries the room code through to the controller.
    if (pathname === '/') {
      res.writeHead(302, { Location: '/client_mobile/index.html' + query });
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
      case MSG.HOST_REGISTER: {
        // ANY device on the Wi-Fi may claim the TV/host role (open /host on it).
        // No code is required to host; if one IS supplied it must match, which
        // stops a stale tab from a previous server run (different code) from
        // grabbing the role. The latest claim wins so you can move the TV to a
        // new screen at any time — the previous host is told it's been
        // superseded so there are never two TVs driving the sim at once.
        if (msg.code != null && msg.code !== this.roomCode) return;
        if (this.hostWs && this.hostWs !== ws && this.hostWs.readyState === 1) {
          this.hostWs.send(encode(MSG.HOST_SUPERSEDED, {}));
        }
        this.hostWs = ws;
        ws._isHost = true;
        this.emit('host_register', { remote: ws._socket?.remoteAddress ?? null });
        return;
      }
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
      case MSG.TEAM_CHOICE: {
        // A phone picked its 2v2 team + shirt colour — forward to the TV with the
        // player's slot so the host can honour it when it builds the match.
        if (ws === this.hostWs) return;
        const slot = this.players.get(ws._playerId)?.slot;
        if (slot == null) return;
        if (this.hostWs?.readyState === 1) this.hostWs.send(encode(MSG.TEAM_CHOICE, { slot, team: msg.team, color: msg.color }));
        return;
      }
      case MSG.EMOTE: {
        // A phone sent an emote/taunt — forward to the TV (with the slot) to pop
        // a bubble. Harmless chatter; allowed any time except from the host.
        if (ws === this.hostWs) return;
        const slot = this.players.get(ws._playerId)?.slot;
        if (slot == null) return;
        if (this.hostWs?.readyState === 1) this.hostWs.send(encode(MSG.EMOTE, { slot, emote: msg.emote }));
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
        // Buffer the FULL input (swipe placement/power + sensitivity), not just
        // move/action, so a reordered swing keeps its aim and pace.
        this.lag.submit(playerId, msg.seq, msg.t, {
          move: msg.move, action: msg.action,
          aim: msg.aim, power: msg.power, sens: msg.sens,
        });
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
      this.broadcast(MSG.PLAYER_JOINED, { slot: existing.slot, name: existing.name }, ws);
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
    // The TV/host went away — free the role so the next device that opens /host
    // takes over cleanly (a dead socket is skipped by readyState checks anyway,
    // but clearing it lets a fresh claim win without a stale-host comparison).
    if (this.hostWs === ws) {
      this.hostWs = null;
      this.emit('host_left', {});
    }
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
