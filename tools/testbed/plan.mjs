// THE canonical test plan — one source of truth, run by BOTH front-ends:
//   • the headless runner (tools/testbed/run.mjs → `npm run testbed`) for a fast,
//     deterministic sweep + BUGREPORT.md;
//   • the live 2D Test Lab (client_host/lab.html) which ANIMATES the recorded
//     frames so you can watch each shot/serve/move as it's judged.
//
// Every case drives the REAL GameDirector through the same gesture → handleInput
// contract a phone uses (via the shared SimPhone/gestureToShot), with the flight
// recorder ON. A case returns:
//   { pass, expected, measured, frames?, log }
// where `frames` is an optional list of world snapshots (ball + players) so the
// lab can replay exactly the shot it judged, and `log` is the trace slice that
// explains the verdict. Cases are pure & deterministic (fixed seeds).

import { GameDirector } from '../../shared/game-director.js';
import { Ball, COURT } from '../../shared/physics.js';
import { gestureToShot } from '../../shared/gestures.js';
import { HeadlessMatch, GESTURES } from '../phone-sim.mjs';

const DT = 1 / 120;
const HALF_LEN = COURT.length / 2;            // 11.885 baseline
const HALF_SINGLES = COURT.singlesWidth / 2;  // 4.115 singles sideline
const round2 = v => Math.round(v * 100) / 100;

// A world snapshot for the 2D replay: ball + every player, plus the sim state.
export function snapshot(d) {
  return {
    state: d.state,
    ball: d.ball ? { x: round2(d.ball.pos.x), y: round2(d.ball.pos.y), z: round2(d.ball.pos.z) } : null,
    players: d.players.map(p => ({ x: round2(p.body.pos.x), z: round2(p.body.pos.z), team: p.team, human: p.controlledBySlot !== null })),
  };
}

// Step a director, sampling a snapshot every other frame (keeps replays light),
// collecting events, until `until(d, events)` or maxSteps. Returns { frames, events }.
function record(d, { maxSteps = 700, sampleEvery = 2, until = null, capFrames = 1400 } = {}) {
  const frames = [];
  const events = [];
  for (let i = 0; i < maxSteps; i++) {
    if (i % sampleEvery === 0 && frames.length < capFrames) frames.push(snapshot(d));
    d.update(DT);
    events.push(...d.drainEvents());
    if (until && until(d, events)) break;
  }
  frames.push(snapshot(d)); // final resting frame
  return { frames, events };
}

// ---- serve: drive a human serve through the real toss→strike flow ----
export function serveScenario({ side = 'deuce', power = 0.6, aim = 0, seed = 7, surface = 'hard' } = {}) {
  const d = new GameDirector({ mode: 'single', surface, seed, log: true });
  d.attachSlot(0);
  d.score.server = 0;                                  // the human (slot 0) serves
  d.score.points = side === 'ad' ? [1, 0] : [0, 0];    // even → deuce, odd → ad
  d.positionForServe();
  d.update(DT);                                        // serve_ready
  d.handleInput(0, { action: 'lob' });                 // TAP → toss
  d.update(DT);                                        // toss rises → serve_toss
  d.handleInput(0, { action: 'flat', aim, power });    // SWIPE → strike
  const { frames, events } = record(d, {
    maxSteps: 500,
    until: (dd, ev) => ev.some(e => e.type === 'fault' || e.type === 'point') ||
                       (dd.ball && dd.ball.bounces >= 1 && !dd.awaitingServeBounce),
  });
  const fault = events.find(e => e.type === 'fault');
  const result = d.log.entries({ type: 'serve_result' })[0] ?? null;
  return {
    d, frames,
    faulted: !!fault,
    detail: fault ? fault.detail : 'in',
    inBox: result ? result.inBox : null,
    log: d.log.entries(),
  };
}

