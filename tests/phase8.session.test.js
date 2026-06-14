// Testing Gate 8: TV session flow.
// Headless runs of the complete session state machine: quick matches that
// return to the menu, full tournaments from bracket to trophy, fast match
// formats, and the cinematic sequences (entry, racket taps, trophy) firing
// at the right moments with sane world positions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionController, FORMATS, actorPose } from '../shared/session.js';
import { MatchScore } from '../shared/scoring.js';
import { ROSTER } from '../shared/roster.js';
import { COURT } from '../shared/physics.js';

const DT = 1 / 120;

function run(session, predicate, maxSeconds = 3600) {
  const collected = [];
  for (let t = 0; t < maxSeconds; t += DT) {
    session.update(DT);
    collected.push(...session.drainEvents());
    if (predicate(collected, t)) return { events: collected, elapsed: t };
  }
  return { events: collected, elapsed: maxSeconds, timedOut: true };
}

// ---------- formats ----------

test('short formats are valid scoring configurations', () => {
  for (const [name, f] of Object.entries(FORMATS)) {
    const s = new MatchScore({ bestOf: f.bestOf, gamesPerSet: f.gamesPerSet, tiebreakAt: f.tiebreakAt });
    assert.ok(s, `${name} constructs`);
  }
  const short = new MatchScore({ bestOf: 1, gamesPerSet: 4, tiebreakAt: 4 });
  const winGame = team => { for (let i = 0; i < 4; i++) short.pointWon(team); };
  for (let g = 0; g < 4; g++) winGame(0);
  assert.equal(short.completed, true, 'short set: 4-0 ends the match');
  assert.equal(short.winner, 0);
});

test('short-set 4-4 still goes to a tiebreak', () => {
  const s = new MatchScore({ bestOf: 1, gamesPerSet: 4, tiebreakAt: 4 });
  const winGame = team => { for (let i = 0; i < 4; i++) s.pointWon(team); };
  for (let i = 0; i < 4; i++) { winGame(0); winGame(1); }
  assert.equal(s.inTiebreak, true);
  for (let i = 0; i < 7; i++) s.pointWon(1);
  assert.equal(s.completed, true);
  assert.deepEqual(s.sets, [[4, 5]]);
});

// ---------- quick match flow ----------

test('quick match: menu → entry cinematic → match → handshake → menu', () => {
  const session = new SessionController({ seed: 31 });
  session.startQuickMatch({ mode: '1v1', surface: 'hard', format: 'short' });
  assert.equal(session.state, 'entry', 'entry cinematic plays first');

  const entry = session.drainEvents().find(e => e.type === 'entry');
  assert.ok(entry.sequence.timeline.some(i => i.clip === 'walk_on'), 'players walk on');

  const { events, timedOut } = run(session, evs => evs.some(e => e.type === 'quick_match_end'), 1200);
  assert.ok(!timedOut, 'short-format quick match completes');
  assert.ok(events.some(e => e.type === 'match_start'), 'match began after the entry');
  const end = events.find(e => e.type === 'quick_match_end');
  assert.ok(end.sequence.timeline.some(i => i.clip === 'net_handshake'), 'post-match handshake scheduled');

  const { events: after, timedOut: t2 } = run(session, evs => evs.some(e => e.type === 'menu'), 30);
  assert.ok(!t2 && after.some(e => e.type === 'menu'), 'session returns to the menu');
  assert.equal(session.state, 'menu');
});

test('doubles points trigger partner racket taps', () => {
  const session = new SessionController({ seed: 8 });
  session.startQuickMatch({ mode: '2v2', surface: 'hard', format: 'short' });
  const { events, timedOut } = run(session,
    evs => evs.some(e => e.type === 'interaction'), 600);
  assert.ok(!timedOut, 'a doubles point produced an interaction');
  const tap = events.find(e => e.type === 'interaction');
  assert.ok(tap.sequence.timeline.every(i => i.clip === 'racket_tap'));
  assert.equal(tap.sequence.timeline.length, 2, 'both partners tap');
});

test('inputs are ignored during cinematics, accepted during play', () => {
  const session = new SessionController({ seed: 4 });
  session.startQuickMatch({ mode: '1v1', surface: 'hard', format: 'short' });
  session.attachSlot(0);
  session.handleInput(0, { action: 'smash' }); // during the entry walk-on
  assert.equal(session.director.players[0].armed, null, 'no swings during the walk-on');
  run(session, evs => evs.some(e => e.type === 'match_start'), 60);
  session.handleInput(0, { action: 'smash' });
  assert.equal(session.director.players[0].armed?.action, 'smash', 'armed once play starts');
});

// ---------- tournament flow ----------

