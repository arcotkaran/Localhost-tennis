// Reactive AI: decides dynamically from ball trajectory (via the real
// physics predictor), spin, and court positioning. Scalable difficulty.

import { Ball, simulateFlight, SURFACES, COURT } from './physics.js';

// Deterministic PRNG so AI matches are reproducible in tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class AIPlayer {
  // difficulty 0..1 scales reaction quality, placement and error rate.
  constructor({ difficulty = 0.7, traits = {}, rng = mulberry32(42) } = {}) {
    this.difficulty = difficulty;
    this.traits = {
      topspin: 1.0,       // spin generation multiplier
      serveSpeed: 1.0,    // service velocity multiplier
      power: 1.0,
      speed: 1.0,         // court coverage
      ...traits,
    };
    this.rng = rng;
  }

  // Predict where the incoming ball will land using the actual physics sim.
  predictLanding(ballState, surface = SURFACES.hard) {
    const ball = new Ball({
      pos: { ...ballState.pos }, vel: { ...ballState.vel },
      spin: { ...(ballState.spin ?? { x: 0, y: 0, z: 0 }) },
    });
    const res = simulateFlight(ball, surface);
    if (!res) return null;
    // Imperfect read at lower difficulty: jitter the prediction.
    const jitter = (1 - this.difficulty) * 0.9;
    return {
      x: res.landing.x + (this.rng() - 0.5) * 2 * jitter,
      z: res.landing.z + (this.rng() - 0.5) * 2 * jitter,
      flightTime: res.flightTime,
    };
  }

  // Movement decision: head for the predicted intercept point.
  decideMovement(ballState, selfPos, surface) {
    const target = this.predictLanding(ballState, surface);
    if (!target) return { x: 0, y: 0 };
    const dx = target.x - selfPos.x;
    const dz = target.z - selfPos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.15) return { x: 0, y: 0 };
    return { x: dx / d, y: dz / d }; // joystick-style unit vector
  }

  // Shot decision from ball height/position and both players' court positions.
  // ballAtContact: { pos, vel } at the moment of the swing; selfPos/oppPos: {x,z}.
  chooseShot(ballAtContact, selfPos, oppPos) {
    const ballHeight = ballAtContact.pos.y;
    const distToNet = Math.abs(selfPos.z);
    const pulledWide = Math.abs(selfPos.x) > COURT.singlesWidth / 2 - 0.5;
    const halfLen = COURT.length / 2;

    let action;
    if (ballHeight > 1.9 && distToNet < halfLen * 0.55) {
      action = 'smash';                  // high sitter inside the court — kill it
    } else if (distToNet < 3.5) {
      action = 'volley';                 // at the net — punch it
    } else if (pulledWide && ballHeight < 1.0) {
      action = this.rng() < 0.5 ? 'slice' : 'lob';   // defensive escape
    } else if (oppPos && Math.abs(oppPos.z) < 4 && ballHeight < 1.2) {
      action = 'lob';                    // opponent crowding the net — go over
    } else {
      action = this.rng() < 0.55 * this.traits.topspin ? 'topspin' : 'flat';
    }

    // Target the open court: hit away from where the opponent stands.
    const openX = oppPos
      ? (oppPos.x >= 0 ? -1 : 1) * (COURT.singlesWidth / 2 - 0.6)
      : (this.rng() - 0.5) * COURT.singlesWidth * 0.8;
    const accuracy = 0.4 + 0.6 * this.difficulty;
    return {
      action,
      target: {
        x: openX * accuracy + (this.rng() - 0.5) * (1 - accuracy) * 3,
        z: action === 'lob' ? halfLen * 0.85 : halfLen * (0.55 + 0.35 * this.rng()),
      },
      power: this.traits.power * (action === 'smash' ? 1.0 : 0.6 + 0.3 * this.rng()),
      spin: action === 'topspin' ? 320 * this.traits.topspin
          : action === 'slice' ? -250
          : 0,
    };
  }

  // Probability this AI wins a given point against `other` — used by the
  // headless match simulator; derived from difficulty and traits.
  pointStrength() {
    return this.difficulty *
      (0.85 + 0.05 * this.traits.power + 0.05 * this.traits.serveSpeed + 0.05 * this.traits.speed);
  }
}

// Headless point-by-point match simulation between two AIs (no rendering).
// Serve advantage and trait-driven strength decide each point via seeded RNG.
export function simulateMatch(aiA, aiB, { bestOf = 5, rng = mulberry32(7) } = {}) {
  const { MatchScore } = scoringModule;
  const score = new MatchScore({ bestOf });
  const events = [];
  let guard = 0;
  while (!score.completed && guard++ < 100_000) {
    const server = score.server;
    const sA = aiA.pointStrength() + (server === 0 ? 0.12 * aiA.traits.serveSpeed : 0);
    const sB = aiB.pointStrength() + (server === 1 ? 0.12 * aiB.traits.serveSpeed : 0);
    const pA = sA / (sA + sB);
    const team = rng() < pA ? 0 : 1;
    events.push(...score.pointWon(team));
  }
  if (!score.completed) throw new Error('match never completed — scoring bug');
  return { score, events };
}

// Lazy import to avoid a circular dependency at module load.
import * as scoringModule from './scoring.js';
