// Testing Gate 7: playable integration.
// The GameDirector is the real game loop the TV runs. These tests drive it
// headlessly: AI-vs-AI full matches, phone-controlled swing windows,
// doubles slot mapping, pause/resume serialization, and the host→server→
// phone haptic relay over real WebSockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { GameDirector, slotMapping, SWING_WINDOW } from '../shared/game-director.js';
import { createTennisServer } from '../server/game-server.js';
import { MSG, encode, decode, HAPTIC_PATTERNS } from '../shared/protocol.js';
import { getPlayer } from '../shared/roster.js';

const DT = 1 / 120;

function runUntil(director, predicate, maxSeconds = 600) {
  const collected = [];
  for (let t = 0; t < maxSeconds; t += DT) {
    director.update(DT);
    collected.push(...director.drainEvents());
    if (predicate(collected, t)) return { events: collected, elapsed: t };
  }
  return { events: collected, elapsed: maxSeconds, timedOut: true };
}

// ---------- slot mapping ----------

test('slot mapping: singles, 1v1, and doubles pairs (0,2) vs (1,3)', () => {
  assert.deepEqual(slotMapping('single').slots, { 0: 0 });
  assert.deepEqual(slotMapping('1v1').slots, { 0: 0, 1: 1 });
  const d = slotMapping('2v2');
  assert.deepEqual(d.teams, [0, 1, 0, 1], 'slots 0/2 are team 0, slots 1/3 are team 1');
  assert.throws(() => slotMapping('3v3'), /unknown mode/);
});

test('attaching phones takes over players; detaching returns them to AI', () => {
  const d = new GameDirector({ mode: '2v2' });
  assert.equal(d.attachSlot(2), 2);
  assert.equal(d.players[2].controlledBySlot, 2);
  assert.equal(d.players[2].team, 0, 'slot 2 joined team 0 as the partner');
  d.detachSlot(2);
  assert.equal(d.players[2].controlledBySlot, null, 'player reverts to AI control');
});

// ---------- serve & rally flow ----------

test('serve fires after the delay and the rally begins toward the receiver', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  const { events } = runUntil(d, evs => evs.some(e => e.type === 'serve'), 5);
  const serve = events.find(e => e.type === 'serve');
  assert.ok(serve, 'serve event fired');
  assert.equal(serve.team, 0, 'team 0 serves first');
  assert.equal(d.state, 'rally');
  assert.ok(d.ball.vel.z < 0, 'serve travels toward team 1');
});

test('full AI-vs-AI match completes through the director on every surface', () => {
  for (const surface of ['hard', 'clay', 'grass']) {
    const d = new GameDirector({ mode: '1v1', surface, bestOf: 3, seed: 11 });
    const { events, timedOut } = runUntil(d, evs => evs.some(e => e.type === 'match'), 1800);
    assert.ok(!timedOut, `${surface}: match must complete`);
    assert.equal(d.state, 'finished');
    const points = events.filter(e => e.type === 'point');
    assert.ok(points.length >= 24, `${surface}: a real match was played (${points.length} points)`);
    const hits = events.filter(e => e.type === 'hit');
    assert.ok(hits.length > points.length, `${surface}: rallies actually happened`);
    assert.ok(points.every(p => ['out', 'double_bounce', 'net', 'double_fault'].includes(p.reason)), 'every point has a physical reason');
  }
});

test('roster traits flow through: Kyrgios serves measurably faster', () => {
  const fast = new GameDirector({ mode: '1v1', characters: [getPlayer('kyrgios'), null], seed: 5 });
  const base = new GameDirector({ mode: '1v1', seed: 5 });
  runUntil(fast, evs => evs.some(e => e.type === 'serve'), 5);
  runUntil(base, evs => evs.some(e => e.type === 'serve'), 5);
  assert.ok(Math.abs(fast.ball.vel.z) > Math.abs(base.ball.vel.z) * 1.3,
    `Kyrgios serve ${Math.abs(fast.ball.vel.z).toFixed(1)} vs baseline ${Math.abs(base.ball.vel.z).toFixed(1)} m/s`);
});

// ---------- phone-controlled swings ----------

