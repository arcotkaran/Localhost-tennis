// Testing Gate 14: controller overhaul.
// Swipe → shot mapping, net auto-volley / high-ball auto-smash, swipe aim
// reaching the engine, decoupled human (snappy) vs AI (human-like) accel,
// and the low-latency aim-carrying input message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gestureToShot, applyNetContext, SWIPE_MIN_PX, NET_VOLLEY_DISTANCE,
} from '../shared/gestures.js';
import { GameDirector, SERVE_DELAY } from '../shared/game-director.js';
import { Ball, COURT } from '../shared/physics.js';
import { InputMapper } from '../client_mobile/js/input-mapper.js';
import { decode } from '../shared/protocol.js';

const DT = 1 / 120;

// ---------- swipe → shot ----------

test('a tap (tiny movement) is a safe topspin', () => {
  const s = gestureToShot({ dx: 3, dy: 2, durationMs: 80 });
  assert.equal(s.action, 'topspin');
  assert.equal(s.gesture, 'tap');
});

test('swipe directions map to the intended shots', () => {
  assert.equal(gestureToShot({ dx: 4, dy: -90, durationMs: 120 }).action, 'lob', 'up = lob');
  assert.equal(gestureToShot({ dx: -6, dy: 90, durationMs: 120 }).action, 'slice', 'down = slice');
  assert.equal(gestureToShot({ dx: 120, dy: 8, durationMs: 60 }).action, 'flat', 'fast forward = flat');
  assert.equal(gestureToShot({ dx: 70, dy: 6, durationMs: 320 }).action, 'topspin', 'slow forward = topspin');
});

test('diagonal swipe = shot from the vertical, aim from the horizontal', () => {
  // The user's example: swipe diagonally down-and-right → slice aimed right.
  const downRight = gestureToShot({ dx: 90, dy: 90, durationMs: 140 });
  assert.equal(downRight.action, 'slice', 'down component → slice');
  assert.ok(downRight.aimX > 0.4, 'right component → aim right');

  const upLeft = gestureToShot({ dx: -80, dy: -100, durationMs: 140 });
  assert.equal(upLeft.action, 'lob', 'up component → lob');
  assert.ok(upLeft.aimX < -0.4, 'left component → aim left');

  // A mostly-horizontal swipe is a drive, still aimed by its x.
  const flatRight = gestureToShot({ dx: 130, dy: 15, durationMs: 90 });
  assert.ok(['flat', 'topspin'].includes(flatRight.action), 'shallow swipe = drive');
  assert.ok(flatRight.aimX > 0.4, 'driven to the right');
});

test('only drive / lob / slice are produced from swipes (no buttons)', () => {
  const seen = new Set();
  for (let ang = 0; ang < 360; ang += 15) {
    const r = 100, rad = ang * Math.PI / 180;
    seen.add(gestureToShot({ dx: Math.cos(rad) * r, dy: Math.sin(rad) * r, durationMs: 150 }).action);
  }
  for (const a of seen) assert.ok(['flat', 'topspin', 'slice', 'lob'].includes(a), `${a} is a drive/lob/slice`);
  assert.ok(seen.has('slice') && seen.has('lob'), 'slice and lob are reachable by swipe direction');
});

test('swipe speed sets power; swipe x sets aim', () => {
  const soft = gestureToShot({ dx: 60, dy: 0, durationMs: 400 });
  const hard = gestureToShot({ dx: 200, dy: 0, durationMs: 90 });
  assert.ok(hard.power > soft.power, 'faster swipe = more power');
  assert.ok(hard.power <= 1 && soft.power >= 0.45, 'power stays in range');

  const right = gestureToShot({ dx: 150, dy: -20, durationMs: 150 });
  const left = gestureToShot({ dx: -150, dy: -20, durationMs: 150 });
  assert.ok(right.aimX > 0.6 && left.aimX < -0.6, 'horizontal swipe aims left/right');
  assert.ok(Math.abs(gestureToShot({ dx: 9999, dy: 0, durationMs: 100 }).aimX) <= 1, 'aim clamps to [-1,1]');
});

test('tap threshold distinguishes tap from swipe', () => {
  assert.equal(gestureToShot({ dx: SWIPE_MIN_PX - 5, dy: 0, durationMs: 100 }).gesture, 'tap');
  assert.notEqual(gestureToShot({ dx: SWIPE_MIN_PX + 40, dy: 0, durationMs: 100 }).gesture, 'tap');
});

