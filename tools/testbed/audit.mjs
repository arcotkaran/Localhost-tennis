// FULL-FLOW AUTONOMOUS AUDIT — `node tools/testbed/audit.mjs`
//
// Exhaustively exercises the whole game, menu → play → result, hunting for bugs
// via strict invariants rather than fixed expectations:
//   A. invariant soak — every mode × surface × format over many seeds, checking
//      finite physics, in-bounds players, legal state machine, no softlock /
//      stuck rally, score validity, no flight-recorder contradictions.
//   B. session flow — the real SessionController menu→entry→match→trophy→menu.
//   C. tournaments — full cups to a champion.
//   D. human-driven detail — serve grid, every shot, swing-timing windows,
//      movement, sensitivity, doubles serve rotation, detach-mid-rally.
//   E. mechanics — net cord / out / double-bounce / smash / volley / faults.
// Failures in (A) are re-run WITH the flight recorder so the report carries a
// trace. Also reports "feel" stats (rally length, fault rate, competitiveness).
//
// Findings are grouped by signature (sev|area|key) so one systemic bug doesn't
// flood the report. Exits non-zero if any HIGH finding fires.

import { GameDirector, SERVE_FALLBACK, HUMAN_TOSS_WINDOW, TOSS_STRIKE_DELAY, SERVE_DELAY } from '../../shared/game-director.js';
import { SessionController } from '../../shared/session.js';
import { COURT } from '../../shared/physics.js';
import { ROSTER } from '../../shared/roster.js';
import { serveScenario, shotScenario, movementScenario, GESTURES } from './plan.mjs';
import { gestureToShot } from '../../shared/gestures.js';

const DT = 1 / 120;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const SEEDS_SHORT = arg('seeds', 16);     // per mode×surface for the fast soak
const SEEDS_LONG = arg('long', 6);        // per mode×surface for bestOf3
const MODES = ['single', '1v1', '2v2'];
const SURFACES = ['hard', 'clay', 'grass'];

// ---- findings ----
const findings = new Map(); // signature -> { sev, area, msg, count, sample }
function flag(sev, area, key, msg, sample) {
  const sig = `${sev}|${area}|${key}`;
  const f = findings.get(sig);
  if (f) { f.count++; if (!f.sample && sample) f.sample = sample; }
  else findings.set(sig, { sev, area, key, msg, count: 1, sample: sample ?? null });
}
const finite = (...vs) => vs.every(v => Number.isFinite(v));
const finitePt = p => p && finite(p.x, p.y ?? 0, p.z);

// ===========================================================================
// A. INVARIANT SOAK
// ===========================================================================
const FORMATS = {
  short:   { bestOf: 1, gamesPerSet: 4, tiebreakAt: 4 },
  oneSet:  { bestOf: 1, gamesPerSet: 6, tiebreakAt: 6 },
  bestOf3: { bestOf: 3, gamesPerSet: 6, tiebreakAt: 6 },
};

