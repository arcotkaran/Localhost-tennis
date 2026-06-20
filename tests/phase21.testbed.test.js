// Testing Gate 21: the flight recorder + the shared testbed plan.
// The recorder is the diagnostic spine — it must capture a faithful, structured
// trace (and flag contradictions like "bounced in the box but ruled fault"),
// while costing nothing when off. The shared plan (tools/testbed/plan.mjs) is
// the one source of truth the headless runner and the live 2D lab both run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameLog } from '../shared/game-log.js';
import { GameDirector } from '../shared/game-director.js';
import { sanitizeTeamChoice, SHIRT_COLORS, sanitizeEmote, EMOTES } from '../shared/protocol.js';
import { MatchStats, isHighlightPoint } from '../shared/match-stats.js';
import { runPlan, CASES } from '../tools/testbed/plan.mjs';

const DT = 1 / 120;

// ---------- GameLog: a pure, bounded, queryable ring buffer ----------

test('GameLog stamps a monotonic seq, filters, slices, and serializes', () => {
  const log = new GameLog();
  const a = log.push({ type: 'hit', level: 'info' });
  const b = log.push({ type: 'fault', level: 'warn' });
  assert.equal(a.seq, 0);
  assert.equal(b.seq, 1);
  assert.equal(log.size, 2);
  assert.deepEqual(log.entries({ type: 'hit' }).map(e => e.seq), [0]);
  assert.deepEqual(log.entries({ level: 'warn' }).map(e => e.seq), [1]);
  assert.deepEqual(log.entries({ type: ['hit', 'fault'] }).length, 2);
  const mark = log.mark();
  log.push({ type: 'point' });
  assert.deepEqual(log.slice(mark).map(e => e.type), ['point']);
  assert.equal(log.toJSONL().split('\n').length, 3);
});

test('GameLog stays bounded at capacity and feeds live sinks', () => {
  const log = new GameLog({ capacity: 10 });
  const seen = [];
  const off = log.addSink(e => seen.push(e.seq));
  for (let i = 0; i < 25; i++) log.push({ type: 'x' });
  assert.equal(log.size, 10, 'trimmed to capacity');
  assert.equal(seen.length, 25, 'every push reached the sink');
  off();
  log.push({ type: 'x' });
  assert.equal(seen.length, 25, 'unsubscribe stops the sink');
});

// ---------- director: off by default, faithful when on ----------

test('logging is OFF by default — no recorder, no entries, behavior unchanged', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1 });
  assert.equal(d.log, null);
  d.serve('flat');
  for (let i = 0; i < 200; i++) d.update(DT);
  assert.equal(d.log, null, 'still no log object');
});

test('logging ON mirrors every event and records state transitions', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1, log: true });
  d.serve('flat');                                   // serve_pending → rally
  for (let i = 0; i < 60; i++) d.update(DT);
  const types = new Set(d.log.entries().map(e => e.type));
  assert.ok(types.has('serve'), 'the serve event is mirrored into the log');
  assert.ok(types.has('serve_strike'), 'the intended-vs-predicted serve strike is recorded');
  const toRally = d.log.entries({ type: 'state' }).find(e => e.to === 'rally');
  assert.ok(toRally, 'the transition into the rally is logged');
  assert.equal(toRally.reason, 'serve_struck');
});

test('a forced serve fault leaves a readable trace: strike → result(out) → fault', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1, log: true });
  d.serve('flat');
  d.ball.pos = { x: 0, y: 0.18, z: d.serveTarget.dir * 9 };   // long, past the line
  d.ball.vel = { x: 0, y: -2.5, z: 0 };
  for (let i = 0; i < 400; i++) { const b = d.awaitingServeBounce; d.update(DT); if (b && !d.awaitingServeBounce) break; }
  const strike = d.log.entries({ type: 'serve_strike' })[0];
  const result = d.log.entries({ type: 'serve_result' })[0];
  const fault = d.log.entries({ type: 'fault' })[0];
  assert.ok(strike && result && fault, 'all three explanatory entries are present');
  assert.equal(result.inBox, false);
  assert.equal(fault.detail, 'long');
});

