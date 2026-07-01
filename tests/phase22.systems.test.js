// Testing Gate 22: stamina management + momentum / power-shot systems.
// Both are HUMAN-ONLY mechanics (gated on controlledBySlot), so AI-only play —
// and the whole seeded audit — is unchanged. These tests drive the real
// GameDirector: no mocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GameDirector,
  STAMINA_DRAIN, STAMINA_FATIGUE_SPEED, STAMINA_RECOVER,
  MOMENTUM_PER_PERFECT, POWER_BOOST_TIME,
  REACH_X, REACH_Z,
} from '../shared/game-director.js';
import { Ball } from '../shared/physics.js';

const DT = 1 / 120;

function stepWithMove(d, move, seconds) {
  const events = [];
  for (let t = 0; t < seconds; t += DT) {
    d.players[0].move = { ...move };
    d.update(DT);
    events.push(...d.drainEvents());
  }
  return events;
}

// Put the ball in player 0's sweet spot for a clean, repeatable strike.
function freshSweetBall(d) {
  const p = d.players[0].body.pos;
  d.ball = new Ball({ pos: { x: p.x + 0.1, y: 1.0, z: p.z + 0.1 }, vel: { x: 0, y: -2, z: 0 } });
  d.ball.bounces = 1; // a returnable ball (already bounced once)
}

// ---------- stamina ----------

test('sustained sprinting drains a human\'s stamina', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  d.state = 'rally'; // skip serve repositioning
  stepWithMove(d, { x: 1, y: 0 }, 3);
  const s = d.players[0].stamina;
  assert.ok(s < 1, `stamina fell while sprinting (now ${s.toFixed(2)})`);
  // ~3 s of drain, not fatigued yet (so the existing 3 s sprint tests are safe).
  assert.ok(Math.abs(s - (1 - STAMINA_DRAIN * 3)) < 0.05, 'drain tracks the rate');
  assert.equal(d.players[0].fatigued, false, '3 s is not enough to exhaust');
});

test('emptying stamina exhausts the player and halves their top speed', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  d.state = 'rally';
  const events = stepWithMove(d, { x: 1, y: 0 }, 9); // long enough to bottom out
  const p = d.players[0];
  assert.equal(p.fatigued, true, 'held sprint to exhaustion');
  assert.ok(p.stamina <= 0.02, 'stamina bottomed out');
  assert.ok(events.some(e => e.type === 'exhausted' && e.slot === 0), 'fired an exhausted cue');
  const baseMax = 8.5 * 0.85; // default sensitivity
  const speed = Math.hypot(p.body.vel.x, p.body.vel.z);
  assert.ok(speed < baseMax * (STAMINA_FATIGUE_SPEED + 0.08),
    `exhausted top speed ${speed.toFixed(2)} ≈ half of ${baseMax.toFixed(2)}`);
});

test('stamina regenerates and exhaustion clears once the player eases off', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  d.state = 'rally';
  stepWithMove(d, { x: 1, y: 0 }, 9);          // exhaust
  assert.equal(d.players[0].fatigued, true);
  const events = stepWithMove(d, { x: 0, y: 0 }, 6); // stand still and recover
  const p = d.players[0];
  assert.ok(p.stamina >= STAMINA_RECOVER, `stamina recovered to ${p.stamina.toFixed(2)}`);
  assert.equal(p.fatigued, false, 'exhaustion cleared after recovery');
  assert.ok(events.some(e => e.type === 'recovered' && e.slot === 0), 'fired a recovered cue');
});

test('AI players never touch stamina or momentum (keeps seeded play identical)', () => {
  const d = new GameDirector({ mode: '1v1', seed: 7 }); // no slots → all AI
  for (let t = 0; t < 6; t += DT) { d.update(DT); d.drainEvents(); }
  for (const p of d.players) {
    assert.equal(p.stamina, 1, 'AI stamina untouched');
    assert.equal(p.fatigued, false);
    assert.equal(p.momentum, 0, 'AI momentum untouched');
    assert.equal(p.powerShotReady, false);
  }
});

