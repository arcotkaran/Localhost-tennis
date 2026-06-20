// End-to-end feature sweep driven by the phone-controller simulator.
// Run: node tools/e2e.mjs
//
// Exercises serve flow, every shot, movement (incl. quick direction changes),
// placement/angles, scoring, doubles and sensitivity — then prints a report
// flagging anything that smells like a bug. This is a DIAGNOSTIC, not a gate;
// the assertions live in tests/.

import { GameDirector } from '../shared/game-director.js';
import { Ball, COURT } from '../shared/physics.js';
import { gestureToShot } from '../shared/gestures.js';
import { HeadlessMatch, SimPhone, GESTURES } from './phone-sim.mjs';

const HALF_LEN = COURT.length / 2;            // 11.885 baseline
const HALF_SINGLES = COURT.singlesWidth / 2;  // 4.115 singles sideline
const HALF_WIDTH = COURT.width / 2;           // 5.485 doubles sideline
const issues = [];
const note = (sev, area, msg) => { issues.push({ sev, area, msg }); console.log(`  [${sev}] ${area}: ${msg}`); };
const ok = (area, msg) => console.log(`  ok   ${area}: ${msg}`);

// ---------------------------------------------------------------------------
// 1) SERVE: does a struck serve that LANDS ON THE COURT ever get called fault,
//    and how often does a human serve fault at all? ("looks in but says fault")
// ---------------------------------------------------------------------------
function serveOnce({ side, power, aim, seed = 7 }) {
  const d = new GameDirector({ mode: 'single', seed });
  d.attachSlot(0);
  d.score.server = 0;                       // team 0 (the human, slot 0) serves
  d.score.points = side === 'ad' ? [1, 0] : [0, 0]; // deuce (even) vs ad (odd)
  d.positionForServe();
  const serverZ = d.currentServer().body.pos.z;

  d.update(1 / 120);                        // emit serve_ready
  d.handleInput(0, { action: 'lob' });      // tap → toss
  d.update(1 / 120);                        // toss rises → serve_toss
  // Strike with an explicit power/aim (what a swipe of that pace/angle yields).
  d.handleInput(0, { action: 'flat', aim, power });
  d.update(1 / 120);                        // strike → rally

  const ev = [];
  for (let i = 0; i < 360; i++) {           // ~3s
    d.update(1 / 120);
    ev.push(...d.drainEvents());
    if (ev.some(e => e.type === 'fault') || ev.filter(e => e.type === 'bounce').length >= 1) {
      // give the same tick's fault a chance to be drained
      d.update(1 / 120); ev.push(...d.drainEvents());
      break;
    }
  }
  const bounce = ev.find(e => e.type === 'bounce')?.pos ?? null;
  const faulted = ev.some(e => e.type === 'fault');
  const t = d.serveTarget;
  const inBox = bounce && t &&
    Math.sign(bounce.z) === t.dir && Math.abs(bounce.z) <= COURT.serviceLine &&
    Math.sign(bounce.x) === t.xSign && Math.abs(bounce.x) <= HALF_SINGLES;
  const onCourt = bounce &&
    Math.sign(bounce.z) !== Math.sign(serverZ) &&  // crossed the net
    Math.abs(bounce.z) <= HALF_LEN && Math.abs(bounce.x) <= HALF_WIDTH;
  return { bounce, faulted, inBox, onCourt };
}

function serveBattery() {
  console.log('\n# 1. Serve is skill-based (angle + speed), not a fault %');
  // A serve that bounces INSIDE the box must never be called a fault (logic bug).
  let inBoxButFault = 0;
  for (const side of ['deuce', 'ad']) for (const power of [0.4, 0.55, 0.7, 0.85, 1.0]) for (const aim of [-1, -0.5, 0, 0.5, 1]) {
    const r = serveOnce({ side, power, aim });
    if (r.faulted && r.inBox) inBoxButFault++;
  }
  if (inBoxButFault > 0) note('HIGH', 'serve', `${inBoxButFault} serves bounced INSIDE the box yet faulted — logic bug`);
  else ok('serve', 'no in-box serve is ever wrongly faulted');

  // Casual / sensible serves land IN; faults appear only when you over-aim or
  // over-hit — and the outcome is deterministic (no random fault percentage).
  const casualIn = ['deuce', 'ad'].every(side => [0.4, 0.55, 0.7].every(p =>
    [-0.5, -0.25, 0, 0.25].every(a => !serveOnce({ side, power: p, aim: a }).faulted)));
  if (casualIn) ok('serve', 'sensible serves (≤0.7 power, modest aim) always land in');
  else note('MED', 'serve', 'some sensible serves fault — too punishing');

  const overAim = serveOnce({ side: 'deuce', power: 0.6, aim: -1 }).faulted;   // aim at/over the line
  const overHit = serveOnce({ side: 'deuce', power: 1.0, aim: 0 }).faulted;     // bomb it flat
  if (overAim && overHit) ok('serve', 'over-aiming faults wide and over-hitting faults long (skill matters)');
  else note('LOW', 'serve', `aggression should risk a fault (over-aim fault=${overAim}, over-hit fault=${overHit})`);

  const det = [1, 2, 3, 9].every(seed =>
    serveOnce({ side: 'deuce', power: 0.9, aim: -0.6, seed }).faulted === serveOnce({ side: 'deuce', power: 0.9, aim: -0.6, seed: 7 }).faulted);
  if (det) ok('serve', 'human serve is deterministic across seeds (no fault dice)');
  else note('HIGH', 'serve', 'human serve outcome varies with seed — there is hidden randomness');
}