test('full 4-entrant tournament: bracket → matches → champion trophy → menu', () => {
  const session = new SessionController({ seed: 77 });
  const entrants = ROSTER.slice(0, 4).map(p => ({ ...p }));
  session.startTournament({ entrants, surface: 'grass', format: 'short' });
  assert.equal(session.state, 'bracket');
  const first = session.drainEvents().find(e => e.type === 'bracket');
  assert.equal(first.round, 'Semifinals', '4 entrants start at the semis');

  let matchesPlayed = 0;
  const allEvents = [];
  while (session.state === 'bracket' && matchesPlayed < 10) {
    session.beginNextTournamentMatch();
    assert.equal(session.state, 'entry');
    matchesPlayed++;
    const { events, timedOut } = run(session,
      () => session.state === 'bracket' || session.state === 'trophy', 1200);
    allEvents.push(...events);
    assert.ok(!timedOut, `tournament match ${matchesPlayed} completed`);
  }
  assert.equal(matchesPlayed, 3, '4-entrant cup is exactly 3 matches');
  assert.equal(session.state, 'trophy');

  const champ = allEvents.find(e => e.type === 'champion');
  assert.ok(champ, 'champion event fired');
  assert.ok(entrants.some(p => p.id === champ.entrant.id), 'champion is a real entrant');
  assert.ok(champ.sequence.timeline.some(i => i.clip === 'trophy_lift'), 'trophy lift scheduled');
  assert.equal(champ.standings[0].id, champ.entrant.id, 'champion tops the standings');
  assert.equal(champ.standings[0].wins, 2, 'champion won semi + final');

  run(session, evs => evs.some(e => e.type === 'menu'), 30);
  assert.equal(session.state, 'menu', 'back to menu after the celebration');
});

test('tournament scores are recorded on the bracket as real set scores', () => {
  const session = new SessionController({ seed: 55 });
  session.startTournament({ entrants: ROSTER.slice(0, 2).map(p => ({ ...p })), surface: 'clay', format: 'short' });
  session.drainEvents();
  session.beginNextTournamentMatch();
  const { events } = run(session, evs => evs.some(e => e.type === 'champion'), 1200);
  const champ = events.find(e => e.type === 'champion');
  const final = champ.bracket.at(-1).matches[0];
  assert.match(final.score, /^\d+-\d+/, `bracket shows the set score (${final.score})`);
});

test('illegal transitions are rejected', () => {
  const session = new SessionController();
  assert.throws(() => session.beginNextTournamentMatch(), /cannot begin/);
  session.startQuickMatch({ mode: '1v1', surface: 'hard', format: 'short' });
  assert.throws(() => session.startQuickMatch({ mode: '1v1', surface: 'hard' }), /cannot start/);
  assert.throws(() => session.startTournament({ entrants: [] }), /cannot start/);
});

// ---------- cinematic positioning ----------

test('walk-on path: from the tunnel to each team\'s baseline', () => {
  const item = { clip: 'walk_on', at: 0, duration: 3 };
  const start = actorPose(item, 0, 0, null);
  const end = actorPose(item, 3, 0, null);
  assert.ok(Math.abs(start.x) > COURT.width / 2, 'starts off-court');
  assert.ok(Math.abs(end.x) < 0.01 && Math.abs(end.z - (COURT.length / 2 - 1.5)) < 0.01, 'ends at the baseline');
  const endTeam1 = actorPose(item, 3, 1, null);
  assert.ok(endTeam1.z < 0, 'team 1 walks to the far side');
});

test('net handshake converges both actors at the net, then shakes', () => {
  const item = { clip: 'net_handshake', at: 0, duration: 2.5 };
  const a = actorPose(item, 2.4, 0, null);
  const b = actorPose(item, 2.4, 1, null);
  assert.ok(Math.abs(a.z) < 1.2 && Math.abs(b.z) < 1.2, 'both at the net');
  assert.ok(Math.abs(a.x - b.x) < 2, 'face to face');
  assert.equal(a.pose, 'shake');
  assert.equal(actorPose(item, 0.2, 0, null).pose, 'walk', 'walks first');
});

test('racket tap: out to the partner and back home', () => {
  const item = { clip: 'racket_tap', at: 0, duration: 1.0 };
  const home = { x: -2.2, z: COURT.length / 2 - 1.5 };
  const mid = actorPose(item, 0.5, 0, home);
  const done = actorPose(item, 1.0, 0, home);
  assert.equal(mid.pose, 'tap');
  assert.ok(Math.abs(mid.x - home.x) > 0.5, 'moved toward the partner');
  assert.ok(Math.abs(done.x - home.x) < 0.01, 'returned home');
});

test('trophy lift centers the champion', () => {
  const pose = actorPose({ clip: 'trophy_lift', at: 0, duration: 3 }, 1.5, 0, null);
  assert.equal(pose.pose, 'lift');
  assert.ok(Math.abs(pose.x) < 0.01 && Math.abs(pose.z) < 3, 'celebrating center court');
});
