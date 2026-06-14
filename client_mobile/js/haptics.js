// Haptic feedback via Navigator.vibrate() with graceful degradation
// (iOS Safari has no vibrate API — calls become safe no-ops).

import { HAPTIC_PATTERNS } from '../../shared/protocol.js';

export { HAPTIC_PATTERNS };

export class Haptics {
  constructor(navigatorLike) {
    this.nav = navigatorLike;
    this.enabled = typeof navigatorLike?.vibrate === 'function';
  }

  // name: 'standardHit' | 'powerSmash' | 'crowdRoar' — or a raw pattern array
  trigger(name) {
    if (!this.enabled) return false;
    const pattern = Array.isArray(name) ? name : HAPTIC_PATTERNS[name];
    if (!pattern) return false;
    return this.nav.vibrate(pattern) !== false;
  }

  stop() {
    if (this.enabled) this.nav.vibrate(0);
  }
}
