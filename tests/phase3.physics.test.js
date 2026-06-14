// Testing Gate 3: physics accuracy.
// Drops/hits the ball at 50+ angle/speed combinations across all three
// surfaces, verifies trajectory math against closed-form solutions,
// Magnus topspin/slice behaviour, surface bounce character, energy
// conservation, and clay momentum sliding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Ball, simulateFlight, slideDistance, SURFACES, BALL, G,
} from '../shared/physics.js';

const DT = 1 / 240;

// 50 launch combinations: 10 angles × 5 speeds.
const ANGLES = [5, 10, 15, 20, 25, 30, 35, 40, 50, 60];          // degrees
const SPEEDS = [8, 15, 25, 35, 50];                               // m/s
const COMBOS = ANGLES.flatMap(a => SPEEDS.map(s => ({ a, s })));
const launch = (deg, speed, spin = { x: 0, y: 0, z: 0 }, drag = true) => new Ball({
  pos: { x: 0, y: 1.0, z: 0 },
  vel: { x: 0, y: speed * Math.sin(deg * Math.PI / 180), z: speed * Math.cos(deg * Math.PI / 180) },
  spin, drag,
});

test('integrator matches closed-form projectile math (drag off, no spin)', () => {
  for (const { a, s } of COMBOS) {
    const ball = launch(a, s, { x: 0, y: 0, z: 0 }, false);
    const res = simulateFlight(ball, SURFACES.hard, DT);
    assert.ok(res, `ball must land (angle ${a}°, speed ${s})`);
    // Closed form: y(t) = y0 + vy·t − ½gt², solve for y = ball radius.
    const vy = s * Math.sin(a * Math.PI / 180);
    const vz = s * Math.cos(a * Math.PI / 180);
    const y0 = 1.0 - BALL.radius;
    const tFlight = (vy + Math.sqrt(vy * vy + 2 * G * y0)) / G;
    const range = vz * tFlight;
    const err = Math.abs(res.landing.z - range) / range;
    assert.ok(err < 0.02,
      `range error ${(err * 100).toFixed(2)}% at ${a}°/${s}m/s (sim ${res.landing.z.toFixed(2)} vs exact ${range.toFixed(2)})`);
  }
});

test('all 50 combos land on all 3 surfaces with sane drag-shortened trajectories', () => {
  for (const surfaceName of Object.keys(SURFACES)) {
    for (const { a, s } of COMBOS) {
      const surface = SURFACES[surfaceName];
      const withDrag = simulateFlight(launch(a, s), surface, DT);
      const noDrag = simulateFlight(launch(a, s, { x: 0, y: 0, z: 0 }, false), surface, DT);
      assert.ok(withDrag && noDrag, `must land: ${surfaceName} ${a}° ${s}m/s`);
      assert.ok(withDrag.landing.z > 0, 'ball travels forward');
      assert.ok(withDrag.landing.z <= noDrag.landing.z + 1e-6,
        `drag must shorten flight (${surfaceName} ${a}° ${s}m/s)`);
    }
  }
});

test('Magnus effect: topspin pulls the ball down short, slice floats it long', () => {
  const SPIN = 350; // rad/s ≈ 3300 rpm, heavy pro topspin
  let topspinWins = 0, sliceWins = 0, n = 0;
  for (const a of [5, 10, 15, 20, 25]) {
    for (const s of [15, 25, 35]) {
      const flat = simulateFlight(launch(a, s), SURFACES.hard, DT);
      const top = simulateFlight(launch(a, s, { x: SPIN, y: 0, z: 0 }), SURFACES.hard, DT);
      const slice = simulateFlight(launch(a, s, { x: -SPIN, y: 0, z: 0 }), SURFACES.hard, DT);
      n++;
      if (top.landing.z < flat.landing.z) topspinWins++;
      if (slice.landing.z > flat.landing.z) sliceWins++;
      assert.ok(top.apex <= flat.apex + 1e-6, `topspin apex must not exceed flat apex (${a}°/${s})`);
      assert.ok(slice.apex >= flat.apex - 1e-6, `slice apex must not be below flat apex (${a}°/${s})`);
    }
  }
  assert.equal(topspinWins, n, 'topspin landed shorter than flat in every combo');
  assert.equal(sliceWins, n, 'slice floated longer than flat in every combo');
});

