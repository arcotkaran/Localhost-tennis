// Testing Gate 11: integration hardening.
// The host↔server match-phase handshake (the piece that makes mid-match
// disconnects actually pause the real product), lobby seat recycling, and
// post-match cleanup — all over real WebSockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createTennisServer, TennisServer, isLoopback } from '../server/game-server.js';
import { MSG, encode, decode } from '../shared/protocol.js';

function open(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.inbox = [];
  ws.on('message', raw => ws.inbox.push(decode(raw)));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// Wait for the next inbox message matching any of `types`, consuming it.
// One waiter per expectation — no races, no stale probes.
function nextOfAny(ws, types, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const take = () => {
      const hit = ws.inbox.find(m => types.includes(m.type));
      if (!hit) return false;
      ws.inbox = ws.inbox.filter(m => m !== hit);
      clearTimeout(timer);
      ws.off('message', probe);
      resolve(hit);
      return true;
    };
    const probe = () => take(); // global inbox handler runs first (attached at open)
    const timer = setTimeout(() => { ws.off('message', probe); reject(new Error(`timeout: ${types}`)); }, timeout);
    if (take()) return;
    ws.on('message', probe);
  });
}

const nextOfType = (ws, type, timeout) => nextOfAny(ws, [type], timeout);

async function joinAs(ws, server, playerId) {
  ws.send(encode(MSG.JOIN, { code: server.roomCode, playerId }));
  return nextOfAny(ws, [MSG.JOINED, MSG.JOIN_ERROR]);
}

async function registeredHost(server) {
  const host = await open(server.port);
  host.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));
  await new Promise(r => setTimeout(r, 50));
  return host;
}

test('TV-reported match phase arms the pause machinery end to end', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const host = await registeredHost(server);
    const phoneA = await open(server.port);
    const phoneB = await open(server.port);
    await joinAs(phoneA, server, 'pa');
    await joinAs(phoneB, server, 'pb');

    // Before the TV reports play, a disconnect must NOT pause (lobby churn).
    assert.equal(server.gameState.phase, 'lobby');

    // TV starts the match exactly as the renderer does.
    host.send(encode(MSG.MATCH_PHASE, { phase: 'playing', snapshot: { score: '15-0', rally: 4 } }));
    await new Promise(r => setTimeout(r, 80));
    assert.equal(server.gameState.phase, 'playing', 'server knows play is live');

    // Mid-match drop → everyone (host AND the other phone) gets GAME_PAUSED.
    const hostPaused = nextOfType(host, MSG.GAME_PAUSED);
    const phonePaused = nextOfType(phoneB, MSG.GAME_PAUSED);
    phoneA.terminate();
    const [h, p] = await Promise.all([hostPaused, phonePaused]);
    assert.equal(h.reason, 'player_disconnected');
    assert.deepEqual(h.snapshot, { score: '15-0', rally: 4 }, 'host-provided snapshot is preserved');
    assert.ok(p, 'remaining phone sees the pause overlay');

    // Reconnect → everyone resumes.
    const hostResumed = nextOfType(host, MSG.GAME_RESUMED);
    const phoneC = await open(server.port);
    const rejoin = await joinAs(phoneC, server, 'pa');
    assert.equal(rejoin.resumed, true);
    await hostResumed;
    assert.equal(server.gameState.phase, 'playing');

    for (const ws of [host, phoneB, phoneC]) ws.close();
  } finally {
    await server.stop();
  }
});