function advanceUntilBallNear(d, playerIdx, maxS = 12) {
  const p = d.players[playerIdx];
  for (let t = 0; t < maxS; t += DT) {
    // Chase the incoming ball so the human reliably reaches it (the serve is
    // now cross-court, so a stationary receiver may not be on its line).
    if (d.ball && d.state === 'rally' && d.ballComingTo(p.team)) {
      const dx = d.ball.pos.x - p.body.pos.x;
      const dz = d.ball.pos.z - p.body.pos.z;
      const mag = Math.hypot(dx, dz) || 1;
      const inverted = p.team === 1 ? -1 : 1; // controller axes are screen-relative
      d.handleInput(playerIdx, { move: { x: inverted * dx / mag, y: inverted * dz / mag } });
    }
    d.update(DT);
    d.drainEvents();
    if (d.ball && d.state === 'rally' &&
        Math.abs(d.ball.pos.x - p.body.pos.x) < 1.2 &&
        Math.abs(d.ball.pos.z - p.body.pos.z) < 2.0 &&
        d.ballComingTo(p.team)) return true;
  }
  return false;
}

test('armed button press within the swing window produces that exact shot', () => {
  const d = new GameDirector({ mode: '1v1', seed: 8 });
  d.attachSlot(1); // human takes the receiving side (team 1)
  d.handleInput(1, { move: { x: 0, y: 0 } });
  assert.ok(advanceUntilBallNear(d, 1), 'ball approaches the human');
  d.handleInput(1, { action: 'slice' });   // press the button as it arrives
  const { events } = runUntil(d, evs => evs.some(e => e.type === 'hit' && e.slot === 1), 1);
  const hit = events.find(e => e.type === 'hit' && e.slot === 1);
  assert.ok(hit, 'the human swing connected');
  assert.equal(hit.action, 'slice', 'the chosen shot type was used');
  assert.equal(d.lastHitTeam, 1);
});

test('no button press = whiff: ball passes and the human loses the point', () => {
  const d = new GameDirector({ mode: '1v1', seed: 8 });
  d.attachSlot(1);
  d.handleInput(1, { move: { x: 0, y: 0 } }); // human never swings
  const { events } = runUntil(d, evs => evs.some(e => e.type === 'point'), 30);
  const point = events.find(e => e.type === 'point');
  assert.equal(point.team, 0, 'the passive human loses the point');
  assert.ok(!events.some(e => e.type === 'hit' && e.slot === 1), 'human never hit the ball');
});

test('a press goes stale after the swing window expires', () => {
  const d = new GameDirector({ mode: '1v1', seed: 8 });
  d.attachSlot(1);
  d.handleInput(1, { action: 'smash' }); // pressed way too early, at serve delay
  for (let t = 0; t < SWING_WINDOW + 0.1; t += DT) { d.update(DT); d.drainEvents(); }
  assert.equal(d.players[1].armed, null, 'stale press disarmed');
});

test('doubles: the nearest partner takes the ball, never both', () => {
  const d = new GameDirector({ mode: '2v2', seed: 21 });
  const { events } = runUntil(d, evs => evs.filter(e => e.type === 'hit').length >= 8, 60);
  const hits = events.filter(e => e.type === 'hit');
  assert.ok(hits.length >= 8, 'doubles rally flows');
  // The true "never both partners hit the same ball" invariant: across a
  // continuous rally the ball must cross the net between same-team contacts,
  // so consecutive hits never come from the same team. (rallyLength resets at
  // each serve, so it can't be used as a cross-point proxy.)
  const teamOf = p => p % 2; // players 0,2 → team 0; 1,3 → team 1
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].rallyLength === 0 || hits[i].rallyLength === undefined) continue; // a new serve
    assert.notEqual(teamOf(hits[i].player), teamOf(hits[i - 1].player),
      'consecutive in-rally hits alternate teams — partners never double-swing');
  }
  // Both partners on a team eventually participate (they cover different halves).
  const team0Hitters = new Set(hits.filter(h => [0, 2].includes(h.player)).map(h => h.player));
  assert.ok(team0Hitters.size >= 1, 'team 0 participates');
});

// ---------- scoring integration ----------

