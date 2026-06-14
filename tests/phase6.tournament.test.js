// Testing Gate 6: full end-to-end Tournament loop — menu roster selection
// through bracket progression to the final trophy presentation scene —
// plus roster trait integrity and the pure-simulation exclusions audit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROSTER, getPlayer, MODES } from '../shared/roster.js';
import { Tournament } from '../shared/tournament.js';
import { AIPlayer, simulateMatch, mulberry32 } from '../shared/ai.js';
import { postMatchSequence, CLIPS } from '../client_host/js/interactions.js';

// ---------- roster ----------

test('roster contains the iconic five with unique mechanical traits', () => {
  const names = ROSTER.map(p => p.name);
  for (const expected of ['Roger Federer', 'Novak Djokovic', 'Rafael Nadal', 'Nick Kyrgios', 'Andy Murray']) {
    assert.ok(names.includes(expected), `${expected} must be in the roster`);
  }
  const nadal = getPlayer('nadal');
  const kyrgios = getPlayer('kyrgios');
  assert.ok(nadal.traits.topspin >= 1.3, "Nadal's heavy topspin generation");
  assert.ok(nadal.traits.topspin > Math.max(...ROSTER.filter(p => p.id !== 'nadal').map(p => p.traits.topspin)),
    'Nadal generates the most topspin of anyone');
  assert.ok(kyrgios.traits.serveSpeed >= 1.4, "Kyrgios's massive service velocity");
  assert.ok(kyrgios.traits.serveSpeed > Math.max(...ROSTER.filter(p => p.id !== 'kyrgios').map(p => p.traits.serveSpeed)),
    'Kyrgios has the biggest serve of anyone');
  assert.throws(() => getPlayer('sampras'), /unknown roster player/);
});

test('modes: quick match (single/1v1/2v2) and classic tournament, nothing else', () => {
  assert.deepEqual(Object.keys(MODES).sort(),
    ['quick_1v1', 'quick_2v2', 'quick_single', 'tournament'].sort());
  assert.equal(MODES.quick_2v2.players, 4);
  assert.equal(MODES.quick_2v2.layout, '2v2');
});

// ---------- tournament structure ----------

test('bracket validation: entrant counts and duplicate rejection', () => {
  const e = n => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, name: `E${i}` }));
  assert.throws(() => new Tournament(e(3)), /2, 4, or 8/);
  assert.throws(() => new Tournament(e(5)), /2, 4, or 8/);
  assert.throws(() => new Tournament([{ id: 'x', name: 'X' }, { id: 'x', name: 'X2' }]), /duplicate/);
  const t = new Tournament(e(8));
  assert.equal(t.roundName, 'Quarterfinals');
  assert.equal(t.currentRound.length, 4);
});