function soakMatch(mode, surface, fmt, seed, { log = false } = {}) {
  const f = FORMATS[fmt];
  const d = new GameDirector({ mode, surface, bestOf: f.bestOf, seed, log });
  d.score.gamesPerSet = f.gamesPerSet; d.score.tiebreakAt = f.tiebreakAt;
  const ctx = `${mode}/${surface}/${fmt}#${seed}`;

  let t = 0, lastProgressT = 0, prevSetsWon = 0, sawTiebreak = false;
  let serveTossT = null, serveFlightStart = null, hits = 0, points = 0, faults = 0, rallyLensum = 0, rallies = 0;
  const states = new Set();
  let prevState = d.state, maxRally = 0;

  for (; t < 4000 && d.state !== 'finished'; t += DT) {
    d.update(DT);
    states.add(d.state);

    // finite physics
    if (d.ball && !finitePt(d.ball.pos)) { flag('HIGH', 'physics', 'ball_nan', 'ball position became non-finite (NaN/Infinity)', ctx); break; }
    for (const p of d.players) if (!finitePt(p.body.pos)) { flag('HIGH', 'physics', 'player_nan', 'a player position became non-finite', ctx); }

    // players within sane bounds (director clamps to width/2+1.5; allow a hair more)
    for (const p of d.players) if (Math.abs(p.body.pos.x) > COURT.width / 2 + 2 || Math.abs(p.body.pos.z) > COURT.length / 2 + 4) {
      flag('MED', 'movement', 'player_oob', 'a player escaped the play area', `${ctx} p${p.index} (${p.body.pos.x.toFixed(1)},${p.body.pos.z.toFixed(1)})`);
    }

    // legal state machine
    if (!['serve_pending', 'serve_toss', 'rally', 'finished'].includes(d.state)) flag('HIGH', 'state', 'illegal', `illegal state ${d.state}`, ctx);
    prevState = d.state;

    // a serve in toss must resolve (AI strikes at TOSS_STRIKE_DELAY)
    if (d.state === 'serve_toss') { serveTossT ??= t; if (t - serveTossT > HUMAN_TOSS_WINDOW + 1) flag('HIGH', 'serve', 'toss_stuck', 'serve toss never resolved into a strike', ctx); }
    else serveTossT = null;

    // a struck serve must bounce within a second or two
    if (d.awaitingServeBounce) { serveFlightStart ??= t; if (t - serveFlightStart > 3) flag('HIGH', 'serve', 'flight_stuck', 'struck serve never bounced (awaitingServeBounce stuck)', ctx); }
    else serveFlightStart = null;

    maxRally = Math.max(maxRally, d.rallyLength);
    if (d.rallyLength > 500) { flag('HIGH', 'rally', 'runaway', 'rally exceeded 500 shots (never-ending point)', ctx); break; }

    for (const e of d.drainEvents()) {
      if (e.type === 'hit') hits++;
      if (e.type === 'serve') lastProgressT = t;
      if (e.type === 'fault') faults++;
      if (e.type === 'tiebreak_start') sawTiebreak = true;
      if (e.type === 'point') { points++; lastProgressT = t; rallyLensum += d.rallyLength; rallies++; }
    }
    // softlock watchdog: no point/serve for 45 s of play
    if (t - lastProgressT > 45) { flag('HIGH', 'flow', 'softlock', 'no point or serve scored for 45 s — match stalled', ctx); break; }

    // score sanity
    if (d.score.setsWon.some(s => s > d.score.setsToWin)) flag('HIGH', 'score', 'sets_over', 'a team has more sets than needed to win', ctx);
    const sw = d.score.setsWon[0] + d.score.setsWon[1];
    if (sw < prevSetsWon) flag('HIGH', 'score', 'sets_decreased', 'setsWon total decreased', ctx);
    prevSetsWon = sw;
  }

  // completion checks
  if (d.state !== 'finished') { flag('HIGH', 'flow', 'no_finish', `match never finished in 4000 s of sim`, ctx); }
  else {
    if (d.score.winner == null || ![0, 1].includes(d.score.winner)) flag('HIGH', 'score', 'no_winner', 'finished with no valid winner', ctx);
    if (d.score.setsWon[d.score.winner] < d.score.setsToWin) flag('HIGH', 'score', 'winner_short', 'winner does not have enough sets', ctx);
    if (d.log) { const c = d.log.entries({ type: 'contradiction' }); if (c.length) flag('HIGH', 'integrity', 'contradiction', 'flight recorder saw an in-box-but-fault contradiction', ctx); }
  }
  if (hits === 0 && points > 0) flag('MED', 'rally', 'no_hits', 'points were scored but no ball was ever struck (all double faults?)', ctx);

  return { finished: d.state === 'finished', points, faults, hits, maxRally, avgRally: rallies ? rallyLensum / rallies : 0, sawTiebreak, winner: d.score.winner, setsWon: [...d.score.setsWon], dir: d };
}

function auditA() {
  console.log('# A. Invariant soak (every mode × surface × format × seed)');
  let n = 0; const stats = { rally: [], faultRate: [], oneSided: 0, matches: 0 };
  for (const fmt of ['short', 'oneSet', 'bestOf3']) {
    const seeds = fmt === 'short' ? SEEDS_SHORT : SEEDS_LONG;
    for (const mode of MODES) for (const surface of SURFACES) for (let seed = 0; seed < seeds; seed++) {
      const r = soakMatch(mode, surface, fmt, seed); n++;
      stats.matches++; if (r.avgRally) stats.rally.push(r.avgRally);
      const serves = r.points + r.faults; if (serves) stats.faultRate.push(r.faults / Math.max(1, serves));
      // competitiveness: a 'short' match that one team wins without conceding a game is suspiciously one-sided
      if (fmt === 'short' && r.finished && Math.min(...r.setsWon) === 0 && r.maxRally <= 1) stats.oneSided++;
      // re-run a failed config with logging for a trace
      if (!r.finished) { const lr = soakMatch(mode, surface, fmt, seed, { log: true }); attachTrace(`${mode}/${surface}/${fmt}#${seed}`, lr.dir); }
    }
  }
  const avg = a => a.length ? (a.reduce((s, x) => s + x, 0) / a.length) : 0;
  console.log(`  ran ${n} full matches`);
  console.log(`  avg rally length: ${avg(stats.rally).toFixed(2)} shots | avg fault rate: ${(avg(stats.faultRate) * 100).toFixed(1)}%`);
  return stats;
}