// ---------- momentum & power shot ----------

test('sweet-spot strikes build momentum; a stretched strike does not', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  d.players[0].body.pos = { x: 0, z: 5 };

  freshSweetBall(d);
  d.hit(d.players[0], 'flat', 0, 0.7);
  assert.ok(Math.abs(d.players[0].momentum - MOMENTUM_PER_PERFECT) < 1e-9, 'sweet strike adds momentum');

  // A ball met at full stretch (edge of reach, low) is not "perfect".
  const before = d.players[0].momentum;
  const p = d.players[0].body.pos;
  d.ball = new Ball({ pos: { x: p.x + REACH_X * 0.95, y: 0.3, z: p.z + REACH_Z * 0.95 }, vel: { x: 0, y: -2, z: 0 } });
  d.ball.bounces = 1;
  d.hit(d.players[0], 'flat', 0, 0.7);
  assert.equal(d.players[0].momentum, before, 'a stretched strike earns nothing');
});

test('a full meter arms a power shot that fires on the next strike, then resets', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  d.players[0].body.pos = { x: 0, z: 5 };
  const events = [];
  const fills = Math.ceil(1 / MOMENTUM_PER_PERFECT);
  for (let i = 0; i < fills; i++) { freshSweetBall(d); d.hit(d.players[0], 'flat', 0, 0.7); events.push(...d.drainEvents()); }

  assert.equal(d.players[0].momentum, 1, 'meter filled to 100%');
  assert.equal(d.players[0].powerShotReady, true, 'power shot armed');
  assert.ok(events.some(e => e.type === 'power_ready' && e.slot === 0), 'announced power ready');

  freshSweetBall(d);
  d.hit(d.players[0], 'flat', 0, 0.7);
  const fired = d.drainEvents();
  assert.ok(fired.some(e => e.type === 'power_shot' && e.slot === 0), 'power shot fired on the next strike');
  const hit = fired.find(e => e.type === 'hit');
  assert.equal(hit.powerShot, true, 'the hit event is flagged as a power shot');
  assert.equal(d.players[0].powerShotReady, false, 'the arm was consumed');
  assert.equal(d.players[0].momentum, 0, 'the meter emptied');
  assert.ok(d.players[0].speedBoost > 0 && d.players[0].speedBoost <= POWER_BOOST_TIME, 'a movement surge started');
});

test('a power shot lands deeper and harder than a normal shot from the same contact', () => {
  function landing({ power }) {
    const d = new GameDirector({ mode: '1v1', seed: 3 });
    d.attachSlot(0);
    d.players[0].body.pos = { x: 0, z: 5 };
    d.players[0].powerShotReady = power;
    freshSweetBall(d);
    d.hit(d.players[0], 'flat', 0, 0.8);
    return { z: Math.abs(d.landingPoint().z), vz: Math.abs(d.ball.vel.z) };
  }
  const normal = landing({ power: false });
  const power = landing({ power: true });
  assert.ok(power.z > normal.z + 0.5, `power shot lands deeper (${power.z.toFixed(2)} vs ${normal.z.toFixed(2)} m)`);
  assert.ok(power.vz > normal.vz, `power shot leaves the racket faster (${power.vz.toFixed(1)} vs ${normal.vz.toFixed(1)} m/s)`);
});

// ---------- persistence ----------

test('stamina & momentum survive serialize/restore (pause-resume)', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  Object.assign(d.players[0], { stamina: 0.42, fatigued: true, momentum: 0.6, powerShotReady: true, speedBoost: 2.1 });
  const snap = d.serialize();

  const d2 = new GameDirector({ mode: '1v1', seed: 3 });
  d2.attachSlot(0);
  d2.restore(snap);
  const p = d2.players[0];
  assert.equal(p.stamina, 0.42);
  assert.equal(p.fatigued, true);
  assert.equal(p.momentum, 0.6);
  assert.equal(p.powerShotReady, true);
  assert.equal(p.speedBoost, 2.1);
});