// ---------- auto volley / smash ----------

test('net context turns a groundstroke into a volley, far shots unchanged', () => {
  assert.equal(applyNetContext('flat', 2.0), 'volley', 'flat at the net → volley');
  assert.equal(applyNetContext('topspin', NET_VOLLEY_DISTANCE - 0.1), 'volley');
  assert.equal(applyNetContext('flat', 9.0), 'flat', 'baseline flat stays flat');
  assert.equal(applyNetContext('slice', 1.0), 'slice', 'slice is never auto-volleyed');
  assert.equal(applyNetContext('lob', 1.0), 'lob', 'lob is never auto-volleyed');
});

test('a high ball inside the court is auto-smashed', () => {
  const d = new GameDirector({ mode: '1v1', seed: 4 });
  const player = d.players[0]; // team 0, near baseline z≈+10
  // Put the player inside the court and a high ball at contact.
  player.body.pos = { x: 0, z: 4 };
  d.ball = new Ball({ pos: { x: 0, y: 2.4, z: 4 }, vel: { x: 0, y: -1, z: 5 } });
  d.hit(player, 'topspin');
  assert.equal(d.lastShot, 'smash', 'high sitter inside the court is smashed');
});

test('a high ball at the baseline stays a lob (defensive), not a smash', () => {
  const d = new GameDirector({ mode: '1v1', seed: 4 });
  const player = d.players[0];
  player.body.pos = { x: 0, z: COURT.length / 2 - 0.2 }; // deep
  d.ball = new Ball({ pos: { x: 0, y: 2.4, z: player.body.pos.z }, vel: { x: 0, y: -1, z: 5 } });
  d.hit(player, 'lob');
  assert.equal(d.lastShot, 'lob', 'deep high ball is not auto-smashed');
});

// ---------- swipe aim reaches the engine ----------

test('swipe aim (not the move stick) places the human\'s shot', () => {
  function hitWithAim(aim) {
    const d = new GameDirector({ mode: '1v1', seed: 6 });
    d.attachSlot(0); // team 0 human (no camera inversion — see phase15 for that)
    const p = d.players[0];
    p.body.pos = { x: 0, z: 5 };
    d.ball = new Ball({ pos: { x: 0, y: 1.0, z: 5 }, vel: { x: 0, y: 0, z: 6 } });
    d.handleInput(0, { action: 'flat', aim, power: 0.8 });
    d.hit(p, 'flat', aim, 0.8);
    return d.ball.vel.x;
  }
  const aPos = hitWithAim(1);
  const aNeg = hitWithAim(-1);
  assert.notEqual(Math.sign(aPos), Math.sign(aNeg), 'opposite aims place to opposite sides');
  assert.ok(Math.abs(aPos - aNeg) > 1.0, 'aim meaningfully changes placement');
});

// ---------- decoupled acceleration ----------

test('humans get responsive accel; AI keeps human-like accel', () => {
  const d = new GameDirector({ mode: '2v2', seed: 2 });
  d.attachSlot(0);            // player 0 is human
  d.update(DT);               // stepPlayers assigns accel
  assert.ok(d.players[0].body.accel > d.players[1].body.accel, 'human is more responsive than AI');
  assert.equal(d.players[1].body.accel, 24, 'AI accel is human-like (rallies still end)');
});

test('full match still completes with the new movement/error model', () => {
  const d = new GameDirector({ mode: '1v1', surface: 'clay', bestOf: 3, seed: 11 });
  let t = 0;
  for (; t < 1500 && d.state !== 'finished'; t += DT) { d.update(DT); d.drainEvents(); }
  assert.equal(d.state, 'finished', `match completed (sim ${t.toFixed(0)}s)`);
});

// ---------- input message carries aim, cheaply ----------

test('mapAction carries a rounded swipe aim alongside the move', () => {
  const mapper = new InputMapper(() => 0);
  const msg = decode(mapper.mapAction('slice', { x: 0.2, y: -0.3 }, 0.66667));
  assert.equal(msg.action, 'slice');
  assert.equal(msg.aim, 0.667, 'aim rounded to 3 decimals');
  assert.deepEqual(msg.move, { x: 0.2, y: -0.3 });
  const noAim = decode(mapper.mapAction('flat'));
  assert.equal(noAim.aim, null, 'aim is null when not provided');
});
