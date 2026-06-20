// Swipe → shot mapping for the mobile controller.
//
// Players can't look down at the phone mid-rally, so shots are SWIPES on the
// right side of the screen. The swipe VECTOR does everything at once:
//   • a TAP (no real movement) flicks a LOB up and over the net player
//   • swipe UP / forward = the DRIVE family: a slower swipe is heavy TOPSPIN,
//     a faster one a FLAT bullet
//   • swipe DOWN = a SLICE / drop shot
//   • horizontal component AIMS the ball:   left / right
//   • swipe SPEED sets power (faster = harder)
// So a diagonal up-and-right swipe is a topspin/flat placed to the right, and a
// diagonal down-and-left is a slice placed to the left. All coordinates are in
// the VISUAL landscape frame (+x = right, +y = down).
//
// Only three shot families are exposed (per design): the DRIVE (flat/topspin
// groundstroke), the LOB, and the SLICE (a soft drop shot). Smash and volley
// are still applied automatically by the engine (high ball / at net).

export const SWIPE_MIN_PX = 20;     // below this, it's a tap → a lob
export const AIM_SPAN_PX = 140;     // horizontal px for full left/right aim
export const VERTICAL_RATIO = 0.4;  // dy/dist past this (downward) = a slice
export const FAST_PX_PER_S = 900;   // an up-swipe at/above this flattens topspin → flat
export const POWER_DIV = 2400;      // speed → power scaling
export const POWER_MIN = 0.4;       // softest swipe; a tap-lob sits just above this

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// dx, dy: swipe delta in visual-landscape pixels. durationMs: time of the swipe.
export function gestureToShot({ dx = 0, dy = 0, durationMs = 1 } = {}) {
  const dist = Math.hypot(dx, dy);
  const speed = (dist / Math.max(durationMs, 1)) * 1000; // px/s
  const aimX = clamp(dx / AIM_SPAN_PX, -1, 1);

  // A tap (no real movement) is a LOB aimed straight, at a gentle, in-court pace.
  if (dist < SWIPE_MIN_PX) {
    return { action: 'lob', aimX, power: 0.5, gesture: 'tap' };
  }

  const power = clamp(POWER_MIN + speed / POWER_DIV, POWER_MIN, 1);
  const vert = dy / dist; // -1 = straight up, +1 = straight down

  let action;
  if (vert > VERTICAL_RATIO) {
    action = 'slice';                                  // swipe DOWN → slice / drop shot
  } else {
    // swipe UP / forward (and shallow sideways) → the DRIVE family; a faster
    // swipe flattens the heavy topspin into a flat drive.
    action = speed >= FAST_PX_PER_S ? 'flat' : 'topspin';
  }

  return { action, aimX, power, gesture: action };
}

// The engine turns any forward groundstroke into a volley when the hitter is
// inside this distance of the net (so the player never needs a volley gesture).
export const NET_VOLLEY_DISTANCE = 3.5;

export function applyNetContext(action, distanceToNet) {
  if (distanceToNet <= NET_VOLLEY_DISTANCE && (action === 'flat' || action === 'topspin')) {
    return 'volley';
  }
  return action;
}
