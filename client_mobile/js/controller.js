// DOM glue for the mobile controller. Pure logic lives in the shared/pure
// modules (orientation, haptics, joystick, input-mapper, gestures); this file
// wires touch + WebSocket to them.
//
// Layout: LEFT half = floating movement joystick; RIGHT half = swipe-to-hit.
// Both work at once (two thumbs) via per-touch identifiers. Coordinates are
// natural landscape — we never CSS-rotate, so a visual "up" swipe is up.

import { MSG, encode, decode } from '../../shared/protocol.js';
import { PHONE_CHEAT_SHEET } from '../../shared/howto.js';
import { gestureToShot } from '../../shared/gestures.js';
import { decideOrientation, tryNativeLock, watchOrientation, ORIENT } from './orientation.js';
import { Haptics } from './haptics.js';
import { Joystick } from './joystick.js';
import { InputMapper } from './input-mapper.js';

const $ = id => document.getElementById(id);

const haptics = new Haptics(navigator);
const joystick = new Joystick(75);
const mapper = new InputMapper();

let ws = null;
let hasJoined = false;
let pingTimer = null;

let playerId = localStorage.getItem('tennis_player_id');
if (!playerId) {
  playerId = `phone-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem('tennis_player_id', playerId);
}

const env = {
  userAgent: navigator.userAgent,
  get viewportWidth() { return window.innerWidth; },
  get viewportHeight() { return window.innerHeight; },
  requestFullscreen: document.documentElement.requestFullscreen
    ? () => document.documentElement.requestFullscreen() : null,
  orientationLock: screen.orientation?.lock ? t => screen.orientation.lock(t) : null,
};

// ---------- connection ----------

function showConnectScreen(message) {
  $('gamepad').classList.remove('connected');
  $('connect').style.display = 'flex';
  $('pause-overlay').style.display = 'none';
  $('status').textContent = message;
}

function connect(code) {
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => ws.send(encode(MSG.JOIN, { code, playerId }));
  ws.onmessage = ev => {
    const msg = decode(ev.data);
    if (!msg) return;
    switch (msg.type) {
      case MSG.JOINED:
        hasJoined = true;
        $('connect').style.display = 'none';
        $('gamepad').classList.add('connected');
        localStorage.setItem('tennis_room_code', code);
        tryNativeLock(env);
        applyOrientation(decideOrientation(env));
        startPingLoop();
        break;
      case MSG.JOIN_ERROR: {
        const message = msg.reason === 'room_full' ? 'Room is full (4 players max)' : 'Wrong code — check the TV';
        if (msg.reason === 'bad_code') { localStorage.removeItem('tennis_room_code'); hasJoined = false; }
        showConnectScreen(message);
        break;
      }
      case MSG.HAPTIC: haptics.trigger(msg.pattern); break;
      case MSG.SERVE_CUE: $('serve-cue').classList.toggle('show', !!msg.on); break;
      case MSG.GAME_PAUSED:
        $('pause-overlay').textContent = 'Game paused — waiting for a player to reconnect…';
        $('pause-overlay').style.display = 'flex';
        break;
      case MSG.GAME_RESUMED: $('pause-overlay').style.display = 'none'; break;
      case MSG.PAUSE_STATE:
        $('pause-overlay').textContent = '⏸ Paused — tap pause on any phone or the TV to resume';
        $('pause-overlay').style.display = msg.paused ? 'flex' : 'none';
        break;
    }
  };
  ws.onclose = () => {
    if (!hasJoined) return;
    const stored = localStorage.getItem('tennis_room_code');
    if (stored) setTimeout(() => connect(stored), 500);
    else showConnectScreen('Connection lost — enter the code on the TV');
  };
}

function startPingLoop() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => { if (ws?.readyState === 1) ws.send(encode(MSG.PING, { t: performance.now() })); }, 1000);
}

function send(raw) { if (ws?.readyState === 1) ws.send(raw); }

// ---------- orientation (rotate prompt, no CSS rotation) ----------

function applyOrientation(state) {
  const landscape = state === ORIENT.ACTIVE;
  $('rotate').classList.toggle('show', !landscape && $('gamepad').classList.contains('connected'));
}
watchOrientation(env, (ev, fn) => window.addEventListener(ev, fn), applyOrientation);

// ---------- movement: floating joystick on the left half ----------

const base = $('joystick-base');
const thumb = $('joystick-thumb');
let moveTouchId = null;
let lastMoveSent = 0;

let sensitivity = parseFloat(localStorage.getItem('tennis_sensitivity') ?? '0.85');

function sendMove() {
  send(mapper.mapMove(joystick.value, sensitivity));
  lastMoveSent = performance.now();
}

function startMove(t) {
  moveTouchId = t.identifier;
  joystick.start(t.clientX, t.clientY);
  base.style.left = `${t.clientX}px`;
  base.style.top = `${t.clientY}px`;
  base.classList.add('active');
  thumb.style.transform = '';
  sendMove();
}

function moveMove(t) {
  joystick.move(t.clientX, t.clientY);
  const o = joystick.thumbOffset;
  thumb.style.transform = `translate(${o.x}px, ${o.y}px)`;
  // Event-driven, lightly throttled — far lower latency than a fixed-rate poll.
  if (performance.now() - lastMoveSent >= 16) sendMove();
}

function endMove() {
  moveTouchId = null;
  joystick.end();
  base.classList.remove('active');
  thumb.style.transform = '';
  sendMove(); // zero
}

// ---------- shots: swipe anywhere on the right half ----------

let swipeTouchId = null;
let swipeStart = null;

function flashShot(action) {
  const f = $('shot-flash');
  f.textContent = action.toUpperCase();
  f.classList.remove('flash');
  void f.offsetWidth; // restart animation
  f.classList.add('flash');
}

function startSwipe(t) {
  swipeTouchId = t.identifier;
  swipeStart = { x: t.clientX, y: t.clientY, t: performance.now() };
}

function endSwipe(t) {
  if (!swipeStart) return;
  const dx = t.clientX - swipeStart.x;
  const dy = t.clientY - swipeStart.y;
  const durationMs = performance.now() - swipeStart.t;
  swipeTouchId = null;
  swipeStart = null;
  const shot = gestureToShot({ dx, dy, durationMs });
  send(mapper.mapAction(shot.action, joystick.value, shot.aimX));
  haptics.trigger(shot.action === 'smash' ? 'powerSmash' : 'standardHit');
  flashShot(shot.action);
}

// ---------- unified multitouch routing ----------

const half = () => window.innerWidth / 2;

function onTouchStart(e) {
  for (const t of e.changedTouches) {
    if (t.clientX < half() && moveTouchId === null) startMove(t);
    else if (t.clientX >= half() && swipeTouchId === null) startSwipe(t);
  }
}
function onTouchMove(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === moveTouchId) moveMove(t);
  }
}
function onTouchEnd(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === moveTouchId) endMove();
    else if (t.identifier === swipeTouchId) endSwipe(t);
  }
}

const gp = $('gamepad');
gp.addEventListener('touchstart', onTouchStart, { passive: true });
gp.addEventListener('touchmove', onTouchMove, { passive: true });
gp.addEventListener('touchend', onTouchEnd, { passive: true });
gp.addEventListener('touchcancel', onTouchEnd, { passive: true });

// Mouse fallback so the controller is testable/usable on a desktop too.
let mouseDown = false;
gp.addEventListener('mousedown', e => {
  mouseDown = true;
  const fake = { identifier: 'mouse', clientX: e.clientX, clientY: e.clientY };
  if (e.clientX < half()) startMove(fake); else startSwipe(fake);
});
gp.addEventListener('mousemove', e => {
  if (!mouseDown) return;
  if (moveTouchId === 'mouse') moveMove({ identifier: 'mouse', clientX: e.clientX, clientY: e.clientY });
});
gp.addEventListener('mouseup', e => {
  mouseDown = false;
  if (moveTouchId === 'mouse') endMove();
  else if (swipeTouchId === 'mouse') endSwipe({ identifier: 'mouse', clientX: e.clientX, clientY: e.clientY });
});

// ---------- connect screen ----------
$('join-btn').addEventListener('click', () => {
  const code = $('code-input').value.trim();
  if (!/^\d{4}$/.test(code)) { $('status').textContent = 'Enter the 4-digit code on the TV'; return; }
  $('status').textContent = 'Connecting…';
  connect(code);
});
$('code-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click(); });

// ---------- how to play ----------
$('help-list').innerHTML = PHONE_CHEAT_SHEET
  .map(([control, what]) => `<b>${control}</b><span>${what}</span>`).join('');
$('help-btn').addEventListener('click', () => { $('help-overlay').style.display = 'flex'; });
$('help-close').addEventListener('click', () => { $('help-overlay').style.display = 'none'; });

// ---- pause (any phone can pause; the TV decides and echoes the state) ----
$('pause-btn').addEventListener('click', () => send(encode(MSG.PAUSE_REQUEST, {})));

// ---- movement sensitivity slider (persisted; sent with the next move) ----
const sensInput = $('sens');
sensInput.value = String(sensitivity);
$('sens-val').textContent = sensitivity.toFixed(2);
sensInput.addEventListener('input', () => {
  sensitivity = parseFloat(sensInput.value);
  $('sens-val').textContent = sensitivity.toFixed(2);
  localStorage.setItem('tennis_sensitivity', String(sensitivity));
  send(mapper.mapMove(joystick.value, sensitivity)); // push the new setting immediately
});
