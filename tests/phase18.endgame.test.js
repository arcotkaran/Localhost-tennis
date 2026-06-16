// Testing Gate 18: end-game / quit to menu.
// A clear way to abandon the current match (from the TV or a phone) and return
// to the menu. We test SessionController.quitToMenu() from every on-screen state
// and the END_MATCH relay (phone → server → host) over real sockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { SessionController } from '../shared/session.js';
import { createTennisServer } from '../server/game-server.js';
import { MSG, encode, decode } from '../shared/protocol.js';

const DT = 1 / 120;
const advance = (s, secs) => { for (let t = 0; t < secs; t += DT) { s.update(DT); s.drainEvents(); } };

// ---------- quitToMenu from each state ----------

test('quitToMenu from a live quick match stops the director and returns to the menu', () => {
  const s = new SessionController({ seed: 1 });
  s.startQuickMatch({ mode: '1v1', surface: 'hard', format: 'short', characters: [] });
  advance(s, 9); // past the entry cinematic → 'match'
  assert.equal(s.state, 'match');
  assert.ok(s.director, 'a match is running');

  s.quitToMenu();
  const events = s.drainEvents();
  assert.equal(s.state, 'menu');
  assert.equal(s.director, null, 'director stopped');
  assert.ok(events.some(e => e.type === 'menu'), 'emits the menu event the TV listens for');
});

test('quitToMenu works during the entry cinematic', () => {
  const s = new SessionController({ seed: 1 });
  s.startQuickMatch({ mode: 'single', surface: 'clay', format: 'short', characters: [] });
  assert.equal(s.state, 'entry');
  s.quitToMenu();
  assert.equal(s.state, 'menu');
  assert.equal(s.director, null);
});

test('quitToMenu abandons a tournament (bracket and cup cleared)', () => {
  const s = new SessionController({ seed: 1 });
  s.startTournament({
    entrants: [{ id: 'a', name: 'A', traits: {} }, { id: 'b', name: 'B', traits: {} }],
    surface: 'hard', format: 'short',
  });
  s.drainEvents();
  assert.equal(s.state, 'bracket');
  s.quitToMenu();
  assert.equal(s.state, 'menu');
  assert.equal(s.cup, null, 'tournament cup is cleared');
  assert.equal(s.activeMatch, null);
});

test('quitToMenu from the trophy celebration returns to the menu', () => {
  const s = new SessionController({ seed: 1 });
  s.state = 'trophy'; // celebration in progress
  s.quitToMenu();
  assert.equal(s.state, 'menu');
});

test('quitToMenu at the menu is a harmless no-op', () => {
  const s = new SessionController({ seed: 1 });
  assert.equal(s.state, 'menu');
  s.quitToMenu();
  assert.equal(s.state, 'menu');
  assert.equal(s.drainEvents().length, 0, 'no spurious menu event at the menu');
});

test('after quitToMenu a fresh match can be started again', () => {
  const s = new SessionController({ seed: 1 });
  s.startQuickMatch({ mode: '1v1', surface: 'hard', format: 'short', characters: [] });
  s.quitToMenu();
  s.drainEvents();
  // Must not throw — the menu state is clean enough to start again.
  s.startQuickMatch({ mode: '1v1', surface: 'grass', format: 'short', characters: [] });
  assert.equal(s.director.surfaceName, 'grass');
});

// ---------- END_MATCH relay (phone → server → host only) ----------

test('a phone END_MATCH reaches the TV and never another phone', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const open = port => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.inbox = []; ws.on('message', r => ws.inbox.push(decode(r))); ws.once('open', () => res(ws)); ws.once('error', rej); });
    const next = (ws, type, ms = 1500) => new Promise((res, rej) => {
      const take = () => { const hit = ws.inbox.find(m => m.type === type); if (!hit) return false; ws.inbox = ws.inbox.filter(m => m !== hit); clearTimeout(t); ws.off('message', p); res(hit); return true; };
      const p = () => take(); const t = setTimeout(() => { ws.off('message', p); rej(new Error('timeout ' + type)); }, ms);
      if (!take()) ws.on('message', p);
    });

    const host = await open(server.port);
    host.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));
    await new Promise(r => setTimeout(r, 40));
    const phoneA = await open(server.port); phoneA.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'a' })); await next(phoneA, MSG.JOINED);
    const phoneB = await open(server.port); phoneB.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'b' })); await next(phoneB, MSG.JOINED);

    let leaked = false;
    phoneB.on('message', raw => { if (decode(raw).type === MSG.END_MATCH) leaked = true; });

    const hostGets = next(host, MSG.END_MATCH);
    phoneA.send(encode(MSG.END_MATCH, {}));
    await hostGets; // reaches the TV

    await new Promise(r => setTimeout(r, 80));
    assert.equal(leaked, false, 'other phones never see END_MATCH');

    for (const ws of [host, phoneA, phoneB]) ws.close();
  } finally {
    await server.stop();
  }
});

test('the server returns to lobby cleanly when the TV reports it after a quit', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const open = port => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.inbox = []; ws.on('message', r => ws.inbox.push(decode(r))); ws.once('open', () => res(ws)); ws.once('error', rej); });
    const host = await open(server.port);
    host.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));
    await new Promise(r => setTimeout(r, 40));
    host.send(encode(MSG.MATCH_PHASE, { phase: 'playing', snapshot: { live: true } }));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(server.gameState.phase, 'playing');

    // TV honored an END_MATCH → reports lobby.
    host.send(encode(MSG.MATCH_PHASE, { phase: 'lobby' }));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(server.gameState.phase, 'lobby', 'server reset to lobby');
    assert.equal(server.gameState.match, null);
    assert.equal(server.gameState.snapshot, null);

    host.close();
  } finally {
    await server.stop();
  }
});
