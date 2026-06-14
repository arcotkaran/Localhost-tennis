// Testing Gate 4: gameplay loop.
// Headless automated 5-set AI-vs-AI matches verify scoring edge cases
// (long deuce wars, tiebreak tracking, set transitions); split-screen
// layouts are validated geometrically; the AI is checked for trajectory
// prediction and situational shot selection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchScore } from '../shared/scoring.js';
import { splitScreenLayout } from '../shared/splitscreen.js';
import { AIPlayer, simulateMatch, mulberry32 } from '../shared/ai.js';
import { Ball, simulateFlight, SURFACES } from '../shared/physics.js';

// ---------- scoring unit tests ----------

test('standard game: 15, 30, 40, game', () => {
  const s = new MatchScore();
  assert.equal(s.gameDisplay, '0-0');
  s.pointWon(0); assert.equal(s.gameDisplay, '15-0');
  s.pointWon(0); assert.equal(s.gameDisplay, '30-0');
  s.pointWon(1); assert.equal(s.gameDisplay, '30-15');
  s.pointWon(0); assert.equal(s.gameDisplay, '40-15');
  const events = s.pointWon(0);
  assert.ok(events.some(e => e.type === 'game' && e.team === 0));
  assert.deepEqual(s.games, [1, 0]);
  assert.equal(s.gameDisplay, '0-0', 'points reset after game');
});

test('extensive deuce war: 20 advantage swings before resolution', () => {
  const s = new MatchScore();
  for (let i = 0; i < 3; i++) { s.pointWon(0); s.pointWon(1); }
  assert.equal(s.gameDisplay, 'Deuce');
  for (let i = 0; i < 20; i++) {
    const team = i % 2;
    s.pointWon(team);
    assert.equal(s.gameDisplay, team === 0 ? 'Ad-In' : 'Ad-Out', `swing ${i}`);
    s.pointWon(1 - team);
    assert.equal(s.gameDisplay, 'Deuce', `back to deuce after swing ${i}`);
    assert.deepEqual(s.games, [0, 0], 'no game awarded during deuce war');
  }
  s.pointWon(1);
  const events = s.pointWon(1);
  assert.ok(events.some(e => e.type === 'game' && e.team === 1), 'two clear points finally win it');
});

test('set requires six games with two clear; 6-5 plays on to 7-5', () => {
  const s = new MatchScore();
  const winGame = team => { for (let i = 0; i < 4; i++) s.pointWon(team); };
  for (let i = 0; i < 5; i++) { winGame(0); winGame(1); } // 5-5
  winGame(0);                                              // 6-5 — not a set
  assert.deepEqual(s.games, [6, 5]);
  assert.equal(s.sets.length, 0, '6-5 must not end the set');
  winGame(0);                                              // 7-5 — set
  assert.deepEqual(s.sets, [[7, 5]]);
  assert.deepEqual(s.setsWon, [1, 0]);
});

test('tiebreak at 6-6: first to 7 by two, with extended 8-6 case', () => {
  const s = new MatchScore();
  const winGame = team => { for (let i = 0; i < 4; i++) s.pointWon(team); };
  for (let i = 0; i < 6; i++) { winGame(0); winGame(1); }
  assert.equal(s.inTiebreak, true, 'tiebreak engages at 6-6');

  // Race to 6-6 in the tiebreak: 7-6 must NOT end it.
  for (let i = 0; i < 6; i++) { s.pointWon(0); s.pointWon(1); }
  assert.equal(s.gameDisplay, '6-6');
  s.pointWon(0);
  assert.equal(s.inTiebreak, true, '7-6 in the breaker is not two clear');
  s.pointWon(0); // 8-6
  assert.equal(s.inTiebreak, false);
  assert.deepEqual(s.sets, [[7, 6]], 'tiebreak set recorded as 7-6');
});

test('server alternates each game and tiebreak hands serve correctly', () => {
  const s = new MatchScore();
  const winGame = team => { for (let i = 0; i < 4; i++) s.pointWon(team); };
  assert.equal(s.server, 0);
  winGame(0);
  assert.equal(s.server, 1);
  winGame(1);
  assert.equal(s.server, 0);
});

