// Reactive crowd AI state machine.
//   - hushes to silence before a serve
//   - murmurs/gasps as a rally gets long and fast
//   - erupts for smash winners
//   - pushes momentum shifts to mobile controllers as haptic pulses
//
// States: silent → murmur → tense → (gasp) → eruption → murmur ...

import { HAPTIC_PATTERNS } from '../../shared/protocol.js';

export const CROWD_STATE = {
  SILENT: 'silent', MURMUR: 'murmur', TENSE: 'tense', GASP: 'gasp', ERUPTION: 'eruption',
};

const GASP_RALLY_LENGTH = 8;     // shots
const GASP_BALL_SPEED = 28;      // m/s — high-speed exchange
const ERUPTION_DURATION = 4.0;   // seconds of cheering after a winner
const GASP_DURATION = 0.8;

export class CrowdManager {
  // sendHaptic(pattern) bridges crowd momentum to every connected phone.
  constructor({ sendHaptic = () => {}, audio = null } = {}) {
    this.state = CROWD_STATE.MURMUR;
    this.intensity = 0.3;
    this.timer = 0;
    this.sendHaptic = sendHaptic;
    this.audio = audio;
    this.transitions = []; // log for tests/replays
  }

  setState(state, intensity = this.intensity) {
    if (state === this.state) return;
    this.state = state;
    this.intensity = intensity;
    this.transitions.push({ state, intensity });
    if (this.audio) {
      const mood = { silent: 'silence', murmur: 'murmur', tense: 'murmur', gasp: 'gasp', eruption: 'cheer' }[state];
      this.audio.crowd(mood, intensity);
    }
  }

  // --- event hooks from the game loop ---

  preServe() {
    // Crowd settles to complete silence before the toss.
    this.setState(CROWD_STATE.SILENT, 0);
  }

  rallyShot({ rallyLength, ballSpeed }) {
    if (this.state === CROWD_STATE.SILENT && rallyLength >= 1) {
      this.setState(CROWD_STATE.MURMUR, 0.3); // serve is in play — quiet murmur returns
    }
    if (rallyLength >= GASP_RALLY_LENGTH && ballSpeed >= GASP_BALL_SPEED) {
      if (this.state !== CROWD_STATE.GASP) {
        this.setState(CROWD_STATE.GASP, Math.min(1, 0.5 + rallyLength / 30));
        this.timer = GASP_DURATION;
        // Momentum pulse to every phone during the white-knuckle rally.
        this.sendHaptic(HAPTIC_PATTERNS.crowdRoar);
      }
    } else if (rallyLength >= GASP_RALLY_LENGTH / 2 && this.state === CROWD_STATE.MURMUR) {
      this.setState(CROWD_STATE.TENSE, 0.45);
    }
  }

  pointWon({ winningShot, rallyLength, isPressurePoint = false }) {
    const big = winningShot === 'smash' || rallyLength >= GASP_RALLY_LENGTH || isPressurePoint;
    const intensity = big ? 1.0 : 0.55;
    this.setState(CROWD_STATE.ERUPTION, intensity);
    this.timer = ERUPTION_DURATION * intensity;
    if (big) this.sendHaptic(HAPTIC_PATTERNS.crowdRoar);
  }

  // --- per-frame update ---

  update(dt) {
    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.state === CROWD_STATE.GASP) this.setState(CROWD_STATE.TENSE, 0.5);
        else if (this.state === CROWD_STATE.ERUPTION) this.setState(CROWD_STATE.MURMUR, 0.3);
      }
    }
  }
}
