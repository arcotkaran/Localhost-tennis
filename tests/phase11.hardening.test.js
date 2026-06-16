// Testing Gate 11: integration hardening.
// The host↔server match-phase handshake (the piece that makes mid-match
// disconnects actually pause the real product), lobby seat recycling, and
// post-match cleanup — all over real WebSockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createTennisServer, isLoopback } from '../server/game-server.js';
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

test('only a loopback connection can register as the TV host', async () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.0.9'), false);

  const server = await createTennisServer({ port: 0 });
  try {
    // A LAN phone that read the room code off the TV tries to impersonate the host.
    const lanWs = { _socket: { remoteAddress: '192.168.0.9' }, readyState: 1, send() {} };
    server.onMessage(lanWs, { type: MSG.HOST_REGISTER, code: server.roomCode });
    assert.notEqual(server.hostWs, lanWs, 'a remote phone cannot become the host');
    assert.equal(server.hostWs, null);

    // The real TV, on the host machine (loopback), registers fine.
    const tvWs = { _socket: { remoteAddress: '127.0.0.1' }, readyState: 1, send() {} };
    server.onMessage(tvWs, { type: MSG.HOST_REGISTER, code: server.roomCode });
    assert.equal(server.hostWs, tvWs, 'the loopback TV registers');
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
