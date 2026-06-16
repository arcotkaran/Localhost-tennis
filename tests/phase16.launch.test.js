// Testing Gate 16: launch-from-phone.
// A phone can choose mode/surface/format/difficulty and start the match so the
// laptop is never touched. We test the config sanitizer, the host start path it
// drives, and the LAUNCH / LOBBY_STATE relays over real WebSockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createTennisServer } from '../server/game-server.js';
import { MSG, encode, decode, sanitizeLaunchConfig, DIFFICULTIES } from '../shared/protocol.js';
import { SessionController } from '../shared/session.js';

// ---------- socket helpers (buffered inbox — race-free, mirrors phase11) ----------
const open = port => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.inbox = [];
  ws.on('message', raw => ws.inbox.push(decode(raw)));
  ws.once('open', () => res(ws)); ws.once('error', rej);
});
// Resolve with the next inbox message of `type`, consuming it. Because every
// message is buffered from open, nothing is lost between awaits (e.g. a
// LOBBY_STATE sent immediately after JOINED).
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
async function registeredHost(server) {
  const host = await open(server.port);
  host.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));
  await new Promise(r => setTimeout(r, 40));
  return host;
}
async function joinedPhone(server, id = 'p') {
  const phone = await open(server.port);
  phone.send(encode(MSG.JOIN, { code: server.roomCode, playerId: id }));
  await next(phone, MSG.JOINED);
  await next(phone, MSG.LOBBY_STATE); // consume the join-time state so tests start clean
  return phone;
}

// ---------- config sanitizer ----------

test('sanitizeLaunchConfig passes a valid config straight through', () => {
  const cfg = sanitizeLaunchConfig({ mode: '2v2', surface: 'clay', format: 'bestOf3', difficulty: 0.92 });
  assert.deepEqual(cfg, { mode: '2v2', surface: 'clay', format: 'bestOf3', difficulty: 0.92 });
});

test('sanitizeLaunchConfig clamps garbage to safe menu defaults', () => {
  const cfg = sanitizeLaunchConfig({ mode: 'hack', surface: 'lava', format: 'forever', difficulty: 'NaN' });
  assert.deepEqual(cfg, { mode: 'single', surface: 'hard', format: 'short', difficulty: DIFFICULTIES.normal });
  // Out-of-range / missing difficulty falls back too.
  assert.equal(sanitizeLaunchConfig({ difficulty: 5 }).difficulty, DIFFICULTIES.normal);
  assert.equal(sanitizeLaunchConfig({ difficulty: -1 }).difficulty, DIFFICULTIES.normal);
  assert.equal(sanitizeLaunchConfig({}).difficulty, DIFFICULTIES.normal);
  assert.equal(sanitizeLaunchConfig().mode, 'single', 'no-arg call is safe');
});

// ---------- the host start path a phone launch drives ----------

test('a sanitized launch config starts a quick match with the chosen settings', () => {
  const wire = { mode: '1v1', surface: 'grass', format: 'bestOf3', difficulty: 0.92 };
  const cfg = sanitizeLaunchConfig(wire);
  const s = new SessionController({ seed: 1 });
  s.startQuickMatch({ ...cfg, characters: [] });
  assert.equal(s.director.mode, '1v1');
  assert.equal(s.director.surfaceName, 'grass');
  assert.equal(s.director.difficulty, 0.92);
  assert.equal(s.director.score.bestOf, 3, 'bestOf3 format → 3 sets');
  assert.equal(s.director.score.gamesPerSet, 6);
  assert.ok(s.director.players.every(p => p.ai.difficulty === 0.92), 'difficulty threads to every AI');
});

test('the host only honors a launch while it is at the menu', () => {
  const s = new SessionController({ seed: 1 });
  const cfg = sanitizeLaunchConfig({ mode: 'single' });
  s.startQuickMatch({ ...cfg, characters: [] });           // now mid-match (state !== 'menu')
  assert.throws(() => s.startQuickMatch({ ...cfg, characters: [] }),
    /cannot start/, 'a second launch mid-match is rejected');
});

// ---------- LAUNCH relay (phone → server → host only) ----------

