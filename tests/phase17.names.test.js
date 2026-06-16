// Testing Gate 17: player names.
// Phones type a name (sent on JOIN, changeable via SET_NAME). The server stores
// and re-broadcasts it; the TV turns slot names into team labels. We test the
// name sanitizer, the team-label derivation, and propagation over real sockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createTennisServer } from '../server/game-server.js';
import { MSG, encode, decode, cleanName, MAX_NAME_LEN } from '../shared/protocol.js';
import { teamDisplayNames } from '../shared/session.js';

// ---------- socket helpers (buffered inbox — race-free) ----------
const open = port => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.inbox = [];
  ws.on('message', raw => ws.inbox.push(decode(raw)));
  ws.once('open', () => res(ws)); ws.once('error', rej);
});
const next = (ws, type, ms = 1500) => new Promise((res, rej) => {
  const take = () => {
    const hit = ws.inbox.find(m => m.type === type);
    if (!hit) return false;
    ws.inbox = ws.inbox.filter(m => m !== hit);
    clearTimeout(timer); ws.off('message', probe); res(hit); return true;
  };
  const probe = () => take();
  const timer = setTimeout(() => { ws.off('message', probe); rej(new Error('timeout ' + type)); }, ms);
  if (!take()) ws.on('message', probe);
});

// ---------- name sanitizer ----------

test('cleanName trims, collapses whitespace, and caps the length', () => {
  assert.equal(cleanName('  Karan  '), 'Karan');
  assert.equal(cleanName('Ana   Maria'), 'Ana Maria', 'inner whitespace collapses');
  assert.equal(cleanName('x'.repeat(40)).length, MAX_NAME_LEN, 'capped to MAX_NAME_LEN');
  assert.equal(cleanName('   '), null, 'all-whitespace → null');
  assert.equal(cleanName(''), null);
  assert.equal(cleanName(null), null);
  assert.equal(cleanName(42), null, 'non-string → null');
});

// ---------- team-label derivation ----------

test('teamDisplayNames prefers typed names, then character, then Blue/Red', () => {
  // 1v1: slot 0 typed a name, slot 1 is a character.
  const players = [
    { team: 0, character: null, controlledBySlot: 0 },
    { team: 1, character: { name: 'Roger Federer' }, controlledBySlot: null },
  ];
  assert.deepEqual(teamDisplayNames(players, { 0: 'Karan' }), ['Karan', 'Federer']);

  // No names anywhere → Blue/Red.
  const plain = [{ team: 0, character: null, controlledBySlot: null }, { team: 1, character: null, controlledBySlot: null }];
  assert.deepEqual(teamDisplayNames(plain, {}), ['Blue', 'Red']);
});

test('teamDisplayNames joins doubles partners with " / "', () => {
  const players = [
    { team: 0, character: null, controlledBySlot: 0 },
    { team: 1, character: { name: 'Rafael Nadal' }, controlledBySlot: null },
    { team: 0, character: null, controlledBySlot: 2 },
    { team: 1, character: { name: 'Andy Murray' }, controlledBySlot: null },
  ];
  const [t0, t1] = teamDisplayNames(players, { 0: 'Ana', 2: 'Bo' });
  assert.equal(t0, 'Ana / Bo');
  assert.equal(t1, 'Nadal / Murray');
});

// ---------- propagation over real sockets ----------

test('a JOIN name is stored and broadcast to the TV/other phones', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const watcher = await open(server.port);
    watcher.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'watch' }));
    await next(watcher, MSG.JOINED);

    const phone = await open(server.port);
    const announced = next(watcher, MSG.PLAYER_JOINED);
    phone.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'p1', name: '  Serena  ' }));
    await next(phone, MSG.JOINED);
    const m = await announced;
    assert.equal(m.name, 'Serena', 'cleaned name reaches other clients');
    assert.equal(server.players.get('p1').name, 'Serena', 'server stores the name');

    for (const ws of [watcher, phone]) ws.close();
  } finally {
    await server.stop();
  }
});

test('an empty/missing name falls back to a default, but is still a name', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const phone = await open(server.port);
    phone.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'p1' }));
    await next(phone, MSG.JOINED);
    assert.equal(server.players.get('p1').name, 'Player 1', 'default name for the first seat');
    phone.close();
  } finally {
    await server.stop();
  }
});

test('SET_NAME updates the stored name and re-broadcasts it', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const watcher = await open(server.port);
    watcher.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'watch' }));
    await next(watcher, MSG.JOINED);

    const phone = await open(server.port);
    phone.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'p1', name: 'Old' }));
    await next(phone, MSG.JOINED);
    await next(watcher, MSG.PLAYER_JOINED); // the initial join broadcast

    const changed = next(watcher, MSG.PLAYER_JOINED);
    phone.send(encode(MSG.SET_NAME, { name: 'NewName' }));
    const m = await changed;
    assert.equal(m.name, 'NewName');
    assert.equal(m.slot, server.players.get('p1').slot);
    assert.equal(server.players.get('p1').name, 'NewName');

    for (const ws of [watcher, phone]) ws.close();
  } finally {
    await server.stop();
  }
});

test('a reconnecting phone can carry an updated name', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const phone = await open(server.port);
    phone.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'p1', name: 'First' }));
    await next(phone, MSG.JOINED);
    assert.equal(server.players.get('p1').name, 'First');

    // Reconnect with a new name (e.g. changed in localStorage while away).
    const phone2 = await open(server.port);
    phone2.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'p1', name: 'Second' }));
    const rejoin = await next(phone2, MSG.JOINED);
    assert.equal(rejoin.resumed, true, 'same playerId reconnects to its slot');
    assert.equal(server.players.get('p1').name, 'Second', 'name updated on reconnect');

    for (const ws of [phone, phone2]) ws.close();
  } finally {
    await server.stop();
  }
});

test('SET_NAME from an unknown socket is ignored', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const stranger = await open(server.port); // never joined → no _playerId
    stranger.send(encode(MSG.SET_NAME, { name: 'Ghost' }));
    await new Promise(r => setTimeout(r, 80));
    assert.equal(server.players.size, 0, 'no phantom player created');
    stranger.close();
  } finally {
    await server.stop();
  }
});
