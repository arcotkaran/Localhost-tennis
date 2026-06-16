// Testing Gate 15: real-match mechanics.
// Net collisions cost the point, the serve is taken from the baseline corner
// with swipe power/placement, team-1 human controls are un-inverted to match
// their camera, and pause relays correctly over real WebSockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { GameDirector, SERVE_DELAY } from '../shared/game-director.js';
import { Ball, COURT, BALL } from '../shared/physics.js';
import { createTennisServer } from '../server/game-server.js';
import { MSG, encode, decode } from '../shared/protocol.js';

const DT = 1 / 120;
const step = (d, s) => { const e = []; for (let t = 0; t < s; t += DT) { d.update(DT); e.push(...d.drainEvents()); } return e; };

// ---------- net collision ----------

test('a ball that does not clear the net costs the hitter the point', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1 });
  d.state = 'rally';
  d.lastHitTeam = 0; // team 0 just hit
  // A weak shot from team 0's side aimed at the net, too low to clear.
  d.ball = new Ball({ pos: { x: 0, y: 0.5, z: 3 }, vel: { x: 0, y: 0.5, z: -8 }, spin: { x: 0, y: 0, z: 0 } });
  const events = step(d, 2.0);
  const point = events.find(e => e.type === 'point');
  assert.ok(point, 'the point ended');
  assert.equal(point.reason, 'net', 'ended because the ball hit the net');
  assert.equal(point.team, 1, 'the team that dumped it in the net loses');
  assert.ok(events.some(e => e.type === 'net'), 'a net event fired for the renderer');
});

test('a shot that clears the cord is NOT a net point', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1 });
  d.state = 'rally';
  d.lastHitTeam = 0;
  // A healthy arcing shot that clears the net comfortably.
  d.ball = new Ball({ pos: { x: 0, y: 1.0, z: 8 }, vel: { x: 0, y: 6, z: -22 }, spin: { x: 0, y: 0, z: 0 } });
  const events = step(d, 0.6);
  assert.ok(!events.some(e => e.type === 'net'), 'cleared the net — no net event');
});

test('over a full match, net is a minority of point endings (shots clear normally)', () => {
  const d = new GameDirector({ mode: '1v1', surface: 'hard', bestOf: 3, seed: 11 });
  const reasons = {};
  let t = 0;
  for (; t < 1500 && d.state !== 'finished'; t += DT) {
    d.update(DT);
    for (const e of d.drainEvents()) if (e.type === 'point') reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  }
  assert.equal(d.state, 'finished', 'match completed');
  const total = Object.values(reasons).reduce((a, b) => a + b, 0);
  assert.ok((reasons.net || 0) < total * 0.45, `net endings ${reasons.net}/${total} should be a minority`);
  assert.ok((reasons.out || 0) + (reasons.double_bounce || 0) > 0, 'points also end on out / unreturned');
});

// ---------- slice is an in-court drop shot, not a sailing error ----------

test('human slice lands IN the court from anywhere (the out-of-court bug)', () => {
  for (const z of [10, 6, 3]) {
    const d = new GameDirector({ mode: '1v1', seed: 1 });
    d.attachSlot(0);
    const p = d.players[0];
    p.body.pos = { x: 0, z };
    d.ball = new Ball({ pos: { x: 0, y: 0.9, z }, vel: { x: 0, y: 0, z: 6 } });
    d.hit(p, 'slice', 0, 1.0); // max swipe power — must still land in
    let landing = null;
    for (let i = 0; i < 2500; i++) { if (d.ball.step(1 / 240, d.surface) === 'bounce') { landing = { ...d.ball.pos }; break; } }
    assert.ok(landing, 'slice landed somewhere');
    assert.ok(Math.abs(landing.z) <= COURT.length / 2, `slice from z=${z} stays inside the baseline (landed ${landing.z.toFixed(1)})`);
    assert.ok(Math.abs(landing.x) <= COURT.width / 2, 'slice stays inside the sidelines');
    assert.ok(Math.sign(landing.z) !== Math.sign(z), 'slice crossed to the opponent side (cleared the net)');
  }
});

test('all human shots are kept in the court at full power', () => {
  for (const action of ['flat', 'topspin', 'lob', 'slice']) {
    const d = new GameDirector({ mode: '1v1', seed: 2 });
    d.attachSlot(0);
    const p = d.players[0];
    p.body.pos = { x: 0, z: 9 };
    d.ball = new Ball({ pos: { x: 0, y: 1.0, z: 9 }, vel: { x: 0, y: 0, z: 6 } });
    d.hit(p, action, 0, 1.0);
    let landing = null;
    for (let i = 0; i < 3000; i++) { if (d.ball.step(1 / 240, d.surface) === 'bounce') { landing = { ...d.ball.pos }; break; } }
    assert.ok(landing && Math.abs(landing.z) <= COURT.length / 2 + 0.1, `${action} kept in (landed ${landing?.z.toFixed(1)})`);
  }
});