// ---------------------------------------------------------------------------
// 2) MOVEMENT: quick / short direction changes. How long to reverse, and how
//    far does a short flick the other way actually move you?
// ---------------------------------------------------------------------------
function movementTest() {
  console.log('\n# 2. Movement & quick direction change');
  const m = new HeadlessMatch({ mode: 'single', seed: 1 });
  const phone = m.joinPhone();
  m.director.state = 'rally';               // freeze serve repositioning
  phone.setSensitivity(0.85); m.send(phone, phone.move(1, 0));
  m.send(phone, phone.move(1, 0)); m.step(0.5);
  const vRight = m.director.players[0].body.vel.x;

  // Now slam left and measure reversal latency.
  m.send(phone, phone.move(-1, 0));
  let reverseT = null, overshoot = 0;
  const x0 = m.director.players[0].body.pos.x;
  for (let i = 0; i < 120; i++) {
    m.send(phone, phone.move(-1, 0)); m.step(1 / 120);
    const v = m.director.players[0].body.vel.x;
    overshoot = Math.max(overshoot, m.director.players[0].body.pos.x - x0);
    if (reverseT === null && v < 0) reverseT = (i + 1) / 120;
  }
  console.log(`  top speed (sens .85): ${vRight.toFixed(2)} m/s; reverse latency: ${reverseT?.toFixed(3) ?? 'never'}s; overshoot past turn point: ${overshoot.toFixed(2)} m`);

  // A SHORT flick: 90 ms right, then 90 ms left, then release. Net drift should
  // be near zero if quick direction changes are responsive.
  const m2 = new HeadlessMatch({ mode: 'single', seed: 1 });
  const p2 = m2.joinPhone(); m2.director.state = 'rally';
  const sx = m2.director.players[0].body.pos.x;
  for (let i = 0; i < 11; i++) { m2.send(p2, p2.move(1, 0)); m2.step(1 / 120); }
  for (let i = 0; i < 11; i++) { m2.send(p2, p2.move(-1, 0)); m2.step(1 / 120); }
  m2.send(p2, p2.stop()); m2.step(0.4);
  const drift = m2.director.players[0].body.pos.x - sx;
  console.log(`  short flick right-then-left net drift: ${drift.toFixed(2)} m (≈0 = responsive; large + = momentum carried you right)`);

  if (reverseT !== null && reverseT > 0.25) note('MED', 'movement', `reversing direction takes ${reverseT.toFixed(2)}s — feels sluggish for quick adjustments`);
  if (overshoot > 0.6) note('MED', 'movement', `you slide ${overshoot.toFixed(2)} m the wrong way before reversing — hard to make a short direction change`);
  if (Math.abs(drift) > 0.4) note('MED', 'movement', `a quick right-left flick still drifts ${drift.toFixed(2)} m — short direction changes don't cleanly cancel`);
  if ((reverseT ?? 1) <= 0.25 && overshoot <= 0.6 && Math.abs(drift) <= 0.4) ok('movement', 'quick direction changes are responsive');
}

// ---------------------------------------------------------------------------
// 3) PLACEMENT / sharp angles: can a swipe place the ball sharply cross-court?
// ---------------------------------------------------------------------------
function placementTest() {
  console.log('\n# 3. Shot placement & angles');
  function landX(aim) {
    const d = new GameDirector({ mode: '1v1', seed: 6 });
    d.attachSlot(0);
    const p = d.players[0]; p.body.pos = { x: 0, z: 6 };
    d.ball = new Ball({ pos: { x: 0, y: 1.0, z: 6 }, vel: { x: 0, y: 0, z: 6 } });
    d.hit(p, 'flat', aim, 0.8);
    let landing = null;
    for (let i = 0; i < 1500; i++) if (d.ball.step(1 / 120, d.surface) === 'bounce') { landing = { ...d.ball.pos }; break; }
    return landing?.x ?? null;
  }
  const right = landX(1), left = landX(-1), center = landX(0);
  console.log(`  aim -1 → x=${left?.toFixed(2)}, aim 0 → x=${center?.toFixed(2)}, aim +1 → x=${right?.toFixed(2)} (singles edge ±${HALF_SINGLES.toFixed(2)})`);
  const spread = (right ?? 0) - (left ?? 0);
  if (spread < 3) note('MED', 'placement', `full left↔right aim only spreads the ball ${spread.toFixed(2)} m — sharp angles feel muted`);
  else ok('placement', `aim spreads the ball ${spread.toFixed(2)} m across the court`);
}