const traces = [];
function attachTrace(ctx, dir) {
  if (!dir?.log) return;
  const key = new Set(['state', 'serve_strike', 'serve_result', 'fault', 'point', 'contradiction']);
  traces.push({ ctx, tail: dir.log.entries().filter(e => key.has(e.type)).slice(-14) });
}

// ===========================================================================
// B. SESSION FLOW (the real menu→entry→match→trophy→menu wrapper)
// ===========================================================================
function auditB() {
  console.log('\n# B. Session flow (SessionController, all modes × formats)');
  let ok = 0, total = 0;
  for (const mode of MODES) for (const format of ['short', 'bestOf3']) for (const seed of [1, 2, 3]) {
    total++;
    const s = new SessionController({ seed });
    let crashed = null;
    try { s.startQuickMatch({ mode, surface: 'hard', format }); } catch (e) { crashed = e; }
    if (crashed) { flag('HIGH', 'session', 'start_throw', `startQuickMatch threw: ${crashed.message}`, `${mode}/${format}`); continue; }
    const seen = new Set([s.state]); const evts = [];
    let t = 0; for (; t < 3000 && s.state !== 'menu'; t += DT) { s.update(DT); for (const e of s.drainEvents()) evts.push(e.type); seen.add(s.state); }
    const want = ['entry', 'match', 'trophy'];
    const missing = want.filter(w => !seen.has(w));
    const endedToMenu = s.state === 'menu';
    const hadEnd = evts.includes('quick_match_end');
    if (!endedToMenu) flag('HIGH', 'session', 'no_return_menu', 'session never returned to the menu after a match', `${mode}/${format}#${seed}`);
    else if (missing.length) flag('MED', 'session', 'skip_state', `flow skipped state(s): ${missing.join(',')}`, `${mode}/${format}#${seed}`);
    else if (!hadEnd) flag('MED', 'session', 'no_end_event', 'no quick_match_end event emitted', `${mode}/${format}#${seed}`);
    else ok++;
  }
  console.log(`  ${ok}/${total} full quick-match flows completed menu→…→menu`);
}

// ===========================================================================
// C. TOURNAMENTS (full cup → champion)
// ===========================================================================
function auditC() {
  console.log('\n# C. Tournaments (4 entrants → champion)');
  const entrants = ROSTER.slice(0, 4).map(p => ({ id: p.id, name: p.name, traits: p.traits }));
  let champions = 0, total = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    total++;
    const s = new SessionController({ seed });
    try {
      s.startTournament({ entrants, surface: 'hard', format: 'short', difficulty: 0.72 });
      let champ = null, guard = 0;
      while (s.state !== 'menu' && guard++ < 20) {
        if (s.state === 'bracket') { s.beginNextTournamentMatch(); }
        // play the active match (entry → match → bracket/trophy)
        let t = 0; for (; t < 3000 && (s.state === 'entry' || s.state === 'match' || s.state === 'trophy'); t += DT) {
          s.update(DT); for (const e of s.drainEvents()) if (e.type === 'champion') champ = e.entrant;
          if (s.state === 'bracket') break;
        }
        if (s.state === 'trophy') { for (let k = 0; k < 1200 && s.state === 'trophy'; k++) s.update(DT); }
      }
      if (champ) champions++; else flag('HIGH', 'tournament', 'no_champion', 'cup ended without crowning a champion', `seed#${seed}`);
    } catch (e) { flag('HIGH', 'tournament', 'throw', `tournament threw: ${e.message}`, `seed#${seed}`); }
  }
  console.log(`  ${champions}/${total} tournaments crowned a champion`);
}

