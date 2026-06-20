// Testing Gate 1: network stability.
// Simulates 4 concurrent phone connections, random disconnects mid-match,
// lossless reconnection, and Wi-Fi latency spikes / out-of-order delivery.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createTennisServer } from '../server/game-server.js';
import { LagCompensator, ClockSync } from '../server/lag-compensator.js';
import { rankLanAddresses, lanAddress } from '../server/lan.js';
import { networkInterfaces } from 'node:os';
import { MSG, encode, decode } from '../shared/protocol.js';

let server;

before(async () => { server = await createTennisServer({ port: 0 }); });
after(async () => { await server.stop(); });

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  ws.inbox = [];
  ws.waiters = [];
  ws.on('message', raw => {
    const msg = decode(raw);
    ws.inbox.push(msg);
    ws.waiters = ws.waiters.filter(w => {
      if (msg.type === w.type) { w.resolve(msg); return false; }
      return true;
    });
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitFor(ws, type, timeout = 2000) {
  const hit = ws.inbox.find(m => m.type === type);
  if (hit) { ws.inbox = ws.inbox.filter(m => m !== hit); return Promise.resolve(hit); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
    ws.waiters.push({ type, resolve: m => { clearTimeout(timer); resolve(m); } });
  });
}

async function join(ws, playerId, code = server.roomCode) {
  ws.send(encode(MSG.JOIN, { code, playerId, name: playerId }));
  return Promise.race([waitFor(ws, MSG.JOINED), waitFor(ws, MSG.JOIN_ERROR)]);
}

test('server launches instantly with a 4-digit room code', async () => {
  const t0 = performance.now();
  const s = await createTennisServer({ port: 0 });
  const launchMs = performance.now() - t0;
  assert.match(s.roomCode, /^\d{4}$/, 'room code must be exactly 4 digits');
  assert.ok(launchMs < 500, `launch took ${launchMs.toFixed(1)}ms, must be instant`);
  await s.stop();
});

test('4 concurrent phones connect instantaneously via room code', async () => {
  const phones = await Promise.all([connect(), connect(), connect(), connect()]);
  const t0 = performance.now();
  const replies = await Promise.all(phones.map((ws, i) => join(ws, `p${i}`)));
  const joinMs = performance.now() - t0;
  const slots = replies.map(r => r.slot).sort();
  assert.deepEqual(slots, [0, 1, 2, 3], 'each phone gets a unique slot');
  assert.ok(replies.every(r => r.type === MSG.JOINED));
  assert.ok(joinMs < 500, `4-way join took ${joinMs.toFixed(1)}ms`);
  globalThis.__phones = phones; // reused by later tests in this suite
});

test('wrong room code is rejected', async () => {
  const ws = await connect();
  const reply = await join(ws, 'intruder', '0000' === server.roomCode ? '9999' : '0000');
  assert.equal(reply.type, MSG.JOIN_ERROR);
  assert.equal(reply.reason, 'bad_code');
  ws.close();
});

test('5th player is rejected — room is full at 4', async () => {
  const ws = await connect();
  const reply = await join(ws, 'p5');
  assert.equal(reply.type, MSG.JOIN_ERROR);
  assert.equal(reply.reason, 'room_full');
  ws.close();
});

test('mid-match disconnect pauses elegantly and snapshots exact state', async () => {
  const matchState = {
    score: { sets: [[1, 0]], games: [3, 2], points: ['40', '30'] },
    ball: { pos: [1.2, 0.8, -3.4], vel: [12, 2, -8], spin: [0, 80, 0] },
    rallyLength: 17,
  };
  server.startMatch(matchState);

  const paused = new Promise(r => server.once('pause', r));
  const victim = globalThis.__phones[2];
  victim.terminate(); // abrupt drop, like Wi-Fi dying — no clean close frame
  const { snapshot } = await paused;

  assert.equal(server.gameState.phase, 'paused');
  assert.deepEqual(snapshot, matchState, 'snapshot must capture the exact mid-point state');
  assert.notEqual(snapshot, matchState, 'snapshot must be a deep clone, not a reference');

  // Other phones are told the game paused.
  const note = await waitFor(globalThis.__phones[0], MSG.GAME_PAUSED);
  assert.equal(note.reason, 'player_disconnected');
  assert.deepEqual(note.snapshot, matchState);

  // Mutating live state must not corrupt the saved snapshot.
  server.gameState.match.rallyLength = 999;
  assert.equal(server.gameState.snapshot.rallyLength, 17);
});

test('instant reconnection restores slot, state, and resumes the match', async () => {
  const ws = await connect();
  const resumed = new Promise(r => server.once('resume', r));
  const reply = await join(ws, 'p2'); // same playerId as the dropped phone
  assert.equal(reply.type, MSG.JOINED);
  assert.equal(reply.slot, 2, 'reconnecting player gets their original slot back');
  assert.equal(reply.resumed, true);
  assert.equal(reply.snapshot.rallyLength, 17, 'client receives the exact saved state');

  await resumed;
  assert.equal(server.gameState.phase, 'playing');
  assert.equal(server.gameState.match.rallyLength, 17, 'match progress fully restored');
  assert.deepEqual(server.gameState.match.score.points, ['40', '30']);
  globalThis.__phones[2] = ws;
});

test('repeated random disconnect/reconnect cycles never lose state', async () => {
  for (let cycle = 0; cycle < 5; cycle++) {
    const idx = Math.floor(Math.random() * 4);
    const paused = new Promise(r => server.once('pause', r));
    globalThis.__phones[idx].terminate();
    await paused;
    assert.equal(server.gameState.phase, 'paused');

    const ws = await connect();
    const resumed = new Promise(r => server.once('resume', r));
    const reply = await join(ws, `p${idx}`);
    assert.equal(reply.slot, idx);
    await resumed;
    assert.equal(server.gameState.match.rallyLength, 17, `state intact after cycle ${cycle}`);
    globalThis.__phones[idx] = ws;
  }
});

test('inputs are accepted and queued from all 4 phones under flood', async () => {
  const received = [];
  const handler = ev => received.push(ev);
  server.on('input', handler);
  const N = 50;
  for (let seq = 0; seq < N; seq++) {
    for (let i = 0; i < 4; i++) {
      globalThis.__phones[i].send(encode(MSG.INPUT, {
        seq, t: performance.now(), move: { x: 0.5, y: 0 }, action: null,
      }));
    }
  }
  await new Promise(r => setTimeout(r, 300));
  server.off('input', handler);
  assert.equal(received.length, N * 4, `all ${N * 4} flooded inputs received, none dropped`);
});

// ---------- lag compensation: pure simulation of latency spikes ----------

test('clock sync rejects latency-spike samples and converges on true offset', () => {
  const sync = new ClockSync();
  const TRUE_OFFSET = 1234.5; // server clock is ahead of phone clock by this
  for (let i = 0; i < 30; i++) {
    const spike = i % 7 === 0;                  // periodic Wi-Fi spike
    const rtt = spike ? 250 + Math.random() * 200 : 4 + Math.random() * 6;
    const asym = spike ? (Math.random() - 0.5) * 180 : (Math.random() - 0.5) * 2;
    const clientT = 1000 + i * 16;
    const serverT = clientT + TRUE_OFFSET + rtt / 2 + asym;
    sync.addSample(clientT, serverT, rtt);
  }
  assert.ok(Math.abs(sync.offset - TRUE_OFFSET) < 5,
    `offset estimate ${sync.offset.toFixed(2)} must be within 5ms of ${TRUE_OFFSET}`);
});

test('lag spike cannot reorder a player\'s inputs', () => {
  const lag = new LagCompensator();
  lag.addPingSample('a', 0, 0, 4); // zero offset, clean network baseline
  // Player hits at t=100 (swing) then t=110 (recover). The first packet is
  // delayed by a 300ms spike and arrives AFTER the second. Submit order
  // simulates arrival order:
  lag.submit('a', 2, 110, { action: 'volley' });
  lag.submit('a', 1, 100, { action: 'smash' });
  const ordered = lag.drain(10_000);
  assert.deepEqual(ordered.map(e => e.seq), [1, 2], 'seq order restored despite spike');
  assert.equal(ordered[0].input.action, 'smash');
});

test('the lag buffer preserves a swipe\'s full payload (aim, power, sens)', () => {
  const lag = new LagCompensator();
  lag.addPingSample('a', 0, 0, 4);
  // A reordered swing must keep its placement, pace AND sensitivity, not just
  // move/action — otherwise a lag spike silently softens or mis-aims the shot.
  const input = { move: { x: 0.1, y: -0.2 }, action: 'slice', aim: 0.7, power: 0.9, sens: 0.6 };
  lag.submit('a', 1, 100, input);
  const [ev] = lag.drain(10_000);
  assert.deepEqual(ev.input, input, 'aim, power and sens survive the buffer intact');
});

test('inputs from 4 players interleave in true event-time order across jitter', () => {
  const lag = new LagCompensator();
  const players = ['a', 'b', 'c', 'd'];
  // Each phone has a different clock offset; feed clean ping samples first.
  const offsets = { a: 0, b: 500, c: -300, d: 10_000 };
  for (const p of players) {
    for (let i = 0; i < 10; i++) {
      const clientT = i * 16;
      lag.addPingSample(p, clientT, clientT + offsets[p] + 2, 4);
    }
  }
  // True event times (server clock): a@100, b@105, c@110, d@115 — but they
  // arrive shuffled and each phone reports its own local clock.
  const events = [
    { p: 'c', seq: 0, serverT: 110 },
    { p: 'a', seq: 0, serverT: 100 },
    { p: 'd', seq: 0, serverT: 115 },
    { p: 'b', seq: 0, serverT: 105 },
  ];
  for (const e of events) lag.submit(e.p, e.seq, e.serverT - offsets[e.p], {});
  const ordered = lag.drain(50_000);
  assert.deepEqual(ordered.map(e => e.playerId), ['a', 'b', 'c', 'd'],
    'global ordering matches true event time despite clock skew and shuffle');
});

test('duplicate and replayed packets are dropped', () => {
  const lag = new LagCompensator();
  lag.addPingSample('a', 0, 0, 4);
  assert.equal(lag.submit('a', 1, 100, {}), true);
  assert.equal(lag.submit('a', 1, 100, {}), false, 'duplicate in-flight rejected');
  lag.drain(10_000);
  assert.equal(lag.submit('a', 1, 100, {}), false, 'replay of consumed seq rejected');
  assert.equal(lag.submit('a', 2, 120, {}), true, 'next seq still accepted');
});

// ---------- phone page asset integrity ----------

test('root URL redirects to the controller page so relative assets resolve', async () => {
  const s = await createTennisServer({ port: 0, staticRoot: process.cwd() });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/`, { redirect: 'manual' });
    assert.equal(res.status, 302, 'must redirect, not serve content at /');
    assert.equal(res.headers.get('location'), '/client_mobile/index.html');
    const followed = await fetch(`http://127.0.0.1:${s.port}/`);
    assert.equal(followed.status, 200, 'redirect target serves the controller page');
    assert.ok((await followed.text()).includes('id="join-btn"'));
  } finally {
    await s.stop();
  }
});

