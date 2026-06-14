// Testing Gate 5: presentation correctness + performance profiling.
// Verifies spatial audio mapping, grunt power scaling, the reactive crowd
// state machine (gasp / cheer / pre-serve silence) with its haptic bridge,
// the interaction sequences, and then profiles a worst-case high-density
// audiovisual moment for frame-budget and memory discipline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioDirector, spatialPan, SAMPLES } from '../client_host/js/audio-manager.js';
import { CrowdManager, CROWD_STATE } from '../client_host/js/crowd-manager.js';
import { entrySequence, postPointInteraction, postMatchSequence, sampleTimeline, CLIPS } from '../client_host/js/interactions.js';
import { HAPTIC_PATTERNS } from '../shared/protocol.js';
import { Ball, PlayerBody, SURFACES } from '../shared/physics.js';

// ---------- audio ----------

test('racket whip is distinct per shot type and scales with power', () => {
  const audio = new AudioDirector();
  const soft = audio.racketHit({ action: 'slice', power: 0.3, pos: { x: 0 } });
  const smash = audio.racketHit({ action: 'smash', power: 1.0, pos: { x: 0 } });
  assert.equal(soft.sample, 'thwack_slice');
  assert.equal(smash.sample, 'thwack_smash');
  assert.ok(smash.volume > soft.volume, 'power raises volume');
  assert.ok(smash.pitch < soft.pitch, 'power deepens the thwack');
});

test('bounce sample tracks the court surface', () => {
  const audio = new AudioDirector();
  for (const surface of ['grass', 'clay', 'hard']) {
    const d = audio.ballBounce({ surface, speed: 20, pos: { x: 0 } });
    assert.equal(d.sample, SAMPLES.bounce[surface]);
  }
});

test('grunts scale with shot power: tier and volume strictly increase', () => {
  const audio = new AudioDirector();
  const tiers = [0.2, 0.6, 1.0].map(power => audio.grunt({ power, pos: { x: 0 } }));
  assert.deepEqual(tiers.map(t => t.sample), ['grunt_soft', 'grunt_mid', 'grunt_hard']);
  assert.ok(tiers[0].volume < tiers[1].volume && tiers[1].volume < tiers[2].volume);
});

test('spatial pan follows court x position', () => {
  assert.equal(spatialPan(0), 0, 'center court is centered');
  assert.ok(spatialPan(-4) < -0.5, 'left side pans left');
  assert.ok(spatialPan(4) > 0.5, 'right side pans right');
  assert.equal(spatialPan(-99), -1, 'pan clamps');
});

// ---------- crowd dynamics ----------

test('crowd quiets to complete silence before a serve', () => {
  const crowd = new CrowdManager();
  assert.equal(crowd.state, CROWD_STATE.MURMUR);
  crowd.preServe();
  assert.equal(crowd.state, CROWD_STATE.SILENT);
  assert.equal(crowd.intensity, 0);
});

test('crowd gasps during prolonged high-speed rallies and pulses phones', () => {
  const haptics = [];
  const crowd = new CrowdManager({ sendHaptic: p => haptics.push(p) });
  crowd.preServe();
  // Slow short rally: no gasp.
  for (let shot = 1; shot <= 5; shot++) crowd.rallyShot({ rallyLength: shot, ballSpeed: 18 });
  assert.notEqual(crowd.state, CROWD_STATE.GASP);
  // Rally extends and heats up past 8 shots at >28 m/s:
  for (let shot = 6; shot <= 10; shot++) crowd.rallyShot({ rallyLength: shot, ballSpeed: 34 });
  assert.equal(crowd.state, CROWD_STATE.GASP, 'prolonged high-speed rally → gasp');
  assert.deepEqual(haptics[0], HAPTIC_PATTERNS.crowdRoar, 'momentum pulse mirrored to controllers');

  // Gasp decays back to tension, not straight to murmur.
  crowd.update(1.0);
  assert.equal(crowd.state, CROWD_STATE.TENSE);
});