test('surface character: clay bounces highest, grass stays fastest and lowest', () => {
  for (const { a, s } of COMBOS) {
    const results = {};
    for (const name of Object.keys(SURFACES)) {
      const ball = launch(a, s);
      simulateFlight(ball, SURFACES[name], DT);
      results[name] = {
        vyOut: ball.vel.y,                       // vertical exit speed → bounce height
        vzOut: Math.abs(ball.vel.z),             // horizontal pace through the bounce
      };
    }
    assert.ok(results.clay.vyOut > results.hard.vyOut && results.hard.vyOut > results.grass.vyOut,
      `bounce height order clay>hard>grass violated at ${a}°/${s}m/s`);
    assert.ok(results.grass.vzOut > results.hard.vzOut && results.hard.vzOut > results.clay.vzOut,
      `pace order grass>hard>clay violated at ${a}°/${s}m/s`);
  }
});

test('mechanical energy never increases at any step (no perpetual-motion bugs)', () => {
  for (const { a, s } of [{ a: 15, s: 30 }, { a: 45, s: 20 }, { a: 60, s: 40 }, { a: 5, s: 50 }]) {
    const ball = launch(a, s, { x: 300, y: 0, z: 0 });
    let prev = ball.energy();
    for (let t = 0; t < 10; t += DT) {
      ball.step(DT, SURFACES.hard);
      const e = ball.energy();
      assert.ok(e <= prev + 1e-6, `energy increased ${prev.toFixed(5)} → ${e.toFixed(5)} at t=${t.toFixed(3)} (${a}°/${s})`);
      prev = e;
    }
  }
});

test('ball decays to rest through repeated bounces — no infinite jitter', () => {
  const ball = launch(30, 20);
  for (let t = 0; t < 30 && !ball.atRest; t += DT) ball.step(DT, SURFACES.hard);
  assert.ok(ball.atRest, 'ball must come to rest within 30 simulated seconds');
  assert.ok(ball.bounces >= 2, 'ball bounced multiple times before resting');
});

test('topspin grips and kicks forward off the court vs slice checking up', () => {
  const top = launch(12, 30, { x: 350, y: 0, z: 0 });
  const slice = launch(12, 30, { x: -350, y: 0, z: 0 });
  simulateFlight(top, SURFACES.hard, DT);
  simulateFlight(slice, SURFACES.hard, DT);
  const topRetention = Math.abs(top.vel.z);
  const sliceRetention = Math.abs(slice.vel.z);
  assert.ok(topRetention > sliceRetention,
    `topspin must exit the bounce hotter (${topRetention.toFixed(2)} vs ${sliceRetention.toFixed(2)} m/s)`);
});

test('clay momentum sliding: long controlled slides vs hard and grass stops', () => {
  for (const speed of [4, 6, 8.5]) {
    const clay = slideDistance(speed, SURFACES.clay);
    const hard = slideDistance(speed, SURFACES.hard);
    const grass = slideDistance(speed, SURFACES.grass);
    assert.ok(clay > hard * 1.8, `clay slide (${clay.toFixed(2)}m) must far exceed hard (${hard.toFixed(2)}m) at ${speed}m/s`);
    assert.ok(clay > grass * 1.8, `clay slide must far exceed grass at ${speed}m/s`);
    // Sanity: an 8.5 m/s sprint on clay slides metres, not centimetres or forever.
    if (speed === 8.5) assert.ok(clay > 3 && clay < 12, `full-sprint clay slide ${clay.toFixed(2)}m must be 3–12m`);
  }
});

test('player sliding state flags engage only on clay', () => {
  const { PlayerBody } = awaitImport();
  for (const [name, surface] of Object.entries(SURFACES)) {
    const p = new PlayerBody();
    p.vel = { x: 0, z: 7 };
    p.step(DT, { x: 0, y: 0 }, surface);
    assert.equal(p.sliding, surface.slides, `sliding flag on ${name}`);
  }
});

// Helper to keep import list tidy for the one extra symbol.
import { PlayerBody } from '../shared/physics.js';
function awaitImport() { return { PlayerBody }; }