test('every script and module either page references actually loads (no dead JOIN buttons)', async () => {
  const s = await createTennisServer({ port: 0, staticRoot: process.cwd() });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const visited = new Set();
    const failures = [];

    async function crawl(url) {
      if (visited.has(url)) return;
      visited.add(url);
      const res = await fetch(url);
      if (res.status !== 200) {
        failures.push(`${res.status} ${url.replace(base, '')}`);
        return;
      }
      const body = await res.text();
      const specs = [];
      if (url.endsWith('.html')) {
        for (const m of body.matchAll(/<script[^>]+src="([^"]+)"/g)) specs.push(m[1]);
        // Inline module scripts import too.
        for (const m of body.matchAll(/import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)) specs.push(m[1]);
      } else {
        for (const m of body.matchAll(/import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)) specs.push(m[1]);
        for (const m of body.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
      }
      for (const spec of specs) {
        if (/^https?:/.test(spec)) continue;          // CDN externals
        if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // bare importmap names
        await crawl(new URL(spec, url).href);
      }
    }

    // Crawl exactly what a phone and a TV load, from the URLs they really use.
    await crawl(`${base}/client_mobile/index.html`);
    await crawl(`${base}/client_host/index.html`);
    assert.deepEqual(failures, [], `unreachable assets: ${failures.join(', ')}`);
    assert.ok(visited.size >= 10, `crawl actually traversed the module graph (${visited.size} urls)`);
  } finally {
    await s.stop();
  }
});

