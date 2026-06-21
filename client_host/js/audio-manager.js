// Spatial audio event mapping. Pure logic (testable headless): converts
// game events into sample/volume/pitch/pan descriptors; the thin WebAudio
// layer in renderer.js just plays what this returns.

import { COURT } from '../../shared/physics.js';

export const SAMPLES = {
  racket: { flat: 'thwack_flat', topspin: 'thwack_brush', slice: 'thwack_slice', lob: 'thwack_soft', smash: 'thwack_smash', volley: 'thwack_punch' },
  bounce: { grass: 'bounce_grass', clay: 'bounce_clay', hard: 'bounce_hard' },
  grunt: ['grunt_soft', 'grunt_mid', 'grunt_hard'],
  crowd: { cheer: 'crowd_cheer', gasp: 'crowd_gasp', murmur: 'crowd_murmur', silence: null },
  ui: { select: 'ui_select', start: 'ui_start' }, // menu blips so the front-end isn't silent
};

// Stereo pan from court x position: -1 (full left) .. +1 (full right).
export function spatialPan(x) {
  return Math.max(-1, Math.min(1, x / (COURT.width / 2)));
}

export class AudioDirector {
  constructor() {
    this.queue = [];
  }

  emit(desc) {
    this.queue.push(desc);
    return desc;
  }

  drain() {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  // Racket impact: distinct whip per shot type, louder + lower with power.
  racketHit({ action, power, pos }) {
    return this.emit({
      sample: SAMPLES.racket[action] ?? SAMPLES.racket.flat,
      volume: 0.55 + 0.45 * Math.min(1, power),
      pitch: 1.1 - 0.2 * Math.min(1, power),
      pan: spatialPan(pos.x),
    });
  }

  // Bounce timbre tracks the surface.
  ballBounce({ surface, speed, pos }) {
    return this.emit({
      sample: SAMPLES.bounce[surface],
      volume: Math.min(1, 0.3 + speed / 60),
      pitch: 1,
      pan: spatialPan(pos.x),
    });
  }

  // Grunts scale with shot power: louder, harder sample tiers.
  grunt({ power, pos }) {
    const p = Math.min(1, power);
    const tier = p > 0.8 ? 2 : p > 0.45 ? 1 : 0;
    return this.emit({
      sample: SAMPLES.grunt[tier],
      volume: 0.2 + 0.8 * p,
      pitch: 1.05 - 0.15 * p,
      pan: spatialPan(pos.x),
    });
  }

  crowd(mood, intensity = 1) {
    if (mood === 'silence') return this.emit({ sample: null, stopAll: 'crowd', volume: 0 });
    return this.emit({ sample: SAMPLES.crowd[mood], volume: Math.min(1, intensity), pitch: 1, pan: 0 });
  }

  // Front-end UI blips (menu selection, match start) — keeps the menu alive.
  ui(kind = 'select') {
    return this.emit({ sample: SAMPLES.ui[kind] ?? SAMPLES.ui.select, volume: kind === 'start' ? 0.6 : 0.4, pitch: 1, pan: 0 });
  }
}
