// Landscape strategy for the controller.
//
// The gamepad must be landscape. The old approach CSS-rotated the container
// when held portrait, but that rotates the touch coordinate frame too — a
// visual "up" swipe became a sideways drag and the joystick felt wrong.
//
// New approach (what real phone games do):
//   • Android/Chrome: request a true orientation lock when possible.
//   • Everywhere: if the device is portrait, hide the gamepad and show a
//     "rotate your phone" prompt. When the user turns the phone to landscape
//     the layout is natural and touch axes are correct — joystick and swipes
//     behave exactly as seen. No coordinate rotation, ever.

export const ORIENT = {
  ACTIVE: 'active',          // landscape — show the gamepad
  ROTATE_PROMPT: 'rotate',   // portrait — ask the user to turn the phone
};

export function isIOS(userAgent) {
  return /iPhone|iPad|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent)); // iPadOS desktop-mode UA
}

export function isLandscape(env) {
  return env.viewportWidth >= env.viewportHeight;
}

export function canNativeLock(env) {
  return typeof env.requestFullscreen === 'function' &&
    typeof env.orientationLock === 'function' &&
    !isIOS(env.userAgent);
}

// Decide what the controller should show right now.
export function decideOrientation(env) {
  return isLandscape(env) ? ORIENT.ACTIVE : ORIENT.ROTATE_PROMPT;
}

// Best-effort true landscape lock (Android). Safe no-op / catch elsewhere.
// Returns true if a lock was attempted successfully.
export async function tryNativeLock(env) {
  if (!canNativeLock(env)) return false;
  try {
    await env.requestFullscreen();
    await env.orientationLock('landscape');
    return true;
  } catch {
    return false; // user gesture required, or unsupported — the prompt covers it
  }
}

// Wire up reactions to rotation. onChange(state) fires immediately and on
// every resize/orientation change with ORIENT.ACTIVE | ORIENT.ROTATE_PROMPT.
export function watchOrientation(env, addListener, onChange) {
  const fire = () => onChange(decideOrientation(env));
  addListener('resize', fire);
  addListener('orientationchange', fire);
  fire();
  return fire;
}
