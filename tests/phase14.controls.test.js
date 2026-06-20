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

test('a tap (tiny movement) is a lob', () => {
  const s = gestureToShot({ dx: 3, dy: 2, durationMs: 80 });
  assert.equal(s.action, 'lob', 'tap → lob (flick it over the net player)');
  assert.equal(s.gesture, 'tap');
  assert.ok(s.power > 0 && s.power < 1, 'a tap-lob plays at a gentle, in-court pace');
});

test('swipe directions map to the intended shots', () => {
  // Swipe UP is the DRIVE family; the swipe SPEED chooses topspin vs flat.
  assert.equal(gestureToShot({ dx: 4, dy: -90, durationMs: 320 }).action, 'topspin', 'slow up = topspin');
  assert.equal(gestureToShot({ dx: 4, dy: -90, durationMs: 70 }).action, 'flat', 'fast up = flat');
  // Swipe DOWN is the slice / drop shot.
  assert.equal(gestureToShot({ dx: -6, dy: 90, durationMs: 120 }).action, 'slice', 'down = slice');
  // A shallow forward swipe is still a drive, speed-graded the same way.
  assert.equal(gestureToShot({ dx: 120, dy: 8, durationMs: 60 }).action, 'flat', 'fast forward = flat');
  assert.equal(gestureToShot({ dx: 70, dy: 6, durationMs: 320 }).action, 'topspin', 'slow forward = topspin');
});

test('diagonal swipe = shot from the vertical, aim from the horizontal', () => {
  // The user's example: swipe diagonally down-and-right → slice aimed right.
  const downRight = gestureToShot({ dx: 90, dy: 90, durationMs: 140 });
  assert.equal(downRight.action, 'slice', 'down component → slice');
  assert.ok(downRight.aimX > 0.4, 'right component → aim right');

  // Up-and-left → a drive (topspin/flat) placed to the left.
  const upLeft = gestureToShot({ dx: -80, dy: -100, durationMs: 140 });
  assert.ok(['flat', 'topspin'].includes(upLeft.action), 'up component → drive');
  assert.ok(upLeft.aimX < -0.4, 'left component → aim left');

  // A mostly-horizontal swipe is a drive, still aimed by its x.
  const flatRight = gestureToShot({ dx: 130, dy: 15, durationMs: 90 });
  assert.ok(['flat', 'topspin'].includes(flatRight.action), 'shallow swipe = drive');
  assert.ok(flatRight.aimX > 0.4, 'driven to the right');
});

test('swipes produce only the drive and slice families; a tap produces the lob', () => {
  const seen = new Set();
  for (let ang = 0; ang < 360; ang += 15) {
    const r = 100, rad = ang * Math.PI / 180;
    seen.add(gestureToShot({ dx: Math.cos(rad) * r, dy: Math.sin(rad) * r, durationMs: 150 }).action);
  }
  for (const a of seen) assert.ok(['flat', 'topspin', 'slice'].includes(a), `${a} is a drive or slice`);
  assert.ok(seen.has('slice'), 'slice is reachable by swiping down');
  assert.ok(seen.has('flat') || seen.has('topspin'), 'the drive is reachable by swiping up/across');
  assert.ok(!seen.has('lob'), 'a swipe never lobs — the lob is the tap');
  assert.equal(gestureToShot({ dx: 2, dy: 1, durationMs: 60 }).action, 'lob', 'the tap is the lob');
});

test('swipe speed sets power; swipe x sets aim', () => {
  const soft = gestureToShot({ dx: 60, dy: 0, durationMs: 400 });
  const hard = gestureToShot({ dx: 200, dy: 0, durationMs: 90 });
  assert.ok(hard.power > soft.power, 'faster swipe = more power');
  assert.ok(hard.power <= 1 && soft.power >= 0.4, 'power stays in range');

  const right = gestureToShot({ dx: 150, dy: -20, durationMs: 150 });
  const left = gestureToShot({ dx: -150, dy: -20, durationMs: 150 });
  assert.ok(right.aimX > 0.6 && left.aimX < -0.6, 'horizontal swipe aims left/right');
  assert.ok(Math.abs(gestureToShot({ dx: 9999, dy: 0, durationMs: 100 }).aimX) <= 1, 'aim clamps to [-1,1]');
});

test('swipe power rises monotonically with swipe speed (faster = harder)', () => {
  // Hold the distance fixed (an up-swipe) and vary only the duration → speed.
  const dist = 150;
  const powerAt = pxPerSec => gestureToShot({ dx: 0, dy: -dist, durationMs: (dist / pxPerSec) * 1000 }).power;
  const series = [200, 600, 1000, 1600, 2400].map(powerAt);
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i] >= series[i - 1], `power non-decreasing with speed (${series.map(p => p.toFixed(2))})`);
  }
  assert.equal(series.at(-1), 1, 'a hard swipe reaches full power');
  assert.ok(series[0] < series.at(-1) - 0.2, 'a soft swipe is genuinely softer than a hard one');
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

test('a full-aim swipe reaches a sharp cross-court angle (short direction change)', () => {
  // The old kinematic nudge only spread a full swipe ~1 m; a real angle should
  // place the ball out near the singles sideline, both ways, still in bounds.
  function landX(aim) {
    const d = new GameDirector({ mode: '1v1', seed: 6 });
    d.attachSlot(0);
    const p = d.players[0]; p.body.pos = { x: 0, z: 6 };
    d.ball = new Ball({ pos: { x: 0, y: 1.0, z: 6 }, vel: { x: 0, y: 0, z: 6 } });
    d.hit(p, 'flat', aim, 0.8);
    let landing = null;
    for (let i = 0; i < 1500; i++) if (d.ball.step(1 / 120, d.surface) === 'bounce') { landing = { ...d.ball.pos }; break; }
    return landing.x;
  }
  const right = landX(1), left = landX(-1);
  assert.ok(right > 2.6, `full right aim angles wide (x=${right.toFixed(2)})`);
  assert.ok(left < -2.6, `full left aim angles wide (x=${left.toFixed(2)})`);
  assert.ok(Math.abs(right) <= COURT.singlesWidth / 2 && Math.abs(left) <= COURT.singlesWidth / 2,
    'a sharp angle still lands inside the singles sideline');
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

test('mapAction carries a rounded swipe power, null when omitted', () => {
  const mapper = new InputMapper(() => 0);
  const msg = decode(mapper.mapAction('flat', { x: 0, y: 0 }, 0.5, 0.83333));
  assert.equal(msg.power, 0.833, 'power rounded to 3 decimals (like aim)');
  assert.equal(msg.aim, 0.5, 'aim and power travel together, independently');
  const noPower = decode(mapper.mapAction('topspin', { x: 0, y: 0 }, 0.5));
  assert.equal(noPower.power, null, 'power is null when not provided (back-compat)');
});