test('a benched (non-participant) controller dropping does NOT pause; a participant does (#8)', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const host = await registeredHost(server);
    const pA = await open(server.port);
    const pB = await open(server.port);
    const pC = await open(server.port);
    const jA = await joinAs(pA, server, 'pa');
    const jB = await joinAs(pB, server, 'pb');
    const jC = await joinAs(pC, server, 'pc');

    // 1v1 with three connected: only A and B actually play; C is benched.
    host.send(encode(MSG.MATCH_PHASE, { phase: 'playing', snapshot: { score: '15-0' }, participants: [jA.slot, jB.slot] }));
    await new Promise(r => setTimeout(r, 80));
    assert.equal(server.gameState.phase, 'playing');

    // The benched phone leaves mid-match — the game must keep playing.
    pC.terminate();
    await new Promise(r => setTimeout(r, 120));
    assert.equal(server.gameState.phase, 'playing', 'a non-participant drop does not pause');

    // A real participant leaving DOES still pause.
    const paused = new Promise(r => server.once('pause', r));
    pA.terminate();
    await paused;
    assert.equal(server.gameState.phase, 'paused', 'a participant drop still pauses');

    for (const ws of [host, pB]) ws.close();
  } finally {
    await server.stop();
  }
});

test('only the registered TV can flip the match phase', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const phone = await open(server.port);
    await joinAs(phone, server, 'imp');
    phone.send(encode(MSG.MATCH_PHASE, { phase: 'playing' }));
    await new Promise(r => setTimeout(r, 80));
    assert.equal(server.gameState.phase, 'lobby', 'a phone cannot impersonate the TV');
    phone.close();
  } finally {
    await server.stop();
  }
});

test('lobby seats recycle: a leaver frees their slot for a new phone', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const phones = [];
    for (let i = 0; i < 4; i++) {
      const ws = await open(server.port);
      await joinAs(ws, server, `p${i}`);
      phones.push(ws);
    }
    // Room full — a 5th phone bounces.
    const extra = await open(server.port);
    let reply = await joinAs(extra, server, 'p5');
    assert.equal(reply.reason, 'room_full');

    // Player 2 leaves for good while still in the lobby.
    phones[2].close();
    await new Promise(r => setTimeout(r, 120));

    // The seat is free again — the new phone takes slot 2.
    reply = await joinAs(extra, server, 'p5');
    assert.equal(reply.type, MSG.JOINED, 'freed lobby seat is joinable');
    assert.equal(reply.slot, 2, 'new phone takes the vacated slot');

    for (const ws of [...phones, extra]) ws.close();
  } finally {
    await server.stop();
  }
});

test('mid-match leavers keep their seat (reconnect), but lobby return purges them', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const host = await registeredHost(server);
    const phoneA = await open(server.port);
    const phoneB = await open(server.port);
    await joinAs(phoneA, server, 'pa');
    await joinAs(phoneB, server, 'pb');
    host.send(encode(MSG.MATCH_PHASE, { phase: 'playing' }));
    await new Promise(r => setTimeout(r, 80));

    // Drop mid-match: seat must be HELD for reconnection, not recycled.
    phoneA.terminate();
    await new Promise(r => setTimeout(r, 120));
    const thief = await open(server.port);
    let reply = await joinAs(thief, server, 'thief');
    assert.equal(reply.slot, 2, 'mid-match leaver keeps slot 0; newcomer gets the next free seat');

    // Match ends, TV returns to the menu → the ghost is purged.
    host.send(encode(MSG.MATCH_PHASE, { phase: 'lobby' }));
    await new Promise(r => setTimeout(r, 80));
    assert.equal(server.gameState.phase, 'lobby');
    assert.equal(server.slots[0], null, 'disconnected ghost released on lobby return');
    assert.equal(server.gameState.pausedFor.length, 0, 'pause bookkeeping cleared');

    const fresh = await open(server.port);
    reply = await joinAs(fresh, server, 'fresh');
    assert.equal(reply.slot, 0, 'released seat is joinable again');

    for (const ws of [host, phoneB, thief, fresh]) ws.close();
  } finally {
    await server.stop();
  }
});

