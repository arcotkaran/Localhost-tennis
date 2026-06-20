// Testing Gate 19: serve faults & double faults.
// A serve must land in the diagonally-correct service box. First fault → second
// serve; second fault → double fault, the point to the receiver. We force the
// landing deterministically to drive the state machine, plus check the box
// geometry (deuce/ad, both teams) and that AI matches still complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameDirector, SERVE_DELAY } from '../shared/game-director.js';
import { Ball, COURT } from '../shared/physics.js';

const DT = 1 / 120;
const drain = (d, secs) => { const e = []; for (let t = 0; t < secs; t += DT) { d.update(DT); e.push(...d.drainEvents()); } return e; };

// Force the in-flight serve to bounce at a chosen point next frame.
function forceServeLanding(d, x, z) {
  d.ball.pos = { x, y: 0.18, z };
  d.ball.vel = { x: 0, y: -2.5, z: 0 };
}
// Step until the serve resolves (a fault, or a legal bounce clears the flag).
function resolveServe(d, secs = 3) {
  const e = [];
  for (let t = 0; t < secs; t += DT) {
    const before = d.awaitingServeBounce;
    d.update(DT); e.push(...d.drainEvents());
    if (before && !d.awaitingServeBounce) break;
  }
  return e;
}

// ---------- service-box geometry ----------

test('serveLandedInBox enforces side, depth, half, and width', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1 });
  d.serveTarget = { dir: -1, xSign: -1 };                 // team 0 serving deuce → receiver's box at (x<0, z<0)
  assert.equal(d.serveLandedInBox(-2, -3), true, 'inside the correct box');
  assert.equal(d.serveLandedInBox(2, -3), false, 'wrong half (ad box)');
  assert.equal(d.serveLandedInBox(-2, -8), false, 'past the service line (long)');
  assert.equal(d.serveLandedInBox(-2, 3), false, 'wrong side of the net');
  assert.equal(d.serveLandedInBox(-5, -3), false, 'wide of the singles line');
});

test('serve() targets the diagonally-correct box for deuce/ad and both teams', () => {
  // team 0, deuce (even points) → box on the −x, −z side.
  let d = new GameDirector({ mode: '1v1', seed: 1 });
  d.serve('flat');
  assert.deepEqual(d.serveTarget, { dir: -1, xSign: -1 }, 'team0 deuce');

  // team 0, ad (odd points).
  d = new GameDirector({ mode: '1v1', seed: 1 });
  d.score.points = [1, 0]; // one point played → ad court
  d.serve('flat');
  assert.deepEqual(d.serveTarget, { dir: -1, xSign: 1 }, 'team0 ad');

  // team 1, deuce.
  d = new GameDirector({ mode: '1v1', seed: 1 });
  d.score.server = 1;
  d.serve('flat');
  assert.deepEqual(d.serveTarget, { dir: 1, xSign: 1 }, 'team1 deuce');
});

// ---------- fault state machine ----------

test('a serve that misses the box is a FAULT and brings a second serve', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1 });
  d.serve('flat');
  assert.equal(d.serveNumber, 1);
  forceServeLanding(d, 0, d.serveTarget.dir * 9); // long, past the service line
  const events = resolveServe(d);
  const fault = events.find(e => e.type === 'fault');
  assert.ok(fault, 'a fault fired');
  assert.equal(fault.serveNumber, 1, 'it was the first serve');
  assert.equal(d.serveNumber, 2, 'now serving a second serve');
  assert.equal(d.state, 'serve_pending', 'back to waiting to serve');
  assert.ok(!events.some(e => e.type === 'point'), 'no point yet — just a fault');
});

