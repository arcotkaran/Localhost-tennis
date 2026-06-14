// Maps joystick + action button input into wire messages for the host's
// game state manager. Near-zero latency: messages are built synchronously
// with monotonically increasing sequence numbers and client timestamps for
// server-side lag compensation.

import { MSG, ACTIONS, encode } from '../../shared/protocol.js';

export class InputMapper {
  constructor(now = () => performance.now()) {
    this.seq = 0;
    this.now = now;
  }

  mapMove(move, sens = null) {
    return encode(MSG.INPUT, {
      seq: this.seq++,
      t: this.now(),
      move: { x: round3(move.x), y: round3(move.y) },
      action: null,
      sens: sens == null ? null : round3(sens),
    });
  }

  // aim ∈ [-1, 1] is the swipe's horizontal placement (separate from the
  // movement joystick). move is kept for back-compat / fallback aim.
  mapAction(action, move = { x: 0, y: 0 }, aim = null) {
    if (!ACTIONS.includes(action)) {
      throw new Error(`unknown action "${action}" — must be one of ${ACTIONS.join(', ')}`);
    }
    return encode(MSG.INPUT, {
      seq: this.seq++,
      t: this.now(),
      move: { x: round3(move.x), y: round3(move.y) },
      action,
      aim: aim == null ? null : round3(aim),
    });
  }
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