// ===========================================================================
// D. HUMAN-DRIVEN DETAIL
// ===========================================================================
async function auditD() {
  console.log('\n# D. Human-driven detail (serve grid, shots, timing, movement, doubles)');

  // Serve grid: deuce/ad × both teams × power × aim → must never be in-box-but-fault.
  let serveGrid = 0, serveBad = 0;
  for (const side of ['deuce', 'ad']) for (const power of [0.4, 0.6, 0.8, 1.0]) for (const aim of [-1, -0.5, 0, 0.5, 1]) {
    serveGrid++;
    const r = serveScenario({ side, power, aim });
    if (r.faulted && r.inBox) { serveBad++; flag('HIGH', 'serve', 'in_box_fault', 'a serve bounced in the box yet was ruled fault', `${side} p${power} a${aim}`); }
  }
  console.log(`  serve grid: ${serveGrid} serves, ${serveBad} in-box-but-fault`);

  // Every shot family lands in & maps correctly.
  for (const [g, want] of [[GESTURES.tapLob, 'lob'], [GESTURES.topspin, 'topspin'], [GESTURES.flat, 'flat'], [GESTURES.slice, 'slice']]) {
    const got = gestureToShot(g).action;
    if (got !== want) flag('HIGH', 'shots', 'mapping', `gesture mapped to ${got}, expected ${want}`, want);
    const r = shotScenario({ gesture: g, playerZ: want === 'lob' ? 9 : 6 });
    const land = r.landing;
    const inCourt = land && Math.abs(land.z) <= COURT.length / 2 && Math.abs(land.x) <= COURT.singlesWidth / 2 + 0.5;
    if (!inCourt) flag('MED', 'shots', 'out', `${want} did not land in the court`, `landing ${land ? `(${land.x},${land.z})` : 'none'}`);
  }

  // Aim spread: left vs right placement must differ meaningfully.
  const lx = a => shotScenario({ gesture: a < 0 ? GESTURES.topspinLeft : GESTURES.topspinRight }).landing?.x ?? 0;
  const spread = lx(1) - lx(-1);
  if (spread < 3) flag('MED', 'shots', 'spread', `aim spread only ${spread.toFixed(2)} m (sharp angles muted)`, `${spread.toFixed(2)}m`);

  // Swing-timing window: a swipe armed and then left to expire (>SWING_WINDOW)
  // before the ball arrives must NOT hit (the press should lapse → a whiff).
  {
    const d = new GameDirector({ mode: 'single', seed: 4 });
    d.attachSlot(0); d.setState('rally', 'test');
    const p = d.players[0]; p.body.pos = { x: 0, z: 6 };
    // arm now, but keep the ball far away for 0.7 s (past SWING_WINDOW 0.45)
    const { Ball } = await importBall();
    d.ball = new Ball({ pos: { x: 0, y: 1.2, z: -2 }, vel: { x: 0, y: 0, z: 0.2 } }); d.ball.bounces = 1; d.lastHitTeam = 1; d.rallyLength = 1;
    d.handleInput(0, { action: 'flat', aim: 0, power: 0.8 });
    let hitWhileExpired = false;
    for (let i = 0; i < 84; i++) { d.update(DT); if (d.drainEvents().some(e => e.type === 'hit' && e.player === 0)) hitWhileExpired = true; }
    if (hitWhileExpired) flag('MED', 'shots', 'stale_swing', 'an expired (stale) swing still struck the ball — timing window not enforced', 'armed+0.7s');
  }

  // Doubles serve rotation: over a 2v2 match BOTH partners of the serving team
  // should serve at some point.
  {
    const d = new GameDirector({ mode: '2v2', seed: 3 });
    const serverIdx = new Set();
    for (let t = 0; t < 1500 && d.state !== 'finished'; t += DT) { d.update(DT); for (const e of d.drainEvents()) if (e.type === 'serve') serverIdx.add(e.player); }
    const team0Servers = [...serverIdx].filter(i => d.players[i]?.team === 0);
    if (team0Servers.length < 2) flag('LOW', 'doubles', 'serve_rotation', `only ${team0Servers.length} distinct server(s) on team 0 — partners may not alternate serve`, team0Servers.join(','));
    console.log(`  doubles distinct servers seen: ${[...serverIdx].sort().join(',')}`);
  }

  // Detach mid-rally: a human leaves; the engine must take over and the match
  // must still complete (no softlock waiting for a gone phone).
  {
    const d = new GameDirector({ mode: '1v1', seed: 8 });
    d.attachSlot(0); d.attachSlot(1);
    for (let t = 0; t < 30 && d.state !== 'finished'; t += DT) d.update(DT);
    d.detachSlot(0); d.detachSlot(1);              // both humans vanish
    let t = 0; for (; t < 2000 && d.state !== 'finished'; t += DT) d.update(DT);
    if (d.state !== 'finished') flag('HIGH', 'resilience', 'detach_softlock', 'match did not complete after both humans detached', 'detach@0.25s');
  }

  // Sensitivity: the slider must move the needle.
  const slow = movementScenario({ sens: 0.5 }).topSpeed, fast = movementScenario({ sens: 1.1 }).topSpeed;
  if (!(fast > slow + 1)) flag('HIGH', 'movement', 'sensitivity', `sensitivity barely changes speed (${slow.toFixed(2)}→${fast.toFixed(2)})`, `${slow.toFixed(1)}/${fast.toFixed(1)}`);
}
async function importBall() { return await import('../../shared/physics.js'); }

