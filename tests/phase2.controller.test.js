// Testing Gate 2: cross-platform controller hardware & layout.
// Verifies anti-shrink viewport meta, the rotate-to-landscape orientation
// model (no coordinate-breaking CSS rotation), haptic trigger accuracy,
// joystick precision, and input-mapping latency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  decideOrientation, canNativeLock, tryNativeLock, watchOrientation,
  ORIENT, isIOS, isLandscape,
} from '../client_mobile/js/orientation.js';
import { Haptics, HAPTIC_PATTERNS } from '../client_mobile/js/haptics.js';
import { Joystick, DEADZONE } from '../client_mobile/js/joystick.js';
import { InputMapper } from '../client_mobile/js/input-mapper.js';
import { ACTIONS, decode } from '../shared/protocol.js';

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

// ---------- viewport & layout verification (static rendering contract) ----------

test('viewport meta strictly blocks zooming, shrinking, and auto-fit', async () => {
  const html = await readFile(new URL('../client_mobile/index.html', import.meta.url), 'utf8');
  const meta = html.match(/<meta name="viewport" content="([^"]+)"/)?.[1];
  assert.ok(meta, 'viewport meta tag must exist');
  for (const directive of ['user-scalable=no', 'maximum-scale=1.0', 'minimum-scale=1.0', 'viewport-fit=cover', 'width=device-width', 'initial-scale=1.0']) {
    assert.ok(meta.includes(directive), `viewport must declare ${directive}`);
  }
});

test('gamepad layout: floating joystick (move) + swipe zone (hit), no buttons', async () => {
  const html = await readFile(new URL('../client_mobile/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="move-zone"'), 'left-half movement zone present');
  assert.ok(html.includes('id="joystick-base"') && html.includes('id="joystick-thumb"'), 'floating joystick present');
  assert.ok(html.includes('id="swipe-zone"'), 'right-half swipe-to-hit zone present');
  assert.ok(html.includes('id="rotate"'), 'rotate-to-landscape prompt present');
  assert.ok(!/data-action=/.test(html), 'no tap buttons — shots are swipes now');
  assert.ok(html.includes('touch-action: none'), 'touch-action:none prevents browser gesture hijacking');
  assert.ok(html.includes('overscroll-behavior: none'), 'overscroll (pull-to-refresh) disabled');
});

// ---------- orientation: rotate-to-landscape model ----------

test('landscape shows the gamepad; portrait shows the rotate prompt', () => {
  assert.equal(decideOrientation({ viewportWidth: 852, viewportHeight: 393 }), ORIENT.ACTIVE);
  assert.equal(decideOrientation({ viewportWidth: 393, viewportHeight: 852 }), ORIENT.ROTATE_PROMPT);
});

test('Android/Chrome attempts a true native orientation lock', async () => {
  const calls = [];
  const env = {
    userAgent: UA.androidChrome, viewportWidth: 412, viewportHeight: 915,
    requestFullscreen: async () => calls.push('fullscreen'),
    orientationLock: async type => calls.push(`lock:${type}`),
  };
  assert.equal(canNativeLock(env), true);
  assert.equal(await tryNativeLock(env), true);
  assert.deepEqual(calls, ['fullscreen', 'lock:landscape'], 'fullscreen paired with orientation.lock(landscape)');
});

test('iOS cannot native-lock — it relies on the rotate prompt instead', async () => {
  const env = {
    userAgent: UA.iosSafari, viewportWidth: 393, viewportHeight: 852,
    requestFullscreen: null, orientationLock: null,
  };
  assert.equal(canNativeLock(env), false);
  assert.equal(await tryNativeLock(env), false, 'no throw — the prompt covers iOS');
  assert.equal(decideOrientation(env), ORIENT.ROTATE_PROMPT, 'portrait iOS shows the prompt');
});

test('iPadOS desktop-mode UA is still detected as iOS', () => {
  assert.equal(isIOS(UA.ipadDesktopMode), true);
  assert.equal(isIOS(UA.androidChrome), false);
});