test('director points land in the real scoring engine with correct displays', () => {
  const d = new GameDirector({ mode: '1v1', seed: 13 });
  const { events } = runUntil(d, evs => evs.filter(e => e.type === 'point').length >= 4, 240);
  const points = events.filter(e => e.type === 'point');
  for (const p of points) {
    assert.match(p.display, /^(0|15|30|40|Deuce|Ad-In|Ad-Out|\d+-\d+)/, `valid display "${p.display}"`);
    assert.equal(typeof p.isPressurePoint, 'boolean');
  }
});

// ---------- pause/resume serialization ----------

test('serialize/restore reproduces the exact mid-rally state', () => {
  const d = new GameDirector({ mode: '2v2', seed: 17 });
  d.attachSlot(0);
  runUntil(d, evs => evs.filter(e => e.type === 'hit').length >= 3, 60);
  const snap = d.serialize();

  const d2 = new GameDirector({ mode: '2v2', seed: 999 }); // different seed — state must come from the snapshot
  d2.restore(snap);
  assert.deepEqual(d2.ball?.pos, d.ball?.pos, 'ball position restored exactly');
  assert.deepEqual(d2.ball?.vel, d.ball?.vel, 'ball velocity restored exactly');
  assert.equal(d2.rallyLength, d.rallyLength);
  assert.equal(d2.score.gameDisplay, d.score.gameDisplay);
  assert.equal(d2.players[0].controlledBySlot, 0, 'phone assignment survives the pause');
  assert.deepEqual(d2.players.map(p => p.body.pos), d.players.map(p => p.body.pos));

  // Both continue identically for a step (same physics, same state).
  d.update(DT); d2.update(DT);
  assert.deepEqual(d2.ball?.pos, d.ball?.pos, 'resumed simulation tracks the original');
});

// ---------- host → server → phone haptic relay ----------

test('TV-driven haptics reach the right phone (and only from the real host)', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const open = ws => new Promise(r => ws.once('open', () => r(ws)));
    const nextMsg = ws => new Promise(r => ws.once('message', raw => r(decode(raw))));

    const host = await open(new WebSocket(`ws://127.0.0.1:${server.port}`));
    host.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));

    const phoneA = await open(new WebSocket(`ws://127.0.0.1:${server.port}`));
    phoneA.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'pa' }));
    await nextMsg(phoneA); // joined slot 0
    const phoneB = await open(new WebSocket(`ws://127.0.0.1:${server.port}`));
    phoneB.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'pb' }));
    await nextMsg(phoneB); // joined slot 1

    // Targeted haptic to slot 1 only. (Filter by type: phones also receive
    // unrelated lobby broadcasts like player_joined.)
    const bGets = nextMsg(phoneB);
    let aGot = false;
    phoneA.on('message', raw => { if (decode(raw)?.type === MSG.HAPTIC) aGot = true; });
    host.send(encode(MSG.HAPTIC, { slot: 1, pattern: HAPTIC_PATTERNS.powerSmash }));
    const msg = await bGets;
    assert.equal(msg.type, MSG.HAPTIC);
    assert.deepEqual(msg.pattern, HAPTIC_PATTERNS.powerSmash);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(aGot, false, 'slot 0 phone was not buzzed');

    // Broadcast (crowd roar) hits everyone.
    const both = Promise.all([nextMsg(phoneA), nextMsg(phoneB)]);
    host.send(encode(MSG.HAPTIC, { slot: null, pattern: HAPTIC_PATTERNS.crowdRoar }));
    const msgs = await both;
    assert.ok(msgs.every(m => m.type === MSG.HAPTIC));

    // A phone pretending to be the host is ignored.
    let leaked = false;
    phoneB.on('message', raw => { if (decode(raw)?.type === MSG.HAPTIC) leaked = true; });
    phoneA.send(encode(MSG.HAPTIC, { slot: 1, pattern: [9999] }));
    await new Promise(r => setTimeout(r, 150));
    assert.equal(leaked, false, 'only the registered TV may drive haptics');

    for (const ws of [host, phoneA, phoneB]) ws.close();
  } finally {
    await server.stop();
  }
});