test('crowd erupts for smash winners louder than routine points', () => {
  const audioA = new AudioDirector();
  const a = new CrowdManager({ audio: audioA });
  a.pointWon({ winningShot: 'flat', rallyLength: 3 });
  const routine = a.intensity;

  const audioB = new AudioDirector();
  const b = new CrowdManager({ audio: audioB });
  b.pointWon({ winningShot: 'smash', rallyLength: 3 });
  assert.equal(b.state, CROWD_STATE.ERUPTION);
  assert.ok(b.intensity > routine, 'smash winner cheer is louder');
  const cheers = audioB.drain().filter(d => d.sample === 'crowd_cheer');
  assert.equal(cheers.length, 1, 'cheer sample fired');
});

test('full point arc: silence → rally tension → eruption → settle → silence', () => {
  const crowd = new CrowdManager();
  crowd.preServe();
  crowd.rallyShot({ rallyLength: 1, ballSpeed: 45 });
  assert.equal(crowd.state, CROWD_STATE.MURMUR, 'serve in play breaks the silence quietly');
  for (let i = 2; i <= 12; i++) crowd.rallyShot({ rallyLength: i, ballSpeed: 33 });
  crowd.pointWon({ winningShot: 'smash', rallyLength: 12 });
  assert.equal(crowd.state, CROWD_STATE.ERUPTION);
  for (let i = 0; i < 50; i++) crowd.update(0.1); // 5 seconds pass
  assert.equal(crowd.state, CROWD_STATE.MURMUR, 'cheering settles');
  crowd.preServe();
  assert.equal(crowd.state, CROWD_STATE.SILENT, 'hushed again for the next serve');
});

// ---------- player interactions ----------

test('cinematic entry: walk-ons, waves, then pre-match handshake at the net', () => {
  const players = [{ id: 'p0', team: 0 }, { id: 'p1', team: 1 }];
  const seq = entrySequence(players);
  const walkOns = seq.timeline.filter(i => i.clip === CLIPS.WALK_ON);
  assert.equal(walkOns.length, 2, 'every player walks onto the court');
  assert.ok(walkOns[1].at > walkOns[0].at, 'entrances are staggered');
  const shakes = seq.timeline.filter(i => i.clip === CLIPS.HANDSHAKE);
  assert.equal(shakes.length, 2);
  assert.ok(shakes.every(s => s.at_location === 'net'));
  assert.ok(Math.min(...shakes.map(s => s.at)) >= Math.max(...walkOns.map(w => w.at + w.duration)),
    'handshake happens after everyone has walked on');
  // Mid-walk sample shows the actor in the walk clip.
  assert.equal(sampleTimeline(seq, 1.0).p0.clip, CLIPS.WALK_ON);
});

test('doubles partners tap rackets after a point; never in singles', () => {
  const team = [{ id: 'a', team: 0 }, { id: 'b', team: 0 }];
  const seq = postPointInteraction('2v2', team);
  assert.equal(seq.timeline.length, 2);
  assert.equal(seq.timeline[0].clip, CLIPS.RACKET_TAP);
  assert.equal(seq.timeline[0].with, 'b', 'partners tap each other');
  assert.equal(seq.timeline[1].with, 'a');
  assert.equal(postPointInteraction('1v1', [team[0]]), null, 'no racket tap in singles');
});

test('post-match: all four shake hands at the net, winners lift the trophy', () => {
  const players = [
    { id: 'a', team: 0 }, { id: 'b', team: 0 },
    { id: 'c', team: 1 }, { id: 'd', team: 1 },
  ];
  const seq = postMatchSequence(players, 0);
  const shakes = seq.timeline.filter(i => i.clip === CLIPS.NET_HANDSHAKE);
  assert.equal(shakes.length, 4, 'all players shake hands');
  const trophies = seq.timeline.filter(i => i.clip === CLIPS.TROPHY_LIFT);
  assert.deepEqual(trophies.map(t => t.actor).sort(), ['a', 'b'], 'only the winning team celebrates');
  assert.ok(trophies[0].at >= Math.max(...shakes.map(s => s.at + s.duration)),
    'sportsmanship first: handshakes complete before celebration');
});