test('the contradiction tripwire fires if an in-box serve is ever ruled fault', () => {
  const d = new GameDirector({ mode: '1v1', seed: 1, log: true });
  d.serve('flat');
  // Place the ball squarely INSIDE the target box, then force a fault — exactly
  // the "looked in but FAULT" bug the recorder is meant to catch.
  d.ball.pos = { x: d.serveTarget.xSign * 1.5, y: 0.18, z: d.serveTarget.dir * 3 };
  d.faultServe('out');
  const warns = d.log.entries({ type: 'contradiction' });
  assert.equal(warns.length, 1, 'a contradiction is flagged');
  assert.equal(warns[0].level, 'warn');
  assert.equal(warns[0].what, 'serve_in_box_but_fault');
});

test('a real match logs ZERO contradictions (the in/out accounting is sound)', () => {
  const d = new GameDirector({ mode: '1v1', surface: 'clay', bestOf: 3, seed: 23, log: true });
  for (let t = 0; t < 2500 && d.state !== 'finished'; t += DT) { d.update(DT); d.drainEvents(); }
  assert.equal(d.log.entries({ type: 'contradiction' }).length, 0);
});

// ---------- doubles serve rotation (regression: audit found partners never alternated) ----------

test('doubles partners alternate service games (not the same partner forever)', () => {
  const d = new GameDirector({ mode: '2v2', seed: 1 });
  // team 0 = players 0 & 2; team 1 = players 1 & 3. A team serves every OTHER
  // game, so the partner must rotate on the team's OWN service count.
  const serverIdx = (server, totalGames) => {
    d.score.server = server;
    d.score.games = [Math.ceil(totalGames / 2), Math.floor(totalGames / 2)];
    d.score.sets = [];
    return d.currentServer().index;
  };
  assert.equal(serverIdx(0, 0), 0, 'team0 1st service game → partner A (p0)');
  assert.equal(serverIdx(0, 2), 2, 'team0 2nd service game → partner B (p2)');
  assert.equal(serverIdx(0, 4), 0, 'team0 3rd → back to partner A');
  assert.equal(serverIdx(1, 1), 1, 'team1 1st service game → partner A (p1)');
  assert.equal(serverIdx(1, 3), 3, 'team1 2nd service game → partner B (p3)');
  assert.equal(serverIdx(1, 5), 1, 'team1 3rd → back to partner A');
});

test('doubles: BOTH partners on each team actually serve over a real match', () => {
  const d = new GameDirector({ mode: '2v2', seed: 3 });
  const servers = new Set();
  for (let t = 0; t < 1500 && d.state !== 'finished'; t += DT) { d.update(DT); for (const e of d.drainEvents()) if (e.type === 'serve') servers.add(e.player); }
  for (const team of [0, 1]) {
    const partners = [...servers].filter(i => d.players[i].team === team);
    assert.ok(partners.length >= 2, `both team-${team} partners should serve; saw player(s) ${partners}`);
  }
});

// ---------- 2v2 team & shirt picks (slot→player remap + choice sanitizing) ----------

test('GameDirector honours a valid slotPlayers remap so a phone lands on its chosen team', () => {
  // Default 2v2: slot 1 drives player 1 (team 1). Remap so slot 1 drives player 2 (team 0).
  const d = new GameDirector({ mode: '2v2', seed: 1, slotPlayers: { 0: 0, 1: 2, 2: 1, 3: 3 } });
  assert.equal(d.map.slots[1], 2);
  d.attachSlot(1);
  assert.equal(d.players[2].controlledBySlot, 1, 'slot 1 drives the remapped player');
  assert.equal(d.players[2].team, 0, 'that player is on team 0 — the chosen side');
});

test('GameDirector ignores an invalid slotPlayers remap (must be a permutation)', () => {
  const d = new GameDirector({ mode: '2v2', seed: 1, slotPlayers: { 0: 0, 1: 0, 2: 0, 3: 0 } });
  assert.deepEqual(d.map.slots, { 0: 0, 1: 1, 2: 2, 3: 3 }, 'a non-permutation falls back to the default mapping');
});

test('sanitizeTeamChoice clamps the team and validates the shirt colour', () => {
  assert.deepEqual(sanitizeTeamChoice({ team: 1, color: SHIRT_COLORS[2] }), { team: 1, color: SHIRT_COLORS[2] });
  assert.deepEqual(sanitizeTeamChoice({ team: 9, color: '#nope' }), { team: 0, color: null });
  assert.deepEqual(sanitizeTeamChoice({}), { team: 0, color: null });
});

