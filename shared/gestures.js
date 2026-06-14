// Swipe → shot mapping for the mobile controller.
//
// Players can't look down at the phone mid-rally, so shots are SWIPES on the
// right side of the screen. The swipe VECTOR does everything at once:
//   • vertical component picks the shot:   up = lob, down = slice, else = drive
//   • horizontal component aims the ball:   left / right
//   • swipe SPEED sets power
// So a diagonal swipe down-and-right is a slice placed to the right; a quick
// tap is a controlled drive. All coordinates are in the VISUAL landscape
// frame (+x = right, +y = down).
//
// Only three shots are exposed (per design): DRIVE (forehand/backhand, the
// flat/topspin groundstroke), LOB, and SLICE (a soft drop shot). Smash and
// volley are still applied automatically by the engine (high ball / at net).

export const SWIPE_MIN_PX = 20;     // below this, it's a tap (a controlled drive)
export const AIM_SPAN_PX = 140;     // horizontal px for full left/right aim
export const VERTICAL_RATIO = 0.4;  // |dy|/dist past this = a vertical shot (lob/slice)
export const FAST_PX_PER_S = 900;   // swipe speed that counts as "hard"
export const POWER_DIV = 2600;      // speed → power scaling

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// dx, dy: swipe delta in visual-landscape pixels. durationMs: time of the swipe.
export function gestureToShot({ dx = 0, dy = 0, durationMs = 1 } = {}) {
  const dist = Math.hypot(dx, dy);
  const speed = (dist / Math.max(durationMs, 1)) * 1000; // px/s
  const aimX = clamp(dx / AIM_SPAN_PX, -1, 1);

  // A tap (no real movement) is a controlled drive aimed straight.
  if (dist < SWIPE_MIN_PX) {
    return { action: 'topspin', aimX, power: 0.5, gesture: 'tap' };
  }

  const power = clamp(0.45 + speed / POWER_DIV, 0.45, 1);
  const vert = dy / dist; // -1 = straight up, +1 = straight down

  let action;
  if (vert < -VERTICAL_RATIO) action = 'lob';        // swipe up
  else if (vert > VERTICAL_RATIO) action = 'slice';  // swipe down (drop shot)
  else action = speed >= FAST_PX_PER_S ? 'flat' : 'topspin'; // drive (mostly horizontal)

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