test('two faults = DOUBLE FAULT, point to the receiver, scored', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1 });
  const serverTeam = d.score.server;            // 0
  d.serve('flat');
  forceServeLanding(d, 0, d.serveTarget.dir * 9);
  resolveServe(d);                              // fault 1 → second serve
  assert.equal(d.serveNumber, 2);

  d.serve('flat');                              // the second serve
  forceServeLanding(d, 0, d.serveTarget.dir * 9);
  const events = resolveServe(d);
  assert.ok(events.some(e => e.type === 'double_fault'), 'double fault announced');
  const point = events.find(e => e.type === 'point');
  assert.ok(point, 'a point was awarded');
  assert.equal(point.team, 1 - serverTeam, 'the receiver wins the point');
  assert.equal(point.reason, 'double_fault');
  assert.equal(d.score.points[1 - serverTeam], 1, 'the receiver is now up a point');
  assert.equal(d.serveNumber, 1, 'the next point starts on a first serve again');
});

test('a serve into the net is a fault, not an instant point', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1 });
  d.serve('flat');
  // Drop the ball into the net plane below the cord, travelling toward it.
  d.ball.pos = { x: 0, y: 0.4, z: 0.5 };
  d.ball.vel = { x: 0, y: 0.2, z: d.serveTarget.dir * 8 };
  const events = resolveServe(d);
  assert.ok(events.some(e => e.type === 'fault' && e.reason === 'net'), 'net serve is a fault');
  assert.equal(d.serveNumber, 2, 'second serve follows a net fault');
  assert.ok(!events.some(e => e.type === 'point'));
});

test('a serve that lands in the box is legal — play continues, no fault', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1 });
  d.serve('flat');
  forceServeLanding(d, d.serveTarget.xSign * 1.5, d.serveTarget.dir * 3); // squarely in the box
  const events = resolveServe(d);
  assert.ok(!events.some(e => e.type === 'fault'), 'no fault on a good serve');
  assert.equal(d.awaitingServeBounce, false, 'the serve was accepted');
  assert.equal(d.state, 'rally', 'the rally is on');
});

test('double fault works from the ad court and for team 1', () => {
  for (const serverTeam of [0, 1]) {
    const d = new GameDirector({ mode: '1v1', seed: 7 });
    d.score.server = serverTeam;
    d.score.points = [1, 0]; // odd total → the ad court
    const receiver = 1 - serverTeam;
    const before = d.score.points[receiver];
    for (let n = 0; n < 2; n++) {
      d.serve('flat');
      assert.equal(d.serveTarget.xSign, serverTeam === 0 ? 1 : -1, 'serving from the ad court');
      forceServeLanding(d, 0, d.serveTarget.dir * 9);
      resolveServe(d);
    }
    assert.equal(d.score.points[receiver], before + 1, `team ${serverTeam} double-faulted the point to the receiver`);
  }
});

// ---------- the serve still mostly goes in, and matches complete ----------

test('faults happen but stay a minority, and AI matches still finish', () => {
  for (const surface of ['hard', 'clay', 'grass']) {
    const d = new GameDirector({ mode: '1v1', surface, bestOf: 3, seed: 23 });
    let serves = 0, faults = 0, doubleFaults = 0;
    let t = 0;
    for (; t < 2500 && d.state !== 'finished'; t += DT) {
      d.update(DT);
      for (const e of d.drainEvents()) {
        if (e.type === 'serve') serves++;
        if (e.type === 'fault') faults++;
        if (e.type === 'double_fault') doubleFaults++;
      }
    }
    assert.equal(d.state, 'finished', `${surface}: match completed`);
    assert.ok(faults < serves * 0.5, `${surface}: faults a minority (${faults}/${serves})`);
    assert.ok(doubleFaults <= faults, `${surface}: double faults rarer than faults`);
  }
});

test('a serve must bounce before it can be returned (no air-volley of the serve)', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1 });
  d.serve('flat');
  assert.equal(d.awaitingServeBounce, true, 'the struck serve awaits its first bounce');
  // Stand the receiver right on the in-flight ball, at a reachable height.
  const receiver = d.players[1];
  receiver.body.pos = { x: d.ball.pos.x, z: d.ball.pos.z };
  d.ball.pos = { ...d.ball.pos, y: 1.0 };
  d.ball.bounces = 0;
  const rally0 = d.rallyLength;
  d.tryHits();
  assert.equal(d.rallyLength, rally0, 'the receiver does NOT volley the serve out of the air');
  assert.equal(d.awaitingServeBounce, true, 'still waiting for the serve to bounce');
});