test('best-of-5 completes at three sets and locks further scoring', () => {
  const s = new MatchScore({ bestOf: 5 });
  const winGame = team => { for (let i = 0; i < 4; i++) s.pointWon(team); };
  for (let set = 0; set < 3; set++) for (let g = 0; g < 6; g++) winGame(0);
  assert.equal(s.completed, true);
  assert.equal(s.winner, 0);
  assert.equal(s.setsWon[0], 3);
  assert.throws(() => s.pointWon(1), /complete/, 'no points after match end');
});

// ---------- headless AI vs AI 5-set matches ----------

test('headless 5-set AI matches complete with valid scores across seeds', () => {
  for (const seed of [7, 99, 2024, 31337, 555]) {
    const rng = mulberry32(seed);
    const a = new AIPlayer({ difficulty: 0.72, rng: mulberry32(seed + 1) });
    const b = new AIPlayer({ difficulty: 0.70, rng: mulberry32(seed + 2) });
    const { score, events } = simulateMatch(a, b, { bestOf: 5, rng });

    assert.equal(score.completed, true, `seed ${seed}: match completed`);
    assert.ok(score.winner === 0 || score.winner === 1);
    assert.equal(score.setsWon[score.winner], 3, 'winner has exactly 3 sets');
    assert.ok(score.setsWon[1 - score.winner] < 3);
    assert.ok(score.sets.length >= 3 && score.sets.length <= 5);

    for (const [ga, gb] of score.sets) {
      const hi = Math.max(ga, gb), lo = Math.min(ga, gb);
      const validNormal = hi === 6 && hi - lo >= 2;
      const validExtended = hi === 7 && (lo === 5 || lo === 6);
      assert.ok(validNormal || validExtended, `seed ${seed}: invalid set score ${ga}-${gb}`);
    }
    const matchEvents = events.filter(e => e.type === 'match');
    assert.equal(matchEvents.length, 1, 'exactly one match-end event');
  }
});

test('trait asymmetry shows up across many matches (Kyrgios serve wins more)', () => {
  let bigServerWins = 0;
  const N = 60;
  for (let i = 0; i < N; i++) {
    const server = new AIPlayer({ difficulty: 0.7, traits: { serveSpeed: 1.5 }, rng: mulberry32(i) });
    const baseline = new AIPlayer({ difficulty: 0.7, rng: mulberry32(i + 1000) });
    const { score } = simulateMatch(server, baseline, { bestOf: 3, rng: mulberry32(i + 2000) });
    if (score.winner === 0) bigServerWins++;
  }
  assert.ok(bigServerWins > N / 2, `big server won ${bigServerWins}/${N} — traits must matter`);
});

// ---------- AI behaviour ----------

test('AI trajectory prediction matches the actual physics landing point', () => {
  const ai = new AIPlayer({ difficulty: 1.0, rng: mulberry32(5) }); // perfect read
  const state = { pos: { x: 1, y: 1.2, z: -10 }, vel: { x: -2, y: 6, z: 18 }, spin: { x: 250, y: 0, z: 0 } };
  const predicted = ai.predictLanding(state);
  const actual = simulateFlight(new Ball(state), SURFACES.hard);
  assert.ok(Math.abs(predicted.x - actual.landing.x) < 0.05, 'x prediction exact at full difficulty');
  assert.ok(Math.abs(predicted.z - actual.landing.z) < 0.05, 'z prediction exact at full difficulty');
});

test('AI moves toward the predicted intercept', () => {
  const ai = new AIPlayer({ difficulty: 1.0, rng: mulberry32(6) });
  const state = { pos: { x: 0, y: 1.2, z: 0 }, vel: { x: 3, y: 5, z: 14 }, spin: { x: 0, y: 0, z: 0 } };
  const landing = simulateFlight(new Ball(state), SURFACES.hard).landing;
  const selfPos = { x: -3, z: 2 };
  const move = ai.decideMovement(state, selfPos, SURFACES.hard);
  assert.ok(move.x > 0.1, 'moves right toward the landing point');
  assert.equal(Math.sign(move.y), Math.sign(landing.z - selfPos.z), 'moves the correct depth direction');
  assert.ok(Math.hypot(move.x, move.y) <= 1.0001, 'movement is a valid joystick vector');
});

