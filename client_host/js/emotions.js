// Player body language & facial expression engine.
//
// Every player carries a mood that colors their idle stance and face, and
// point outcomes fire gestures (fist pumps, slumps, head shakes, arms-up
// celebrations). Pure state machine — the renderer reads moodOf()/gestureOf()
// and expressionFor() to pose meshes and face features.

export const MOODS = {
  NEUTRAL: 'neutral',
  FOCUSED: 'focused',       // pressure points: locked in
  PUMPED: 'pumped',         // just won a point/game
  FRUSTRATED: 'frustrated', // just lost a point / hit out
  DEJECTED: 'dejected',     // losing badly, shoulders down
  VICTORIOUS: 'victorious', // match won
};

// Gesture clips with durations (seconds).
export const GESTURES = {
  fist_pump: 1.2,
  arms_up: 2.2,
  head_shake: 1.1,
  slump: 1.8,
};

const MOOD_DECAY = 4.0; // seconds back to neutral

export class EmotionEngine {
  // teams: team index per player index, e.g. [0, 1] or [0, 1, 0, 1]
  constructor(teams) {
    this.players = teams.map(team => ({
      team, mood: MOODS.NEUTRAL, moodTimer: 0, gesture: null, // { name, t, duration }
    }));
  }

  setMood(i, mood, hold = MOOD_DECAY) {
    const p = this.players[i];
    p.mood = mood;
    p.moodTimer = hold;
  }

  startGesture(i, name) {
    this.players[i].gesture = { name, t: 0, duration: GESTURES[name] };
  }

  // ---- event hooks ----

  pointWon(winningTeam, { big = false, reason = null } = {}) {
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.mood === MOODS.VICTORIOUS) continue;
      if (p.team === winningTeam) {
        this.setMood(i, MOODS.PUMPED);
        this.startGesture(i, big ? 'arms_up' : 'fist_pump');
      } else {
        // Losing the point on your own error stings more.
        this.setMood(i, MOODS.FRUSTRATED);
        this.startGesture(i, reason === 'out' ? 'head_shake' : 'slump');
      }
    }
  }

  pressurePoint() {
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[i].mood === MOODS.NEUTRAL) this.setMood(i, MOODS.FOCUSED, 8);
    }
  }

  // Big momentum swings: a team far behind in sets hangs its head.
  scoreboardPressure(setsWon) {
    const diff = setsWon[0] - setsWon[1];
    if (Math.abs(diff) < 2) return;
    const losing = diff > 0 ? 1 : 0;
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[i].team === losing && this.players[i].mood === MOODS.NEUTRAL) {
        this.setMood(i, MOODS.DEJECTED, 6);
      }
    }
  }

  matchWon(winningTeam) {
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[i].team === winningTeam) {
        this.setMood(i, MOODS.VICTORIOUS, Infinity);
        this.startGesture(i, 'arms_up');
      } else {
        this.setMood(i, MOODS.DEJECTED, Infinity);
        this.startGesture(i, 'slump');
      }
    }
  }

  // ---- per-frame ----

  update(dt) {
    for (const p of this.players) {
      if (p.gesture && (p.gesture.t += dt) >= p.gesture.duration) p.gesture = null;
      if (Number.isFinite(p.moodTimer) && (p.moodTimer -= dt) <= 0 && p.mood !== MOODS.NEUTRAL) {
        p.mood = MOODS.NEUTRAL;
      }
    }
  }

  moodOf(i) { return this.players[i].mood; }

  gestureOf(i) {
    const g = this.players[i].gesture;
    return g ? { name: g.name, t01: g.t / g.duration } : null;
  }
}

// ---- facial expression per mood: brow angle (rad), mouth curve (-1 frown
// .. +1 smile), eye openness (0..1) ----

export function expressionFor(mood) {
  switch (mood) {
    case MOODS.FOCUSED:    return { browAngle: -0.25, mouthCurve: -0.1, eyeOpen: 0.7 };
    case MOODS.PUMPED:     return { browAngle: 0.15, mouthCurve: 0.9, eyeOpen: 1.0 };
    case MOODS.FRUSTRATED: return { browAngle: -0.45, mouthCurve: -0.7, eyeOpen: 0.9 };
    case MOODS.DEJECTED:   return { browAngle: 0.3, mouthCurve: -0.9, eyeOpen: 0.5 };
    case MOODS.VICTORIOUS: return { browAngle: 0.2, mouthCurve: 1.0, eyeOpen: 1.0 };
    default:               return { browAngle: 0, mouthCurve: 0.1, eyeOpen: 1.0 };
  }
}

// ---- gesture body poses (compose with player-model clipPose conventions):
// armSwing = right arm, armLSwing = left arm (negative raises forward/up),
// crouch sinks the body, headTilt pitches the head, bob lifts the body ----

export function gesturePose(name, t01) {
  const t = Math.max(0, Math.min(1, t01));
  const arc = Math.sin(t * Math.PI); // 0 → 1 → 0 (returns to rest)
  switch (name) {
    case 'fist_pump':
      return { armSwing: -2.2 * arc, armLSwing: 0, crouch: -0.04 * arc, headTilt: -0.15 * arc, bob: 0.05 * arc };
    case 'arms_up': {
      const hold = Math.min(1, t * 3) * (t > 0.85 ? (1 - t) / 0.15 : 1); // snap up, hold, release
      return { armSwing: -2.9 * hold, armLSwing: -2.9 * hold, crouch: -0.05 * hold,
               headTilt: -0.25 * hold, bob: Math.abs(Math.sin(t * Math.PI * 3)) * 0.12 * hold };
    }
    case 'head_shake':
      return { armSwing: 0.2 * arc, armLSwing: 0.2 * arc, crouch: 0.05 * arc,
               headTilt: 0.1 * arc, headShake: Math.sin(t * Math.PI * 5) * 0.35 * arc, bob: 0 };
    case 'slump':
      return { armSwing: 0.35 * arc, armLSwing: 0.35 * arc, crouch: 0.22 * arc,
               headTilt: 0.5 * arc, bob: 0 };
    default:
      return { armSwing: 0, armLSwing: 0, crouch: 0, headTilt: 0, bob: 0 };
  }
}