// ===========================================================================
// E. MECHANICS EDGE CASES
// ===========================================================================
function auditE() {
  console.log('\n# E. Mechanics edge cases');
  const checks = [
    ['smash', () => shotScenario({ gesture: GESTURES.flat, playerZ: 3, ballY: 2.3, ballZ: 2.4 }).struckAction === 'smash', 'high sitter upgrades to smash'],
    ['volley', () => shotScenario({ gesture: GESTURES.topspin, playerZ: 2.0, ballY: 1.2, ballZ: 1.4 }).struckAction === 'volley', 'net ball upgrades to volley'],
    ['second_serve', () => { const d = new GameDirector({ mode: '1v1', seed: 1 }); d.serve('flat'); d.ball.pos = { x: 0, y: .18, z: d.serveTarget.dir * 9 }; d.ball.vel = { x: 0, y: -2.5, z: 0 }; for (let i = 0; i < 400; i++) { const b = d.awaitingServeBounce; d.update(DT); if (b && !d.awaitingServeBounce) break; } return d.serveNumber === 2 && d.state === 'serve_pending'; }, 'a fault brings a second serve'],
    ['double_fault', () => { const d = new GameDirector({ mode: '1v1', seed: 1 }); const rec = 1 - d.score.server; const b0 = d.score.points[rec]; for (let n = 0; n < 2; n++) { d.serve('flat'); d.ball.pos = { x: 0, y: .18, z: d.serveTarget.dir * 9 }; d.ball.vel = { x: 0, y: -2.5, z: 0 }; for (let i = 0; i < 400; i++) { const b = d.awaitingServeBounce; d.update(DT); if (b && !d.awaitingServeBounce) break; } } return d.score.points[rec] === b0 + 1; }, 'two faults = point to receiver'],
    ['net_fault', () => { const d = new GameDirector({ mode: '1v1', seed: 1, log: true }); d.serve('flat'); d.ball.pos = { x: 0, y: 0.4, z: 0.5 }; d.ball.vel = { x: 0, y: 0.2, z: d.serveTarget.dir * 8 }; for (let i = 0; i < 400; i++) { const before = d.awaitingServeBounce; d.update(DT); if (before && !d.awaitingServeBounce) break; } return d.log.entries({ type: 'fault' }).some(e => e.reason === 'net'); }, 'a serve into the net is a fault'],
    ['serve_no_air_volley', () => { const d = new GameDirector({ mode: '1v1', seed: 1 }); d.serve('flat'); const r = d.players[1]; r.body.pos = { x: d.ball.pos.x, z: d.ball.pos.z }; d.ball.pos = { ...d.ball.pos, y: 1.0 }; d.ball.bounces = 0; const r0 = d.rallyLength; d.tryHits(); return d.rallyLength === r0 && d.awaitingServeBounce; }, 'a serve cannot be volleyed before it bounces'],
  ];
  for (const [key, fn, desc] of checks) {
    let pass = false, err = null;
    try { pass = !!fn(); } catch (e) { err = e; }
    if (err) flag('HIGH', 'mechanics', key, `${desc} — threw: ${err.message}`, key);
    else if (!pass) flag('HIGH', 'mechanics', key, `FAILED: ${desc}`, key);
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${key}: ${desc}`);
  }
}

// ===========================================================================
// RUN
// ===========================================================================
console.log('=== Local Tennis — FULL-FLOW AUTONOMOUS AUDIT ===\n');
const t0 = Date.now();
const feel = auditA();
auditB();
auditC();
await auditD();
auditE();

console.log('\n=== FINDINGS ===');
const all = [...findings.values()].sort((a, b) => ({ HIGH: 0, MED: 1, LOW: 2 }[a.sev] - { HIGH: 0, MED: 1, LOW: 2 }[b.sev]));
if (!all.length) console.log('  ✅ No bugs found — every invariant held across the full sweep.');
else for (const f of all) console.log(`  [${f.sev}] ${f.area}/${f.key}: ${f.msg}  (×${f.count}${f.sample ? `, e.g. ${f.sample}` : ''})`);

if (traces.length) {
  console.log('\n=== TRACES (failed soak configs) ===');
  for (const tr of traces.slice(0, 5)) { console.log(`  · ${tr.ctx}`); for (const e of tr.tail) console.log(`      ${e.type} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['seq', 'frame', 't', 'level', 'type'].includes(k))))}`); }
}

const highs = all.filter(f => f.sev === 'HIGH').reduce((s, f) => s + f.count, 0);
console.log(`\n${all.length} distinct finding(s) · ${highs} HIGH occurrence(s) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(highs > 0 ? 1 : 0);