// ---------- serve from the baseline ----------

test('serve is struck from behind the baseline at a service corner', () => {
  const d = new GameDirector({ mode: '1v1', seed: 9 });
  d.attachSlot(0);
  step(d, SERVE_DELAY + 0.3);
  d.handleInput(0, { action: 'flat', aim: 0, power: 0.9 });
  step(d, 0.02);
  const s = d.players[0].body;
  assert.ok(Math.abs(s.pos.z) >= COURT.length / 2 - 1, 'behind the baseline');
  assert.ok(Math.abs(s.pos.x) > 1.5, 'at a corner, not mid-baseline');
});

test('serve goes cross-court and both players start on the correct sides', () => {
  const d = new GameDirector({ mode: '1v1', seed: 9 });
  // Opening point: team 0 serves from the deuce (right) corner → cross-court.
  d.positionForServe();
  const server = d.players[0], receiver = d.players[1];
  assert.ok(Math.abs(server.body.pos.z) >= COURT.length / 2 - 0.6, 'server behind their baseline');
  assert.ok(Math.abs(receiver.body.pos.z) >= COURT.length / 2 - 0.6, 'receiver behind their baseline');
  // Cross-court: the server's corner and the receiver's return spot are on
  // opposite world-x sides.
  assert.notEqual(Math.sign(server.body.pos.x), Math.sign(receiver.body.pos.x),
    'receiver stands diagonally across from the server');

  // And the struck serve travels toward the receiver's side (cross-court).
  d.attachSlot(0);
  step(d, SERVE_DELAY + 0.3);
  d.handleInput(0, { action: 'flat' });               // toss
  step(d, 0.05);
  d.handleInput(0, { action: 'flat', aim: 0, power: 0.8 }); // strike
  step(d, 0.05);
  assert.ok(Math.sign(d.ball.vel.x) === Math.sign(receiver.body.pos.x) || Math.abs(d.ball.vel.x) < 0.5,
    'serve heads toward the diagonal box');
});

test('a harder serve swipe produces more pace', () => {
  function servePace(power) {
    const d = new GameDirector({ mode: '1v1', seed: 9 });
    d.attachSlot(0);
    step(d, SERVE_DELAY + 0.3);
    d.handleInput(0, { action: 'flat' });             // toss
    step(d, 0.05);
    d.handleInput(0, { action: 'flat', aim: 0, power }); // strike
    step(d, 0.02);
    return Math.abs(d.ball.vel.z);
  }
  assert.ok(servePace(1.0) > servePace(0.3), 'faster swipe = faster serve');
});

// ---------- controls inversion for team 1 ----------

test('team-1 human movement is un-inverted to match its camera', () => {
  const d = new GameDirector({ mode: '1v1', seed: 2 });
  d.attachSlot(1); // human on team 1 (far side)
  const p = d.players[1];
  const z0 = p.body.pos.z;
  // Push the stick "up" (y negative = toward the top of the held phone). For
  // team 1 that should move them toward the net (+z, since they defend -z).
  d.handleInput(1, { move: { x: 0, y: -1 } });
  // Freeze the ball out of the way and step movement only.
  d.state = 'serve_pending';
  step(d, 0.3);
  assert.ok(p.body.pos.z > z0, 'stick-up moves a team-1 player toward the net (+z), not away');
});

test('team-0 human movement is unchanged (stick-up = toward its net at -z)', () => {
  const d = new GameDirector({ mode: '1v1', seed: 2 });
  d.attachSlot(0);
  const p = d.players[0];
  const z0 = p.body.pos.z;
  d.handleInput(0, { move: { x: 0, y: -1 } });
  d.state = 'serve_pending';
  step(d, 0.3);
  assert.ok(p.body.pos.z < z0, 'stick-up moves a team-0 player toward the net (-z)');
});