// ---- groundstroke: feed a ball to a human and let the REAL input→tryHits→hit
// path strike it, then record the outgoing flight to its bounce. Pass either a
// `gesture` (the real swipe→shot mapping) OR explicit { action, aim, power }. ----
export function shotScenario({ gesture, action, aim, power, playerZ = 6, ballY = 1.3, ballZ = 5, seed = 6, surface = 'hard' } = {}) {
  const d = new GameDirector({ mode: 'single', surface, seed, log: true });
  d.attachSlot(0);
  const p = d.players[0];                       // team 0, defends z > 0
  d.setState('rally', 'test_setup');
  p.body.pos = { x: 0, z: playerZ };
  p.body.vel = { x: 0, z: 0 };
  // A ball drifting onto the player from in front (vel.z > 0 → coming to team 0).
  d.ball = new Ball({ pos: { x: 0, y: ballY, z: ballZ }, vel: { x: 0, y: 0.5, z: 3 } });
  d.ball.bounces = 1;                            // already in play (not a serve)
  d.lastHitTeam = 1;
  d.rallyLength = 1;
  const shot = gesture ? gestureToShot(gesture) : { action: action ?? 'flat', aimX: aim ?? 0, power: power ?? 0.7 };
  d.handleInput(0, { action: shot.action, aim: shot.aimX, power: shot.power });
  const { frames, events } = record(d, {
    maxSteps: 600,
    until: (dd, ev) => {
      const myHit = ev.find(e => e.type === 'hit' && e.player === 0);
      // stop a few frames after our shot bounces (so the marker is captured)
      return myHit && (ev.some(e => e.type === 'bounce' && e.rallyLength === undefined) || dd.ball?.bounces >= 1);
    },
  });
  const myHit = events.find(e => e.type === 'hit' && e.player === 0);
  const shotLog = d.log.entries({ type: 'shot' }).find(e => e.player === 0) ?? null;
  // Landing = first bounce after our hit.
  const bounce = events.find(e => e.type === 'bounce');
  return {
    d, frames,
    struckAction: myHit ? myHit.action : null,
    intendedAction: shot.action,
    landing: shotLog ? shotLog.predictedLanding : (bounce ? { x: round2(bounce.pos.x), z: round2(bounce.pos.z) } : null),
    log: d.log.entries(),
  };
}

// ---- movement drill: hold the joystick a direction for a while, record path ----
export function movementScenario({ dx = 1, dy = 0, sens = 0.85, seconds = 1.2, seed = 1 } = {}) {
  const m = new HeadlessMatch({ mode: 'single', seed, log: true });
  const phone = m.joinPhone(); m.director.setState('rally', 'test_setup');
  phone.setSensitivity(sens);
  const frames = []; const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { m.send(phone, { ...phone.move(dx, dy), sens }); m.step(DT); if (i % 2 === 0) frames.push(snapshot(m.director)); }
  frames.push(snapshot(m.director));
  const v = m.director.players[0].body.vel;
  return { d: m.director, frames, topSpeed: Math.hypot(v.x, v.z), log: m.director.log.entries() };
}

// Re-export so a single import of the plan gives the lab everything it needs.
export { GESTURES, COURT };

