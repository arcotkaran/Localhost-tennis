import { GameDirector } from '../shared/game-director.js';
import { COURT, Ball } from '../shared/physics.js';
import { HeadlessMatch } from './phone-sim.mjs';

const SL = COURT.serviceLine, HSW = COURT.singlesWidth / 2, HW = COURT.width / 2, HL = COURT.length / 2;

// Strike a HUMAN serve with a given aim (angle) + power (speed); report outcome.
function humanServe({ power, aim, side = 'deuce', team = 0, seed = 7 }) {
  const d = new GameDirector({ mode: '1v1', seed });
  d.attachSlot(team);
  d.score.server = team;
  d.score.points = side === 'ad' ? [1, 0] : [0, 0];
  d.positionForServe();
  const serverZ = d.currentServer().body.pos.z;
  d.update(1 / 120);
  d.handleInput(team, { action: 'lob' });          // toss
  d.update(1 / 120);
  d.handleInput(team, { action: 'flat', aim, power }); // strike
  d.update(1 / 120);
  const ev = [];
  for (let i = 0; i < 500; i++) { d.update(1 / 120); ev.push(...d.drainEvents()); if (ev.some(e => e.type === 'fault' || e.type === 'point' || e.type === 'hit' && e.rallyLength >= 1)) break; }
  const fault = ev.find(e => e.type === 'fault');
  const bounce = ev.find(e => e.type === 'bounce')?.pos ?? null;
  if (!fault) return 'IN ';
  return { net: 'net', long: 'long', wide: 'wide', 'long & wide': 'l&w', out: 'out' }[fault.detail] ?? 'out';
}

console.log('=== SKILL-BASED SERVE MAP (human, deuce court) — IN vs fault reason ===');
const aims = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5];
process.stdout.write('  power\\aim  ' + aims.map(a => String(a).padStart(5)).join('') + '\n');
for (const power of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
  let row = '  ' + power.toFixed(2).padStart(8) + '  ';
  for (const aim of aims) row += humanServe({ power, aim }).padStart(5);
  console.log(row);
}

// Determinism: same aim+power must give the same result regardless of seed (no dice).
let deterministic = true;
for (const seed of [1, 2, 3, 99]) if (humanServe({ power: 0.6, aim: -0.3, seed }) !== humanServe({ power: 0.6, aim: -0.3, seed: 7 })) deterministic = false;
console.log(`\n  human serve deterministic across seeds (no random fault): ${deterministic}`);

// Casual serve should always land in.
console.log(`  casual serve (power 0.55, aim 0): ${humanServe({ power: 0.55, aim: 0 }).trim()}`);

// AI fault behaviour by difficulty (skill = precision, not a flat %).
console.log('\n=== AI serve in-rate by difficulty (faults emerge from precision) ===');
function aiServe(seed, difficulty) {
  const d = new GameDirector({ mode: '1v1', seed, difficulty });
  let landed = null, faulted = false;
  for (let i = 0; i < 1200 && !landed && !faulted; i++) {
    d.update(1 / 120);
    for (const e of d.drainEvents()) { if (e.type === 'fault') faulted = true; if (e.type === 'bounce' && !landed && !faulted) landed = e.pos; }
  }
  return faulted;
}
for (const difficulty of [0.4, 0.72, 0.95]) {
  let faults = 0, n = 60;
  for (let s = 1; s <= n; s++) if (aiServe(s, difficulty)) faults++;
  console.log(`  difficulty ${difficulty}: ${faults}/${n} first deliveries faulted`);
}