test('AI shot selection is situational: smash, volley, defense, lob', () => {
  const ai = new AIPlayer({ difficulty: 0.9, rng: mulberry32(11) });
  const oppBaseline = { x: 2, z: -11 };

  const smash = ai.chooseShot({ pos: { x: 0, y: 2.6, z: 0 }, vel: {} }, { x: 0, z: 3 }, oppBaseline);
  assert.equal(smash.action, 'smash', 'high ball inside the court gets smashed');
  assert.equal(smash.power, ai.traits.power, 'smash is full power');

  const volley = ai.chooseShot({ pos: { x: 0, y: 1.0, z: 0 }, vel: {} }, { x: 1, z: 2.5 }, oppBaseline);
  assert.equal(volley.action, 'volley', 'low ball at the net is volleyed');

  const wide = ai.chooseShot({ pos: { x: 4.1, y: 0.6, z: 0 }, vel: {} }, { x: 4.1, z: 10 }, oppBaseline);
  assert.ok(['slice', 'lob'].includes(wide.action), 'pulled wide and low → defensive slice or lob');

  const oppAtNet = ai.chooseShot({ pos: { x: 0, y: 0.9, z: 0 }, vel: {} }, { x: 0, z: 11 }, { x: 0, z: -2.5 });
  assert.equal(oppAtNet.action, 'lob', 'opponent crowding the net → lob over');

  assert.ok(Math.sign(smash.target.x) !== Math.sign(oppBaseline.x), 'targets the open court away from opponent');
});

// ---------- split-screen geometry ----------

test('1v1 split: stacked top/bottom full-width bands, never side-by-side', () => {
  for (const [w, h] of [[1920, 1080], [3440, 1440], [1280, 720]]) {
    const { viewports, split } = splitScreenLayout('1v1', w, h);
    assert.equal(viewports.length, 2);
    assert.equal(split, 'horizontal', `${w}x${h}: top/bottom split`);
    assert.ok(viewports.every(v => v.w === w), 'each player gets the full screen width');
    assert.equal(viewports[0].h + viewports[1].h, h);
    assert.equal(viewports[0].y, 0);
    assert.equal(viewports[1].y, h / 2);
    assert.notEqual(viewports[0].team, viewports[1].team);
    const area = viewports.reduce((s, v) => s + v.w * v.h, 0);
    assert.equal(area, w * h, 'no dead pixels, no overlap');
  }
});

test('2v2 doubles: team-wise top-and-bottom with expansive third-person camera', () => {
  const { viewports, split } = splitScreenLayout('2v2', 1920, 1080);
  assert.equal(split, 'horizontal', 'doubles is top-and-bottom by team');
  assert.equal(viewports.length, 2, 'one shared viewport per TEAM');
  assert.equal(viewports[0].y, 0);
  assert.equal(viewports[1].y, 540);
  assert.ok(viewports.every(v => v.w === 1920 && v.h === 540));

  const singlesCam = splitScreenLayout('1v1', 1920, 1080).viewports[0].camera;
  for (const v of viewports) {
    assert.equal(v.camera.type, 'third-person');
    assert.ok(v.camera.fov > singlesCam.fov, 'doubles FOV is wider for partner visibility');
    assert.ok(v.camera.position.z > singlesCam.position.z, 'doubles camera pulled further back');
    assert.ok(v.camera.position.y > singlesCam.position.y, 'doubles camera raised for court overview');
    assert.ok(v.camera.aspect >= 16 / 9, 'expansive landscape aspect per half');
  }
});

test('single-player mode renders one full-screen broadcast view', () => {
  const { viewports } = splitScreenLayout('single', 1920, 1080);
  assert.equal(viewports.length, 1);
  assert.equal(viewports[0].w * viewports[0].h, 1920 * 1080);
});
