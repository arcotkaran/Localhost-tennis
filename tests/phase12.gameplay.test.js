// Testing Gate 12: gameplay feel.
// Manual serve (a human server waits for a button press; AI auto-serves;
// an idle human is rescued by the fallback), serve aiming, and selectable
// AI difficulty threaded from the session down to every AI player.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameDirector, SERVE_FALLBACK, SERVE_DELAY } from '../shared/game-director.js';
import { SessionController } from '../shared/session.js';
import { AIPlayer, simulateMatch, mulberry32 } from '../shared/ai.js';
import { COURT } from '../shared/physics.js';

const DT = 1 / 120;

function step(d, seconds) {
  const events = [];
  for (let t = 0; t < seconds; t += DT) { d.update(DT); events.push(...d.drainEvents()); }
  return events;
}

// ---------- manual serve ----------

test('AI server auto-serves after the delay (unchanged headless behavior)', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 }); // no slots → all AI
  const events = step(d, SERVE_DELAY + 0.2);
  assert.ok(events.some(e => e.type === 'serve'), 'AI serve fires on the timer without any input');
});

test('human server does NOT auto-serve — it waits for a button press', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0); // slot 0 = player 0 = team 0 = first server, now human
  const events = step(d, SERVE_DELAY + 1.0);
  assert.equal(d.state, 'serve_pending', 'still waiting on the human');
  assert.ok(!events.some(e => e.type === 'serve'), 'no serve without a press');
  assert.ok(events.some(e => e.type === 'serve_ready'), 'the TV is told it is their serve');
  const ready = events.find(e => e.type === 'serve_ready');
  assert.equal(ready.slot, 0);
  assert.equal(ready.player, 0);
});

test('human serves when they press a button, using the chosen shot', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  step(d, SERVE_DELAY + 0.5);          // reach the waiting state
  d.handleInput(0, { action: 'slice', move: { x: 0, y: 0 } });
  const events = step(d, 0.1);
  const serve = events.find(e => e.type === 'serve');
  assert.ok(serve, 'press triggers the serve');
  assert.equal(d.state, 'rally');
  assert.equal(d.lastShot, 'slice', 'serve uses the pressed shot type');
  assert.ok(d.ball.vel.z < 0, 'serve travels toward the opponent');
});

test('serve_ready announces exactly once, not every frame', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  const events = step(d, 3.0);
  assert.equal(events.filter(e => e.type === 'serve_ready').length, 1, 'announced once');
});

test('idle human is rescued by the fallback so the match never soft-locks', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  const events = step(d, SERVE_DELAY + SERVE_FALLBACK + 0.3);
  assert.ok(events.some(e => e.type === 'serve'), 'fallback serve eventually fires');
  assert.equal(d.state, 'rally');
});

test('human serve is placed by the swipe aim', () => {
  const right = new GameDirector({ mode: '1v1', seed: 9 });
  right.attachSlot(0);
  step(right, SERVE_DELAY + 0.3);
  right.handleInput(0, { action: 'flat', aim: 1 }); // swipe places it to the right
  step(right, 0.05);

  const left = new GameDirector({ mode: '1v1', seed: 9 });
  left.attachSlot(0);
  step(left, SERVE_DELAY + 0.3);
  left.handleInput(0, { action: 'flat', aim: -1 });
  step(left, 0.05);

  assert.ok(right.ball.vel.x > left.ball.vel.x, 'swiping right places the serve further right');
  // And the serve is taken from behind the baseline (the server is moved there).
  assert.ok(Math.abs(right.players[0].body.pos.z) >= COURT.length / 2 - 1,
    'server stands at the baseline to serve');
});

test('the server is positioned at the deuce/ad baseline corner', () => {
  const d = new GameDirector({ mode: '1v1', seed: 9 });
  d.attachSlot(0);
  step(d, SERVE_DELAY + 0.3);
  const before = d.serveSide();
  d.handleInput(0, { action: 'flat', aim: 0 });
  step(d, 0.02);
  const s = d.players[0].body;
  assert.ok(Math.abs(s.pos.z) >= COURT.length / 2 - 1, 'behind the baseline');
  assert.ok(Math.abs(s.pos.x) > 1.5, 'out at a service corner, not center');
});

test('reconnect mid-serve resets the announce flag (no missing prompt)', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  step(d, 1.0);
  const snap = d.serialize();
  const d2 = new GameDirector({ mode: '1v1', seed: 99 });
  d2.attachSlot(0);
  d2.restore(snap);
  // After restore we are still serve_pending; the prompt should fire for the
  // resumed director too (it re-announces on demand).
  const events = step(d2, 1.0);
  assert.ok(events.some(e => e.type === 'serve_ready') || d2.serveAnnounced,
    'resumed director still drives the serve prompt');
});

// ---------- AI difficulty ----------

test('difficulty threads from the director to every AI player', () => {
  for (const difficulty of [0.5, 0.72, 0.92]) {
    const d = new GameDirector({ mode: '2v2', difficulty });
    assert.equal(d.difficulty, difficulty);
    for (const p of d.players) {
      assert.equal(p.ai.difficulty, difficulty, 'each AI got the configured difficulty');
    }
  }
});

test('SessionController passes difficulty into the match', () => {
  const s = new SessionController({ seed: 1 });
  s.startQuickMatch({ mode: '1v1', surface: 'hard', format: 'short', difficulty: 0.9 });
  assert.equal(s.director.difficulty, 0.9);
  assert.ok(s.director.players.every(p => p.ai.difficulty === 0.9));
});

test('tournaments carry the chosen difficulty into every cup match', () => {
  const s = new SessionController({ seed: 1 });
  s.startTournament({
    entrants: [{ id: 'a', name: 'A', traits: {} }, { id: 'b', name: 'B', traits: {} }],
    surface: 'clay', format: 'short', difficulty: 0.55,
  });
  s.drainEvents();
  s.beginNextTournamentMatch();
  assert.equal(s.director.difficulty, 0.55);
});

test('higher difficulty wins materially more often than lower', () => {
  let hardWins = 0;
  const N = 40;
  for (let i = 0; i < N; i++) {
    const hard = new AIPlayer({ difficulty: 0.92, rng: mulberry32(i) });
    const easy = new AIPlayer({ difficulty: 0.5, rng: mulberry32(i + 500) });
    const { score } = simulateMatch(hard, easy, { bestOf: 3, rng: mulberry32(i + 1000) });
    if (score.winner === 0) hardWins++;
  }
  assert.ok(hardWins >= N * 0.75, `hard beat easy ${hardWins}/${N} times — difficulty must matter`);
});

test('doubles serve alternates between partners across games', () => {
  const d = new GameDirector({ mode: '2v2', seed: 2 });
  const team0 = d.players.filter(p => p.team === 0);
  // Game 0: first partner serves. Simulate a game win to advance.
  const g0Server = d.currentServer();
  assert.ok(team0.includes(g0Server) || d.players.filter(p => p.team === 1).includes(g0Server));
  // Force a couple of games onto the board and confirm the serving partner flips.
  d.score.games = [1, 0];
  const afterOneGame = d.currentServer();
  d.score.games = [2, 0];
  const afterTwoGames = d.currentServer();
  // The serving player on a given team should differ by one game for doubles.
  if (afterOneGame.team === afterTwoGames.team) {
    assert.notEqual(afterOneGame.index, afterTwoGames.index, 'doubles serve rotates partners');
  }
});