test('rotating the phone toggles between gamepad and prompt (no CSS rotation)', async () => {
  let w = 852, h = 393; // landscape
  const env = { userAgent: UA.iosSafari, get viewportWidth() { return w; }, get viewportHeight() { return h; } };
  const listeners = {};
  const states = [];
  watchOrientation(env, (ev, fn) => { listeners[ev] = fn; }, s => states.push(s));
  assert.equal(states.at(-1), ORIENT.ACTIVE, 'starts active in landscape');

  [w, h] = [393, 852];           // rotate to portrait
  listeners.orientationchange();
  assert.equal(states.at(-1), ORIENT.ROTATE_PROMPT, 'portrait → prompt');

  [w, h] = [852, 393];           // back to landscape
  listeners.resize();
  assert.equal(states.at(-1), ORIENT.ACTIVE, 'landscape → active');
  // The fix for the real bug: touch axes are never rotated, so a visual
  // "up" swipe is always a real up swipe.
  assert.equal(isLandscape({ viewportWidth: 852, viewportHeight: 393 }), true);
});

// ---------- haptic feedback hardware hooks ----------

test('haptic patterns: standard hit 50ms, power smash 200ms, crowd roar rhythmic', () => {
  const fired = [];
  const haptics = new Haptics({ vibrate: p => { fired.push(p); return true; } });

  assert.equal(haptics.trigger('standardHit'), true);
  assert.deepEqual(fired[0], [50], 'standard hit: short crisp 50ms');

  assert.equal(haptics.trigger('powerSmash'), true);
  assert.deepEqual(fired[1], [200], 'power smash: heavy sustained 200ms');

  assert.equal(haptics.trigger('crowdRoar'), true);
  assert.deepEqual(fired[2], HAPTIC_PATTERNS.crowdRoar);
  assert.ok(fired[2].length >= 4 && fired[2].every(ms => ms <= 100),
    'crowd roar is gentle rhythmic pulsing, not one long buzz');
});

test('server-pushed raw haptic patterns pass through to hardware', () => {
  const fired = [];
  const haptics = new Haptics({ vibrate: p => { fired.push(p); return true; } });
  haptics.trigger([30, 60, 30]); // momentum pulse pattern from the host
  assert.deepEqual(fired[0], [30, 60, 30]);
});

test('devices without vibrate API degrade gracefully (iOS Safari)', () => {
  const haptics = new Haptics({}); // no vibrate function — like iPhone Safari
  assert.equal(haptics.enabled, false);
  assert.equal(haptics.trigger('powerSmash'), false, 'no throw, clean false');
  haptics.stop(); // must not throw either
});

// ---------- joystick precision ----------

test('joystick clamps to unit circle and respects deadzone', () => {
  const js = new Joystick(60);
  js.start(100, 100);

  let v = js.move(100 + 300, 100); // way past the radius
  assert.ok(Math.abs(v.x - 1) < 1e-9 && v.y === 0, 'clamped to unit magnitude');

  v = js.move(100 + 60 * DEADZONE * 0.5, 100); // inside deadzone
  assert.deepEqual(v, { x: 0, y: 0 }, 'micro-drift filtered by deadzone');

  v = js.move(100 + 30, 100 + 30); // diagonal half-deflection
  assert.ok(Math.hypot(v.x, v.y) <= 1.0000001, 'diagonal never exceeds unit circle');
  assert.ok(v.x > 0.4 && v.y > 0.4, 'precise proportional output');

  v = js.end();
  assert.deepEqual(v, { x: 0, y: 0 }, 'release snaps to neutral');
});

// ---------- input mapping: correctness + near-zero latency ----------

test('all six actions map to valid wire messages with monotonic sequence', () => {
  let t = 0;
  const mapper = new InputMapper(() => t += 8);
  const seqs = [];
  for (const action of ACTIONS) {
    const msg = decode(mapper.mapAction(action, { x: 0.25, y: -0.5 }));
    assert.equal(msg.type, 'input');
    assert.equal(msg.action, action);
    assert.deepEqual(msg.move, { x: 0.25, y: -0.5 });
    seqs.push(msg.seq);
  }
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5], 'sequence numbers strictly monotonic');
  assert.throws(() => mapper.mapAction('fireball'), /unknown action/, 'invalid actions rejected');
});

test('input mapping is near-zero latency: 10,000 messages well under one frame budget', () => {
  const mapper = new InputMapper();
  const t0 = performance.now();
  for (let i = 0; i < 10_000; i++) {
    mapper.mapMove({ x: Math.sin(i), y: Math.cos(i) });
  }
  const totalMs = performance.now() - t0;
  const perMsgUs = (totalMs / 10_000) * 1000;
  assert.ok(perMsgUs < 100, `mapping one input costs ${perMsgUs.toFixed(2)}µs — must be <100µs`);
});