test('sanitizeEmote passes only known emotes (anything else → null)', () => {
  assert.equal(sanitizeEmote(EMOTES[0]), EMOTES[0]);
  assert.equal(sanitizeEmote('💣'), null);        // not in the palette
  assert.equal(sanitizeEmote('<b>x</b>'), null);  // no arbitrary markup reaches the TV
  assert.equal(sanitizeEmote(undefined), null);
});

// ---------- broadcast match statistics ----------

test('MatchStats classifies aces, winners, unforced errors, double faults & fastest serve', () => {
  const s = new MatchStats();
  // team 0 serves a 180 km/h (50 m/s) ace: serve then an untouched point (rally 0).
  s.consume({ type: 'serve', team: 0, speed: 50 });
  s.consume({ type: 'point', team: 0, reason: 'double_bounce', rallyLength: 0 });
  // team 0 serves again (slower), wins a long rally with a clean winner.
  s.consume({ type: 'serve', team: 0, speed: 40 });
  s.consume({ type: 'point', team: 0, reason: 'double_bounce', rallyLength: 6 });
  // team 1 serves; team 0 wins because team 1 dumped it in the net (team 1 error).
  s.consume({ type: 'serve', team: 1, speed: 45 });
  s.consume({ type: 'point', team: 0, reason: 'net', rallyLength: 3 });
  // team 1 double-faults a point away.
  s.consume({ type: 'double_fault', team: 1 });
  s.consume({ type: 'point', team: 0, reason: 'double_fault', rallyLength: 0 });

  const sum = s.summary();
  assert.equal(sum.teams[0].aces, 1, 'one ace');
  assert.equal(sum.teams[0].winners, 1, 'one groundstroke winner (the ace is not double-counted)');
  assert.equal(sum.teams[1].unforcedErrors, 1, 'the net dump is the loser’s unforced error');
  assert.equal(sum.teams[1].doubleFaults, 1);
  assert.equal(sum.teams[0].fastestServeKmh, Math.round(50 * 3.6), 'fastest serve tracked in km/h');
  assert.equal(sum.teams[0].pointsWon, 4);
  assert.equal(sum.longestRally, 6);
});

test('isHighlightPoint flags pressure points, long rallies, smashes and aces only', () => {
  assert.equal(isHighlightPoint({ isPressurePoint: true }), true, 'pressure point');
  assert.equal(isHighlightPoint({ rallyLength: 9 }), true, 'long rally');
  assert.equal(isHighlightPoint({ winningShot: 'smash', rallyLength: 2 }), true, 'smash winner');
  assert.equal(isHighlightPoint({ reason: 'double_bounce', rallyLength: 0 }), true, 'ace');
  assert.equal(isHighlightPoint({ reason: 'net', rallyLength: 3 }), false, 'ordinary point');
  assert.equal(isHighlightPoint(null), false);
});

test('MatchStats over a real AI match is internally consistent', () => {
  const d = new GameDirector({ mode: '1v1', surface: 'hard', bestOf: 1, seed: 7 });
  d.score.gamesPerSet = 4; d.score.tiebreakAt = 4;       // a quick "short set"
  const stats = new MatchStats();
  for (let t = 0; t < 2000 && d.state !== 'finished'; t += DT) { d.update(DT); stats.consumeAll(d.drainEvents()); }
  const sum = stats.summary();
  assert.equal(d.state, 'finished', 'match completed');
  assert.equal(sum.teams[0].pointsWon + sum.teams[1].pointsWon, sum.totalPoints, 'points reconcile');
  assert.ok(sum.totalPoints > 0 && sum.longestRally >= 0);
  for (const t of [0, 1]) assert.ok(sum.teams[t].fastestServeKmh >= 0 && sum.teams[t].serves >= 0);
});

// ---------- the shared plan is the gate for the testbed itself ----------

test('the shared testbed plan runs clean (every case passes)', () => {
  const { results, summary } = runPlan();
  const failed = results.filter(r => !r.pass);
  assert.equal(summary.failed, 0, failed.length ? 'failures: ' + failed.map(r => `${r.id} (${r.measured})`).join('; ') : '');
  assert.ok(CASES.length >= 20, 'the plan has broad coverage');
});