test('a phone LAUNCH reaches the TV, carrying the config, and never another phone', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const host = await registeredHost(server);
    const phoneA = await joinedPhone(server, 'a');
    const phoneB = await joinedPhone(server, 'b');

    let leaked = false;
    phoneB.on('message', raw => { if (decode(raw).type === MSG.LAUNCH) leaked = true; });

    const hostGets = next(host, MSG.LAUNCH);
    const config = { mode: '2v2', surface: 'clay', format: 'oneSet', difficulty: 0.5 };
    phoneA.send(encode(MSG.LAUNCH, { config }));
    const m = await hostGets;
    assert.deepEqual(m.config, config, 'the TV receives the exact config the phone chose');

    await new Promise(r => setTimeout(r, 80));
    assert.equal(leaked, false, 'other phones never see a LAUNCH (it is host-only)');

    for (const ws of [host, phoneA, phoneB]) ws.close();
  } finally {
    await server.stop();
  }
});

test('a phone cannot impersonate the TV by sending LAUNCH back to phones', async () => {
  // (LAUNCH only flows phone→host; a phone sending LAUNCH must not be echoed.)
  const server = await createTennisServer({ port: 0 });
  try {
    const phoneA = await joinedPhone(server, 'a');
    const phoneB = await joinedPhone(server, 'b');
    let got = false;
    phoneB.on('message', raw => { if (decode(raw).type === MSG.LAUNCH) got = true; });
    phoneA.send(encode(MSG.LAUNCH, { config: {} }));      // no host registered
    await new Promise(r => setTimeout(r, 100));
    assert.equal(got, false);
    for (const ws of [phoneA, phoneB]) ws.close();
  } finally {
    await server.stop();
  }
});

// ---------- LOBBY_STATE relay (host → server → phones) + caching ----------

test('the TV lobby state reaches phones and is not echoed back to the TV', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const host = await registeredHost(server);
    const phone = await joinedPhone(server, 'p');

    let hostEcho = false;
    host.on('message', raw => { if (decode(raw).type === MSG.LOBBY_STATE) hostEcho = true; });

    const phoneGets = next(phone, MSG.LOBBY_STATE);
    host.send(encode(MSG.LOBBY_STATE, { atMenu: false }));
    const m = await phoneGets;
    assert.equal(m.atMenu, false, 'phone learns the TV left the menu');
    assert.equal(server.atMenu, false, 'server caches the lobby state');

    await new Promise(r => setTimeout(r, 80));
    assert.equal(hostEcho, false, 'the TV is excluded from its own echo');

    for (const ws of [host, phone]) ws.close();
  } finally {
    await server.stop();
  }
});

test('a phone is told the current lobby state the moment it joins', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const host = await registeredHost(server);
    // TV is in a match.
    host.send(encode(MSG.LOBBY_STATE, { atMenu: false }));
    await new Promise(r => setTimeout(r, 40));

    // A phone that joins now must immediately learn it's mid-match (so it shows
    // the gamepad, not the Start Game panel).
    const phone = await open(server.port);
    phone.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'late' }));
    await next(phone, MSG.JOINED);
    const ls = await next(phone, MSG.LOBBY_STATE);
    assert.equal(ls.atMenu, false, 'late joiner is handed the cached lobby state');

    // Default (fresh server, no host signal yet) is "at menu".
    const server2 = await createTennisServer({ port: 0 });
    try {
      const p2 = await open(server2.port);
      p2.send(encode(MSG.JOIN, { code: server2.roomCode, playerId: 'x' }));
      await next(p2, MSG.JOINED);
      const ls2 = await next(p2, MSG.LOBBY_STATE);
      assert.equal(ls2.atMenu, true, 'a fresh room defaults to the menu state');
      p2.close();
    } finally { await server2.stop(); }

    for (const ws of [host, phone]) ws.close();
  } finally {
    await server.stop();
  }
});

test('only the TV can drive the lobby state (a phone cannot)', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const host = await registeredHost(server);
    const phone = await joinedPhone(server, 'p');
    phone.send(encode(MSG.LOBBY_STATE, { atMenu: false }));
    await new Promise(r => setTimeout(r, 80));
    assert.equal(server.atMenu, true, 'a phone cannot change the cached lobby state');
    for (const ws of [host, phone]) ws.close();
  } finally {
    await server.stop();
  }
});