// ---------------------------------------------------------------------------
// CASE LIST — grouped by area. Each: { id, area, title, severity, record?, run }
// run() returns { pass, expected, measured, frames?, log? }. `severity` is how
// bad a FAILURE is (HIGH/MED/LOW). `record:true` cases feed the lab animation.
// ---------------------------------------------------------------------------
export const CASES = [
  // ----- SERVE (skill-based: angle + speed decide in/out, no fault %) -----
  {
    id: 'serve.deuce_in', area: 'serve', title: 'Controlled serve (0.6 power, centre) lands IN',
    severity: 'HIGH', record: true,
    run() { const r = serveScenario({ power: 0.6, aim: 0 }); return { pass: r.detail === 'in', expected: 'in', measured: r.detail, frames: r.frames, log: r.log }; },
  },
  {
    id: 'serve.wide', area: 'serve', title: 'Over-aiming at the line serves WIDE (skill matters)',
    severity: 'MED', record: true,
    run() { const r = serveScenario({ power: 0.6, aim: -1 }); return { pass: r.detail === 'wide', expected: 'wide', measured: r.detail, frames: r.frames, log: r.log }; },
  },
  {
    id: 'serve.long', area: 'serve', title: 'Bombing it flat (1.0 power) overcooks LONG',
    severity: 'MED', record: true,
    run() { const r = serveScenario({ power: 1.0, aim: 0 }); return { pass: r.detail === 'long', expected: 'long', measured: r.detail, frames: r.frames, log: r.log }; },
  },
  {
    id: 'serve.no_false_fault', area: 'serve', title: 'A serve that bounces IN the box is never called fault',
    severity: 'HIGH',
    run() {
      let bad = 0, total = 0;
      for (const side of ['deuce', 'ad']) for (const power of [0.4, 0.55, 0.7, 0.85, 1.0]) for (const aim of [-1, -0.5, 0, 0.5, 1]) {
        const r = serveScenario({ side, power, aim }); total++;
        if (r.faulted && r.inBox) bad++;
      }
      return { pass: bad === 0, expected: '0 in-box serves faulted', measured: `${bad}/${total} contradicted`, };
    },
  },
  {
    id: 'serve.casual_in', area: 'serve', title: 'Sensible serves (≤0.7 power, modest aim) always land in',
    severity: 'MED',
    run() {
      let faults = 0, total = 0;
      for (const side of ['deuce', 'ad']) for (const p of [0.4, 0.55, 0.7]) for (const a of [-0.5, -0.25, 0, 0.25]) {
        total++; if (serveScenario({ side, power: p, aim: a }).faulted) faults++;
      }
      return { pass: faults === 0, expected: '0 faults on sensible serves', measured: `${faults}/${total} faulted` };
    },
  },
  {
    id: 'serve.deterministic', area: 'serve', title: 'Human serve is deterministic across seeds (no fault dice)',
    severity: 'HIGH',
    run() {
      const ref = serveScenario({ power: 0.9, aim: -0.6, seed: 7 }).detail;
      const all = [1, 2, 3, 9].map(seed => serveScenario({ power: 0.9, aim: -0.6, seed }).detail);
      const consistent = all.every(x => x === ref);
      return { pass: consistent, expected: `all '${ref}'`, measured: all.join(',') };
    },
  },
  {
    id: 'serve.double_fault', area: 'serve', title: 'Two faults = double fault, point to the receiver',
    severity: 'HIGH',
    run() {
      const d = new GameDirector({ mode: '1v1', seed: 1, log: true });
      const receiver = 1 - d.score.server;
      const before = d.score.points[receiver];
      for (let n = 0; n < 2; n++) {
        d.serve('flat');
        d.ball.pos = { x: 0, y: 0.18, z: d.serveTarget.dir * 9 }; d.ball.vel = { x: 0, y: -2.5, z: 0 };
        for (let i = 0; i < 400; i++) { const b = d.awaitingServeBounce; d.update(DT); if (b && !d.awaitingServeBounce) break; }
      }
      const got = d.score.points[receiver];
      return { pass: got === before + 1, expected: `receiver +1 point`, measured: `receiver points ${before}→${got}`, log: d.log.entries() };
    },
  },

  // ----- SHOTS (mapping, placement, auto smash/volley) -----
  {
    id: 'shot.lob', area: 'shots', title: 'Tap → LOB, clears the net and lands in',
    severity: 'HIGH', record: true,
    run() {
      const r = shotScenario({ gesture: GESTURES.tapLob, playerZ: 9, ballZ: 8 });
      const land = r.landing;
      const inCourt = land && Math.sign(land.z) === -1 && Math.abs(land.z) <= HALF_LEN && Math.abs(land.x) <= HALF_SINGLES + 0.5;
      return { pass: r.struckAction === 'lob' && inCourt, expected: 'lob lands in opponent court', measured: `${r.struckAction} → ${land ? `(${land.x},${land.z})` : 'no bounce'}`, frames: r.frames, log: r.log };
    },
  },
  {
    id: 'shot.topspin', area: 'shots', title: 'Slow up-swipe → TOPSPIN drive, lands in',
    severity: 'HIGH', record: true,
    run() {
      const r = shotScenario({ gesture: GESTURES.topspin });
      const inCourt = r.landing && Math.abs(r.landing.z) <= HALF_LEN && Math.abs(r.landing.x) <= HALF_SINGLES;
      return { pass: r.struckAction === 'topspin' && inCourt, expected: 'topspin lands in', measured: `${r.struckAction} → ${r.landing ? `(${r.landing.x},${r.landing.z})` : 'none'}`, frames: r.frames, log: r.log };
    },
  },
  {
    id: 'shot.flat', area: 'shots', title: 'Fast up-swipe → FLAT bullet, lands in',
    severity: 'HIGH', record: true,
    run() {
      const r = shotScenario({ gesture: GESTURES.flat });
      const inCourt = r.landing && Math.abs(r.landing.z) <= HALF_LEN && Math.abs(r.landing.x) <= HALF_SINGLES;
      return { pass: r.struckAction === 'flat' && inCourt, expected: 'flat lands in', measured: `${r.struckAction} → ${r.landing ? `(${r.landing.x},${r.landing.z})` : 'none'}`, frames: r.frames, log: r.log };
    },
  },
  {
    id: 'shot.slice', area: 'shots', title: 'Down-swipe → SLICE drop, stays short & in',
    severity: 'MED', record: true,
    run() {
      const r = shotScenario({ gesture: GESTURES.slice });
      const inCourt = r.landing && Math.abs(r.landing.z) <= HALF_LEN && Math.abs(r.landing.x) <= HALF_SINGLES;
      return { pass: r.struckAction === 'slice' && inCourt, expected: 'slice lands in', measured: `${r.struckAction} → ${r.landing ? `(${r.landing.x},${r.landing.z})` : 'none'}`, frames: r.frames, log: r.log };
    },
  },
  {
    id: 'shot.angle_right', area: 'shots', title: 'Up-RIGHT swipe places the ball to the right',
    severity: 'HIGH', record: true,
    run() {
      const r = shotScenario({ gesture: GESTURES.topspinRight });
      return { pass: r.landing && r.landing.x > 1.5, expected: 'lands x > +1.5 (right)', measured: r.landing ? `x=${r.landing.x}` : 'no bounce', frames: r.frames, log: r.log };
    },
  },
  {
    id: 'shot.angle_left', area: 'shots', title: 'Up-LEFT swipe places the ball to the left',
    severity: 'HIGH', record: true,
    run() {
      const r = shotScenario({ gesture: GESTURES.topspinLeft });
      return { pass: r.landing && r.landing.x < -1.5, expected: 'lands x < -1.5 (left)', measured: r.landing ? `x=${r.landing.x}` : 'no bounce', frames: r.frames, log: r.log };
    },
  },
  {
    id: 'shot.smash', area: 'shots', title: 'High ball inside the court auto-upgrades to a SMASH',
    severity: 'MED', record: true,
    run() {
      const r = shotScenario({ gesture: GESTURES.flat, playerZ: 3, ballY: 2.3, ballZ: 2.4 });
      return { pass: r.struckAction === 'smash', expected: 'smash', measured: r.struckAction ?? 'no hit', frames: r.frames, log: r.log };
    },
  },
  {
    id: 'shot.volley', area: 'shots', title: 'Low ball at the net auto-upgrades to a VOLLEY',
    severity: 'MED', record: true,
    run() {
      const r = shotScenario({ gesture: GESTURES.topspin, playerZ: 2.0, ballY: 1.2, ballZ: 1.4 });
      return { pass: r.struckAction === 'volley', expected: 'volley', measured: r.struckAction ?? 'no hit', frames: r.frames, log: r.log };
    },
  },
  {
    id: 'mapping.families', area: 'shots', title: 'Swipe → shot mapping (tap/slow-up/fast-up/down)',
    severity: 'HIGH',
    run() {
      const cases = [['tap', GESTURES.tapLob, 'lob'], ['slow up', GESTURES.topspin, 'topspin'], ['fast up', GESTURES.flat, 'flat'], ['down', GESTURES.slice, 'slice']];
      const wrong = cases.filter(([, g, want]) => gestureToShot(g).action !== want);
      return { pass: wrong.length === 0, expected: 'tap→lob, slow↑→topspin, fast↑→flat, ↓→slice', measured: wrong.length ? wrong.map(([l, g, w]) => `${l}→${gestureToShot(g).action}≠${w}`).join(', ') : 'all correct' };
    },
  },
  {
    id: 'placement.spread', area: 'shots', title: 'Full left↔right aim spreads the ball across the court',
    severity: 'MED',
    run() {
      const lx = a => { const r = shotScenario({ gesture: a < 0 ? GESTURES.topspinLeft : a > 0 ? GESTURES.topspinRight : GESTURES.topspin }); return r.landing?.x ?? 0; };
      const spread = lx(1) - lx(-1);
      return { pass: spread >= 3, expected: 'spread ≥ 3 m', measured: `${round2(spread)} m` };
    },
  },

  // ----- MOVEMENT (reverse latency, short-flick cancel, sensitivity) -----
  {
    id: 'move.reverse', area: 'movement', title: 'Quick direction reversal is responsive (low latency & overshoot)',
    severity: 'MED', record: true,
    run() {
      const m = new HeadlessMatch({ mode: 'single', seed: 1, log: true });
      const phone = m.joinPhone(); m.director.setState('rally', 'test_setup');
      const frames = [];
      const sample = () => frames.push(snapshot(m.director));
      phone.setSensitivity(0.85);
      for (let i = 0; i < 60; i++) { m.send(phone, phone.move(1, 0)); m.step(DT); if (i % 2 === 0) sample(); }
      const x0 = m.director.players[0].body.pos.x; let reverseT = null, overshoot = 0;
      for (let i = 0; i < 120; i++) {
        m.send(phone, phone.move(-1, 0)); m.step(DT); if (i % 2 === 0) sample();
        const v = m.director.players[0].body.vel.x;
        overshoot = Math.max(overshoot, m.director.players[0].body.pos.x - x0);
        if (reverseT === null && v < 0) reverseT = (i + 1) / 120;
      }
      const pass = (reverseT ?? 1) <= 0.25 && overshoot <= 0.6;
      return { pass, expected: 'reverse ≤0.25s, overshoot ≤0.6 m', measured: `reverse ${reverseT?.toFixed(2) ?? 'never'}s, overshoot ${round2(overshoot)} m`, frames, log: m.director.log.entries() };
    },
  },
  {
    id: 'move.short_flick', area: 'movement', title: 'A quick right-then-left flick cancels out (no momentum drift)',
    severity: 'MED', record: true,
    run() {
      const m = new HeadlessMatch({ mode: 'single', seed: 1, log: true });
      const p = m.joinPhone(); m.director.setState('rally', 'test_setup');
      const frames = []; const sx = m.director.players[0].body.pos.x;
      for (let i = 0; i < 11; i++) { m.send(p, p.move(1, 0)); m.step(DT); if (i % 2 === 0) frames.push(snapshot(m.director)); }
      for (let i = 0; i < 11; i++) { m.send(p, p.move(-1, 0)); m.step(DT); if (i % 2 === 0) frames.push(snapshot(m.director)); }
      m.send(p, p.stop()); for (let i = 0; i < 48; i++) { m.step(DT); if (i % 2 === 0) frames.push(snapshot(m.director)); }
      const drift = m.director.players[0].body.pos.x - sx;
      return { pass: Math.abs(drift) <= 0.4, expected: '|drift| ≤ 0.4 m', measured: `${round2(drift)} m`, frames, log: m.director.log.entries() };
    },
  },
  {
    id: 'move.sensitivity', area: 'movement', title: 'Sensitivity slider meaningfully changes top speed',
    severity: 'HIGH',
    run() {
      const top = sens => {
        const m = new HeadlessMatch({ mode: '1v1', seed: 1 }); const phone = m.joinPhone(); m.director.setState('rally', 'test_setup');
        for (let i = 0; i < 360; i++) { m.send(phone, { ...phone.move(1, 0), sens }); m.step(DT); }
        return Math.hypot(m.director.players[0].body.vel.x, m.director.players[0].body.vel.z);
      };
      const slow = top(0.5), fast = top(1.1);
      return { pass: fast > slow + 1, expected: 'fast > slow + 1 m/s', measured: `0.5→${round2(slow)} m/s, 1.1→${round2(fast)} m/s` };
    },
  },

  // ----- FLOW (full matches complete; scoring sane) -----
  ...['single', '1v1', '2v2'].map(mode => ({
    id: `flow.${mode}`, area: 'flow', title: `${mode}: a full AI match completes and scores sanely`,
    severity: 'HIGH',
    run() {
      const m = new HeadlessMatch({ mode, surface: 'hard', bestOf: 3, seed: 11 });
      let t = 0; for (; t < 1800 && m.state !== 'finished'; t += DT) m.step(DT);
      return { pass: m.state === 'finished', expected: 'finished < 1800 s', measured: `${m.state}, sets ${JSON.stringify(m.score.setsWon)}` };
    },
  })),
  {
    id: 'doubles.partners', area: 'flow', title: 'Doubles: both partners on a team take shots',
    severity: 'LOW',
    run() {
      const m = new HeadlessMatch({ mode: '2v2', seed: 3 }); const hitters = new Set();
      for (let t = 0; t < 120 && m.state !== 'finished'; t += DT) { m.step(DT); for (const e of m.drain()) if (e.type === 'hit') hitters.add(e.player); }
      const team0 = [...hitters].filter(i => m.director.players[i].team === 0);
      return { pass: team0.length >= 2, expected: 'both team-0 partners hit', measured: `hitters ${[...hitters].sort().join(',')}` };
    },
  },

  // ----- INTEGRITY (the flight recorder catches contradictions) -----
  {
    id: 'integrity.no_contradictions', area: 'integrity', title: 'No "in-box but fault" contradictions across full matches',
    severity: 'HIGH',
    run() {
      let warns = 0, faults = 0, serves = 0;
      for (const surface of ['hard', 'clay', 'grass']) {
        const d = new GameDirector({ mode: '1v1', surface, bestOf: 3, seed: 23, log: true });
        for (let t = 0; t < 2500 && d.state !== 'finished'; t += DT) { d.update(DT); d.drainEvents(); }
        warns += d.log.entries({ type: 'contradiction' }).length;
        faults += d.log.entries({ type: 'fault' }).length;
        serves += d.log.entries({ type: 'serve' }).length;
      }
      return { pass: warns === 0, expected: '0 contradictions', measured: `${warns} contradiction(s) over ${serves} serves / ${faults} faults` };
    },
  },
];

export const AREAS = [...new Set(CASES.map(c => c.area))];

// Run the whole plan (or one area), synchronously & deterministically. Returns
// rich results — the headless runner formats a report, the lab animates frames.
export function runPlan({ area = null, onCase = null } = {}) {
  const results = [];
  for (const c of CASES) {
    if (area && c.area !== area) continue;
    let out;
    try { out = c.run(); }
    catch (err) { out = { pass: false, expected: c.title, measured: `threw: ${err.message}`, error: String(err.stack || err) }; }
    const result = {
      id: c.id, area: c.area, title: c.title, severity: c.severity ?? 'MED',
      pass: !!out.pass, expected: out.expected ?? '', measured: out.measured ?? '',
      frames: out.frames ?? null, log: out.log ?? null, error: out.error ?? null,
    };
    results.push(result);
    if (onCase) onCase(result);
  }
  return { results, summary: summarize(results) };
}

export function summarize(results) {
  const failed = results.filter(r => !r.pass);
  const bySeverity = { HIGH: 0, MED: 0, LOW: 0 };
  for (const r of failed) bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
  return { total: results.length, passed: results.length - failed.length, failed: failed.length, bySeverity };
}