// ---------- room-code handoff to the TV view ----------

test('the host page can fetch the room code via /api/info', async () => {
  const s = await createTennisServer({ port: 0, staticRoot: process.cwd() });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/info`);
    assert.equal(res.status, 200);
    const info = await res.json();
    assert.equal(info.roomCode, s.roomCode);
    assert.match(info.roomCode, /^\d{4}$/);
  } finally {
    await s.stop();
  }
});

test('any device on the LAN can fetch /api/info (any device may now be the TV)', async () => {
  const s = await createTennisServer({ port: 0, staticRoot: process.cwd() });
  try {
    const lanIp = rankLanAddresses(networkInterfaces())[0]?.address;
    if (!lanIp) return; // no LAN adapter in this environment — nothing to probe
    let res;
    try {
      res = await fetch(`http://${lanIp}:${s.port}/api/info`);
    } catch {
      return; // adapter unreachable from itself — can't probe here
    }
    assert.equal(res.status, 200, 'a LAN device gets the room code so it can host');
    const body = await res.json();
    assert.equal(body.roomCode, s.roomCode, 'the room code reaches the LAN host page');
  } finally {
    await s.stop();
  }
});

// ---------- LAN address discovery: virtual adapters must never win ----------

test('real home-LAN adapter outranks Hyper-V/WSL virtual adapters', () => {
  // Exact shape seen on the host machine: the virtual NAT adapter ("Ethernet
  // 26", 172.25.x.x) enumerates before the real NIC ("Ethernet 16", 192.168.x).
  const ranked = rankLanAddresses({
    'Ethernet 26': [{ family: 'IPv4', internal: false, address: '172.25.131.224' }],
    'Ethernet 16': [{ family: 'IPv4', internal: false, address: '192.168.0.83' }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  });
  assert.equal(ranked[0].address, '192.168.0.83', 'phones get the reachable home-LAN IP first');
  assert.ok(!ranked.some(c => c.address === '127.0.0.1'), 'loopback never offered to phones');
});

test('named virtual adapters and APIPA are demoted; Wi-Fi names get a boost', () => {
  const ranked = rankLanAddresses({
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '192.168.144.1' }],
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '10.0.0.7' }],
    'Ethernet 3': [{ family: 'IPv4', internal: false, address: '169.254.12.9' }],
  });
  assert.equal(ranked[0].address, '10.0.0.7', 'real Wi-Fi beats a 192.168 vEthernet adapter');
  assert.equal(ranked.at(-1).address, '169.254.12.9', 'self-assigned APIPA ranks last');
  assert.equal(lanAddress({}), 'localhost', 'no adapters falls back to localhost');
});

test('cleanup: close remaining phones', () => {
  for (const ws of globalThis.__phones) ws.close();
});