// ---------------------------------------------------------------------------
// 4) SHOT MAPPING sanity (the new tap=lob / up=drive / down=slice scheme).
// ---------------------------------------------------------------------------
function mappingTest() {
  console.log('\n# 4. Swipe → shot mapping');
  const cases = [
    ['tap', GESTURES.tapLob, 'lob'],
    ['slow up', GESTURES.topspin, 'topspin'],
    ['fast up', GESTURES.flat, 'flat'],
    ['down', GESTURES.slice, 'slice'],
  ];
  for (const [label, g, want] of cases) {
    const got = gestureToShot(g).action;
    if (got !== want) note('HIGH', 'mapping', `${label} → ${got}, expected ${want}`);
    else ok('mapping', `${label} → ${got}`);
  }
}

// ---------------------------------------------------------------------------
// 5) FULL MATCHES complete and score sanely (single + 2v2 doubles).
// ---------------------------------------------------------------------------
function matchTest() {
  console.log('\n# 5. Full match completion');
  for (const mode of ['single', '1v1', '2v2']) {
    const m = new HeadlessMatch({ mode, surface: 'hard', bestOf: 3, seed: 11 });
    // Leave all seats to AI to verify the engine runs a full match unaided.
    let t = 0; for (; t < 1800 && m.state !== 'finished'; t += 1 / 120) m.step(1 / 120);
    if (m.state !== 'finished') note('HIGH', 'match', `${mode} did not finish in 1800s`);
    else ok('match', `${mode} completed; sets ${JSON.stringify(m.score.setsWon)}`);
  }
}

// ---------------------------------------------------------------------------
// 6) DOUBLES: both partners can hit (no permanent double-swing lockout).
// ---------------------------------------------------------------------------
function doublesTest() {
  console.log('\n# 6. Doubles — both partners participate');
  const m = new HeadlessMatch({ mode: '2v2', seed: 3 });
  const hitters = new Set();
  let t = 0;
  for (; t < 120 && m.state !== 'finished'; t += 1 / 120) {
    m.step(1 / 120);
    for (const e of m.drain()) if (e.type === 'hit') hitters.add(e.player);
  }
  const team0Hitters = [...hitters].filter(i => m.director.players[i].team === 0);
  console.log(`  distinct hitters seen: ${[...hitters].sort().join(',')}`);
  if (team0Hitters.length < 2) note('LOW', 'doubles', `only player(s) ${team0Hitters} on team 0 ever hit in 120s — partner may be idle`);
  else ok('doubles', 'both partners on a team take shots');
}

// ---------------------------------------------------------------------------
// 7) SENSITIVITY: higher slider → faster top speed (per-player).
// ---------------------------------------------------------------------------
function sensitivityTest() {
  console.log('\n# 7. Per-player movement sensitivity');
  function topSpeed(sens) {
    const m = new HeadlessMatch({ mode: '1v1', seed: 1 });
    const phone = m.joinPhone(); m.director.state = 'rally';
    for (let i = 0; i < 360; i++) { m.send(phone, { ...phone.move(1, 0), sens }); m.step(1 / 120); }
    return Math.hypot(m.director.players[0].body.vel.x, m.director.players[0].body.vel.z);
  }
  const slow = topSpeed(0.5), fast = topSpeed(1.1);
  console.log(`  sens 0.5 → ${slow.toFixed(2)} m/s; sens 1.1 → ${fast.toFixed(2)} m/s`);
  if (fast > slow + 1) ok('sensitivity', 'the slider meaningfully changes top speed');
  else note('HIGH', 'sensitivity', 'the sensitivity slider barely changes speed');
}

console.log('=== Local Tennis — end-to-end feature sweep (phone simulator) ===');
serveBattery();
movementTest();
placementTest();
mappingTest();
matchTest();
doublesTest();
sensitivityTest();

console.log('\n=== SUMMARY ===');
if (!issues.length) console.log('No issues flagged.');
else {
  const order = { HIGH: 0, MED: 1, LOW: 2 };
  for (const i of issues.sort((a, b) => order[a.sev] - order[b.sev])) console.log(`  [${i.sev}] ${i.area}: ${i.msg}`);
}
console.log(`\n${issues.length} issue(s) flagged.`);