test('a serve fault reports WHERE it missed (net / long / wide) for the TV banner', () => {
  // Long: past the service line, inside the singles line.
  let d = new GameDirector({ mode: '1v1', seed: 1 });
  d.serve('flat');
  d.ball.pos = { x: d.serveTarget.xSign * 1.5, z: d.serveTarget.dir * 9 };
  d.faultServe('out');
  assert.equal(d.drainEvents().find(e => e.type === 'fault').detail, 'long', 'deep miss → long');

  // Wide: inside the service line, past the singles line.
  d = new GameDirector({ mode: '1v1', seed: 1 });
  d.serve('flat');
  d.ball.pos = { x: d.serveTarget.xSign * 5, z: d.serveTarget.dir * 3 };
  d.faultServe('out');
  assert.equal(d.drainEvents().find(e => e.type === 'fault').detail, 'wide', 'wide miss → wide');

  // Net: classified from the reason, no bounce needed.
  d = new GameDirector({ mode: '1v1', seed: 1 });
  d.serve('flat');
  d.faultServe('net');
  assert.equal(d.drainEvents().find(e => e.type === 'fault').detail, 'net', 'net miss → net');
});

test('the serve is decided by ANGLE + SPEED (skill), not a fault percentage', () => {
  // Strike a human serve through the real toss→swipe flow and report the call.
  function strike({ power, aim, seed = 5 }) {
    const d = new GameDirector({ mode: '1v1', seed });
    d.attachSlot(0); d.score.server = 0; d.positionForServe();
    d.update(1 / 120); d.handleInput(0, { action: 'flat' });             // toss
    d.update(1 / 120); d.handleInput(0, { action: 'flat', aim, power }); // strike
    const ev = [];
    for (let i = 0; i < 500; i++) {
      d.update(1 / 120); ev.push(...d.drainEvents());
      if (ev.some(e => e.type === 'fault' || e.type === 'point' || (e.type === 'hit' && e.rallyLength >= 1))) break;
    }
    return ev.find(e => e.type === 'fault')?.detail ?? 'in';
  }
  assert.equal(strike({ power: 0.6, aim: 0 }), 'in', 'a controlled serve lands in');
  assert.equal(strike({ power: 1.0, aim: 0 }), 'long', 'bombing it flat overcooks long');
  assert.equal(strike({ power: 0.6, aim: -1 }), 'wide', 'aiming past the line goes wide');
  // Deterministic — the SAME swipe yields the SAME call on any seed (no dice).
  for (const seed of [1, 2, 50]) {
    assert.equal(strike({ power: 0.9, aim: -0.6, seed }), strike({ power: 0.9, aim: -0.6, seed: 5 }),
      'human serve has no hidden randomness');
  }
});

test('a legal serve from the real serve flow lands in the service box most of the time', () => {
  // Sanity that the tuned serve (not a forced landing) usually lands in.
  let inBox = 0, total = 0;
  for (let seed = 0; seed < 40; seed++) {
    const d = new GameDirector({ mode: '1v1', seed, difficulty: 0.9 });
    d.serve('flat');
    let landed = null;
    const test = new Ball({ pos: { ...d.ball.pos }, vel: { ...d.ball.vel }, spin: { ...d.ball.spin } });
    for (let i = 0; i < 1200; i++) { if (test.step(1 / 240, d.surface) === 'bounce') { landed = { ...test.pos }; break; } }
    if (landed) { total++; if (d.serveLandedInBox(landed.x, landed.z)) inBox++; }
  }
  assert.ok(inBox >= total * 0.8, `strong server lands in ${inBox}/${total} (≥80%)`);
});