test('team-1 human shot aim is flipped to match the camera', () => {
  function aimVx(team, slot, aim) {
    const d = new GameDirector({ mode: '1v1', seed: 5 });
    d.attachSlot(slot);
    const p = d.players[slot];
    p.body.pos = { x: 0, z: team === 0 ? 4 : -4 };
    d.ball = new Ball({ pos: { x: 0, y: 1.0, z: p.body.pos.z }, vel: { x: 0, y: 0, z: team === 0 ? 6 : -6 } });
    d.hit(p, 'flat', aim, 0.8);
    return d.ball.vel.x;
  }
  // For BOTH teams, a "swipe right" (aim +1) should send the ball to the
  // player's own screen-right. The two teams' screen-right are opposite world
  // x, so the resulting world vx should have opposite signs.
  const t0 = aimVx(0, 0, 1);
  const t1 = aimVx(1, 1, 1);
  assert.ok(Math.sign(t0) !== Math.sign(t1), 'same swipe maps to opposite world-x per team (camera-correct)');
});

// ---------- the INPUT relay must carry swipe aim/power/sens to the TV ----------

test('server relays a phone\'s swipe aim/power/sens to the TV (the dropped-fields bug)', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const open = () => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${server.port}`); ws.once('open', () => res(ws)); ws.once('error', rej); });
    const next = (ws, type, ms = 1500) => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timeout ' + type)), ms);
      ws.on('message', function h(raw) { const m = decode(raw); if (m.type === type) { clearTimeout(timer); ws.off('message', h); res(m); } });
    });
    const host = await open();
    host.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));
    await new Promise(r => setTimeout(r, 40));
    const phone = await open();
    phone.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'p' }));
    await next(phone, MSG.JOINED);
    server.startMatch({ live: true }); // so INPUT isn't dropped as paused

    const relayed = next(host, MSG.INPUT);
    phone.send(encode(MSG.INPUT, { seq: 1, t: 0, move: { x: 0, y: 0 }, action: 'slice', aim: 0.7, power: 0.9, sens: 0.6 }));
    const m = await relayed;
    assert.equal(m.action, 'slice');
    assert.equal(m.aim, 0.7, 'swipe aim reaches the TV');
    assert.equal(m.power, 0.9, 'swipe power reaches the TV');
    assert.equal(m.sens, 0.6, 'sensitivity reaches the TV');
    assert.equal(m.slot, 0);

    for (const ws of [host, phone]) ws.close();
  } finally {
    await server.stop();
  }
});

test('movement sensitivity scales a human\'s top speed', () => {
  function topSpeed(sens) {
    const d = new GameDirector({ mode: '1v1', seed: 1 });
    d.attachSlot(0);
    d.state = 'rally'; // avoid serve repositioning yanking the player
    d.handleInput(0, { move: { x: 1, y: 0 }, sens });
    for (let t = 0; t < 3; t += DT) { d.handleInput(0, { move: { x: 1, y: 0 }, sens }); d.update(DT); d.drainEvents(); }
    return Math.hypot(d.players[0].body.vel.x, d.players[0].body.vel.z);
  }
  const slow = topSpeed(0.5);
  const fast = topSpeed(1.1);
  assert.ok(fast > slow + 1, `higher sensitivity = faster top speed (${slow.toFixed(1)} vs ${fast.toFixed(1)})`);
  assert.ok(slow < 6, 'low sensitivity genuinely slows the player down');
});

// ---------- pause relay over real sockets ----------

test('a phone pause request reaches the TV, and the TV pause state reaches phones', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const open = () => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${server.port}`); ws.once('open', () => res(ws)); ws.once('error', rej); });
    const next = (ws, type, ms = 1500) => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timeout ' + type)), ms);
      ws.on('message', function h(raw) { const m = decode(raw); if (m.type === type) { clearTimeout(timer); ws.off('message', h); res(m); } });
    });

    const host = await open();
    host.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));
    await new Promise(r => setTimeout(r, 40));
    const phone = await open();
    phone.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'p' }));
    await next(phone, MSG.JOINED);

    // Phone → server → host.
    const hostGets = next(host, MSG.PAUSE_REQUEST);
    phone.send(encode(MSG.PAUSE_REQUEST, {}));
    await hostGets;

    // Host → server → phone.
    const phoneGets = next(phone, MSG.PAUSE_STATE);
    host.send(encode(MSG.PAUSE_STATE, { paused: true }));
    const state = await phoneGets;
    assert.equal(state.paused, true);

    // A phone cannot broadcast a pause state (only the host may).
    let leaked = false;
    host.on('message', raw => { if (decode(raw).type === MSG.PAUSE_STATE) leaked = true; });
    phone.send(encode(MSG.PAUSE_STATE, { paused: false }));
    await new Promise(r => setTimeout(r, 120));
    assert.equal(leaked, false, 'phones cannot drive pause state');

    for (const ws of [host, phone]) ws.close();
  } finally {
    await server.stop();
  }
});