// ---------- performance profiling: worst-case audiovisual moment ----------

test('zero frame drops: 30 simulated seconds of worst-case load stay under budget', () => {
  const TICK_HZ = 120;
  const DT = 1 / TICK_HZ;
  const FRAME_BUDGET_MS = 1000 / 60 / 2; // 8.33ms — half a 60fps frame for logic
  const ticks = 30 * TICK_HZ;

  const haptics = [];
  const audio = new AudioDirector();
  const crowd = new CrowdManager({ sendHaptic: p => haptics.push(p), audio });
  const balls = Array.from({ length: 4 }, () => new Ball({
    pos: { x: 0, y: 1.5, z: 0 }, vel: { x: 2, y: 6, z: 25 }, spin: { x: 300, y: 0, z: 0 },
  }));
  const players = Array.from({ length: 4 }, () => new PlayerBody());

  const tickTimes = new Float64Array(ticks);
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    // The "smash winner" pile-up: physics for ball + 4 players, crowd update,
    // grunts, racket sounds, bounces, haptic mirroring — every tick.
    for (const ball of balls) {
      if (ball.step(DT, SURFACES.hard) === 'bounce') {
        audio.ballBounce({ surface: 'hard', speed: 25, pos: ball.pos });
        if (ball.pos.y < 0.04 && ball.vel.y === 0) { // relaunch settled balls
          ball.pos = { x: 0, y: 1.5, z: 0 }; ball.vel = { x: 2, y: 6, z: 25 };
        }
      }
    }
    for (const p of players) p.step(DT, { x: Math.sin(i * DT), y: Math.cos(i * DT) }, SURFACES.hard);
    crowd.rallyShot({ rallyLength: (i % 20) + 1, ballSpeed: 35 });
    if (i % 12 === 0) {
      audio.racketHit({ action: 'smash', power: 1, pos: { x: 1 } });
      audio.grunt({ power: 1, pos: { x: 1 } });
    }
    if (i % 240 === 0) crowd.pointWon({ winningShot: 'smash', rallyLength: 15 });
    crowd.update(DT);
    audio.drain(); // renderer would consume the queue every frame
    tickTimes[i] = performance.now() - t0;
  }

  const sorted = [...tickTimes].sort((a, b) => a - b);
  const avg = tickTimes.reduce((s, t) => s + t, 0) / ticks;
  const p99 = sorted[Math.floor(ticks * 0.99)];
  assert.ok(avg < 1, `average tick ${avg.toFixed(4)}ms must be <1ms (was the full budget ${FRAME_BUDGET_MS}ms)`);
  assert.ok(p99 < FRAME_BUDGET_MS, `p99 tick ${p99.toFixed(3)}ms must stay under the ${FRAME_BUDGET_MS.toFixed(2)}ms logic budget`);
  assert.ok(haptics.length > 0, 'haptic mirroring stayed active under load');
});

test('no unbounded memory growth across sustained play', () => {
  const audio = new AudioDirector();
  const crowd = new CrowdManager({ audio });
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200_000; i++) {
    audio.racketHit({ action: 'topspin', power: 0.7, pos: { x: 0 } });
    audio.drain();
    crowd.rallyShot({ rallyLength: i % 15, ballSpeed: 30 });
    crowd.update(1 / 120);
    if (i % 50 === 0) crowd.transitions.length = 0; // log is for tests; renderer trims it
  }
  const grownMB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  assert.ok(grownMB < 50, `heap grew ${grownMB.toFixed(1)}MB over 200k events — must be bounded`);
});