test('results validation: only participants can win, no double-reporting', () => {
  const t = new Tournament([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const m = t.nextMatch();
  assert.throws(() => t.reportResult(m, 'z'), /not in this match/);
  const res = t.reportResult(m, 'a');
  assert.equal(res.type, 'champion');
  assert.throws(() => t.reportResult(m, 'b'), /already decided/);
});

// ---------- the full end-to-end integration loop ----------

test('END-TO-END: roster menu → 8-player cup → champion → trophy scene', () => {
  // 1. MENU: session players pick from the roster (5 icons + 3 guest slots,
  //    exactly how a living-room session fills a bracket).
  const guests = [
    { id: 'guest1', name: 'Guest 1', traits: {} },
    { id: 'guest2', name: 'Guest 2', traits: {} },
    { id: 'guest3', name: 'Guest 3', traits: {} },
  ];
  const entrants = [...ROSTER, ...guests];
  assert.equal(entrants.length, 8);

  // 2. CREATE the cup.
  const cup = new Tournament(entrants, { bestOf: 3 });
  assert.equal(cup.roundName, 'Quarterfinals');

  // 3. PLAY every match via the real AI + scoring engines, traits applied.
  const rng = mulberry32(2026);
  let matchesPlayed = 0;
  const roundNames = [];
  while (!cup.champion) {
    roundNames.push(cup.roundName);
    const match = cup.nextMatch();
    assert.ok(match, 'an undecided match must exist while there is no champion');
    const aiA = new AIPlayer({ difficulty: 0.7, traits: match.a.traits, rng: mulberry32(matchesPlayed * 3 + 1) });
    const aiB = new AIPlayer({ difficulty: 0.7, traits: match.b.traits, rng: mulberry32(matchesPlayed * 3 + 2) });
    const { score } = simulateMatch(aiA, aiB, { bestOf: 3, rng });
    assert.equal(score.completed, true, 'every cup match must reach completion');
    const winner = score.winner === 0 ? match.a : match.b;
    cup.reportResult(match, winner.id, score.sets.map(s => s.join('-')).join(' '));
    matchesPlayed++;
    assert.ok(matchesPlayed <= 7, 'an 8-entrant single-elimination cup is exactly 7 matches');
  }

  // 4. VERIFY bracket progression: QF → SF → Final, 7 matches total.
  assert.equal(matchesPlayed, 7);
  assert.deepEqual([...new Set(roundNames)], ['Quarterfinals', 'Semifinals', 'Final']);
  assert.equal(cup.rounds.length, 3);
  assert.equal(cup.rounds[2].length, 1, 'one final');

  // 5. SESSION WIN TRACKING: champion won one match per round; totals add up.
  const standings = cup.standings();
  assert.equal(standings[0].id, cup.champion.id, 'champion tops the session standings');
  assert.equal(cup.sessionWins.get(cup.champion.id), 3, 'champion won QF + SF + Final');
  const totalWins = standings.reduce((s, e) => s + e.wins, 0);
  assert.equal(totalWins, 7, 'every match produced exactly one tracked win');

  // 6. BRACKET RENDER: every decided match exposes winner + score for the TV.
  for (const round of cup.bracket()) {
    for (const m of round.matches) {
      assert.ok(m.winner, 'decided match shows its winner');
      assert.match(m.score, /\d+-\d+/, 'set scores recorded for the bracket view');
    }
  }

  // 7. TROPHY PRESENTATION SCENE: net handshakes, then the champion lifts it.
  const final = cup.rounds[2][0];
  const finalists = [
    { id: final.a.id, team: final.a.id === cup.champion.id ? 0 : 1 },
    { id: final.b.id, team: final.b.id === cup.champion.id ? 0 : 1 },
  ];
  const scene = postMatchSequence(finalists, 0);
  const trophy = scene.timeline.filter(i => i.clip === CLIPS.TROPHY_LIFT);
  assert.equal(trophy.length, 1, 'exactly one trophy lift');
  assert.equal(trophy[0].actor, cup.champion.id, 'the session champion lifts the trophy');
  assert.ok(scene.timeline.some(i => i.clip === CLIPS.NET_HANDSHAKE && i.actor !== cup.champion.id),
    'the runner-up still gets the net handshake');
});

test('tournament outcomes vary across sessions (no rigged bracket)', () => {
  const champions = new Set();
  for (let seed = 0; seed < 12; seed++) {
    const cup = new Tournament(ROSTER.slice(0, 4).map(p => ({ ...p })), { bestOf: 3 });
    const rng = mulberry32(seed * 977 + 13);
    let i = 0;
    while (!cup.champion) {
      const m = cup.nextMatch();
      const aiA = new AIPlayer({ difficulty: 0.7, traits: m.a.traits, rng: mulberry32(seed * 100 + i++) });
      const aiB = new AIPlayer({ difficulty: 0.7, traits: m.b.traits, rng: mulberry32(seed * 100 + i++) });
      const { score } = simulateMatch(aiA, aiB, { bestOf: 3, rng });
      cup.reportResult(m, score.winner === 0 ? m.a.id : m.b.id);
    }
    champions.add(cup.champion.id);
  }
  assert.ok(champions.size >= 2, `12 cups crowned ${champions.size} different champions — must not be deterministic theatre`);
});

// ---------- exclusions audit: pure tennis simulation only ----------

test('no weather, day/night, gear stats, or arcade power-ups anywhere in the codebase', async () => {
  const FORBIDDEN = [/weather/i, /\brain\b/i, /day.?night/i, /power.?up/i, /gear.?stat/i];
  const dirs = ['shared', 'server', 'client_host/js', 'client_mobile/js'];
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const dir of dirs) {
    for (const file of await readdir(join(root, dir))) {
      if (!file.endsWith('.js')) continue;
      const raw = await readFile(join(root, dir, file), 'utf8');
      // Audit the code itself, not comments (which may document the exclusions).
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const pattern of FORBIDDEN) {
        assert.ok(!pattern.test(src), `${dir}/${file} matches forbidden feature ${pattern}`);
      }
    }
  }
});