test('any LAN device can claim the TV/host role, and the latest claim wins', () => {
  // isLoopback still exists — it now only gates the dev-only debug-frame upload.
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.0.9'), false);

  // Constructor sets roomCode + hostWs=null; no real socket needed for routing.
  const server = new TennisServer({ port: 0 });
  const fakeWs = ip => ({ _socket: { remoteAddress: ip }, readyState: 1, sent: [], send(m) { this.sent.push(decode(m)); } });

  // A device on the LAN opens /host and registers — it becomes the TV.
  const lanA = fakeWs('192.168.0.9');
  server.onMessage(lanA, { type: MSG.HOST_REGISTER, code: server.roomCode });
  assert.equal(server.hostWs, lanA, 'a LAN device can be the host (no loopback requirement)');

  // A second device opens /host → it takes over; the first is told to stand down.
  const lanB = fakeWs('192.168.0.22');
  server.onMessage(lanB, { type: MSG.HOST_REGISTER, code: server.roomCode });
  assert.equal(server.hostWs, lanB, 'the latest claim wins (takeover)');
  assert.ok(lanA.sent.some(m => m.type === MSG.HOST_SUPERSEDED), 'the bumped host is told it was superseded');

  // A stale tab from a previous run (a non-matching code) cannot grab the role.
  const stale = fakeWs('192.168.0.40');
  server.onMessage(stale, { type: MSG.HOST_REGISTER, code: server.roomCode + '9' });
  assert.equal(server.hostWs, lanB, 'a mismatched code is ignored (stale-tab guard)');

  // No code is required to host (the takeover policy) — and that also supersedes.
  const noCode = fakeWs('192.168.0.55');
  server.onMessage(noCode, { type: MSG.HOST_REGISTER });
  assert.equal(server.hostWs, noCode, 'no code needed to claim the TV');
  assert.ok(lanB.sent.some(m => m.type === MSG.HOST_SUPERSEDED), 'the previous host was superseded again');

  // The host disconnecting frees the role for the next device.
  server.onClose(noCode);
  assert.equal(server.hostWs, null, 'host disconnect clears the role');
});

test('the /host and /tv URLs redirect any device to the TV renderer page', async () => {
  const server = await createTennisServer({ port: 0, staticRoot: process.cwd() });
  try {
    for (const path of ['/host', '/tv']) {
      const redir = await fetch(`http://127.0.0.1:${server.port}${path}`, { redirect: 'manual' });
      assert.equal(redir.status, 302, `${path} redirects`);
      assert.equal(redir.headers.get('location'), '/client_host/index.html', `${path} → the host page`);
    }
    // Following it actually serves the real TV HTML (not a 404 / dead page).
    const page = await fetch(`http://127.0.0.1:${server.port}/host`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('<canvas') || html.includes('id="menu"'), 'the TV page is served at /host');
  } finally {
    await server.stop();
  }
});

test('a LAN socket registers as host; a later device supersedes it (real sockets)', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const hostA = await open(server.port);
    hostA.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(server.hostWs?.readyState, 1, 'the first device became the host');

    const bumped = nextOfType(hostA, MSG.HOST_SUPERSEDED);
    const hostB = await open(server.port);
    hostB.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));
    await bumped; // hostA is told it was superseded by hostB
    await new Promise(r => setTimeout(r, 30));

    // The NEW host drives game state (server.atMenu reflects its LOBBY_STATE)…
    hostB.send(encode(MSG.LOBBY_STATE, { atMenu: false }));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(server.atMenu, false, 'the new host can drive game state');

    // …and the bumped host can no longer drive it (it is not hostWs anymore).
    hostA.send(encode(MSG.LOBBY_STATE, { atMenu: true }));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(server.atMenu, false, 'the superseded host is ignored');

    for (const ws of [hostA, hostB]) ws.close();
  } finally {
    await server.stop();
  }
});

test('phase-1 contract still holds: pause machinery intact after refactor', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const phone = await open(server.port);
    await joinAs(phone, server, 'solo');
    server.startMatch({ point: 'mid' });
    assert.equal(server.gameState.phase, 'playing');
    const paused = new Promise(r => server.once('pause', r));
    phone.terminate();
    await paused;
    assert.deepEqual(server.gameState.snapshot, { point: 'mid' });
  } finally {
    await server.stop();
  }
});
