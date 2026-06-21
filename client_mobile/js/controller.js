// DOM glue for the mobile controller. Pure logic lives in the shared/pure
// modules (orientation, haptics, joystick, input-mapper, gestures); this file
// wires touch + WebSocket to them.
//
// Layout: LEFT half = floating movement joystick; RIGHT half = swipe-to-hit.
// Both work at once (two thumbs) via per-touch identifiers. Coordinates are
// natural landscape — we never CSS-rotate, so a visual "up" swipe is up.

import { MSG, encode, decode, SHIRT_COLORS, EMOTES } from '../../shared/protocol.js';
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
let autoCode = null;   // room code from the QR (?code) or a prior session — lets us skip code entry

let playerId = localStorage.getItem('tennis_player_id');
if (!playerId) {
  playerId = `phone-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem('tennis_player_id', playerId);
}
let playerName = localStorage.getItem('tennis_player_name') || '';

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
  $('startpanel').classList.remove('show');
  $('status').textContent = message;
}

function connect(code) {
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => ws.send(encode(MSG.JOIN, { code, playerId, name: playerName }));
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
        const message = msg.reason === 'room_full' ? 'Room is full — 4 players max' : 'Wrong code — scan the QR on the TV';
        if (msg.reason === 'bad_code') {
          // A stale QR/stored code (e.g. the server restarted) — fall back to
          // manual entry so they can read the fresh code off the TV.
          localStorage.removeItem('tennis_room_code'); hasJoined = false; revealCodeEntry();
        }
        showConnectScreen(message);
        break;
      }
      case MSG.HAPTIC: haptics.trigger(msg.pattern); break;
      case MSG.SERVE_CUE: {
        const cue = $('serve-cue');
        if (msg.on) {
          cue.textContent = msg.phase === 'strike' ? 'NOW SWIPE TO HIT! 🎾' : 'YOUR SERVE — TAP TO TOSS';
          cue.classList.add('show');
        } else cue.classList.remove('show');
        break;
      }
      case MSG.GAME_PAUSED:
        // Disconnect pause: someone dropped. You resume by REJOINING, not a button,
        // so hide Resume (no AI-takeover — wait-for-rejoin).
        $('pause-text').textContent = 'Game paused — waiting for a player to reconnect…';
        $('resume-btn').classList.remove('show');
        $('pause-overlay').style.display = 'flex';
        break;
      case MSG.GAME_RESUMED: $('pause-overlay').style.display = 'none'; break;
      case MSG.PAUSE_STATE:
        // Deliberate (user) pause: any phone or the TV can resume.
        $('pause-text').textContent = '⏸ Paused';
        $('resume-btn').classList.toggle('show', !!msg.paused);
        $('pause-overlay').style.display = msg.paused ? 'flex' : 'none';
        break;
      case MSG.LOBBY_STATE:
        // TV at the menu → show the Start Game panel; in a match → hide it.
        showStartPanel(!!msg.atMenu);
        if (msg.atMenu) { // back at menu: clear any leftover pause/serve prompts
          $('pause-overlay').style.display = 'none';
          $('serve-cue').classList.remove('show');
        }
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
  send(mapper.mapAction(shot.action, joystick.value, shot.aimX, shot.power));
  haptics.trigger(shot.action === 'smash' ? 'powerSmash' : 'standardHit');
  flashShot(shot.action);
}

// ---------- unified multitouch routing ----------

const half = () => window.innerWidth / 2;

// Once a real touch is seen, ignore mouse events for good. Mobile browsers fire
// SYNTHETIC mouse events (~300ms) after a tap; without this guard a single tap
// ran endSwipe twice (touchend + synthetic mouseup), which during a serve tossed
// AND struck in one tap — and double-fired shots mid-rally. Desktop (no touch)
// never trips this flag, so the mouse fallback still works there.
let usedTouch = false;
function onTouchStart(e) {
  usedTouch = true;
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
  if (usedTouch) return;            // a touch device — ignore synthetic/secondary mouse
  mouseDown = true;
  const fake = { identifier: 'mouse', clientX: e.clientX, clientY: e.clientY };
  if (e.clientX < half()) startMove(fake); else startSwipe(fake);
});
gp.addEventListener('mousemove', e => {
  if (usedTouch || !mouseDown) return;
  if (moveTouchId === 'mouse') moveMove({ identifier: 'mouse', clientX: e.clientX, clientY: e.clientY });
});
gp.addEventListener('mouseup', e => {
  if (usedTouch) return;
  mouseDown = false;
  if (moveTouchId === 'mouse') endMove();
  else if (swipeTouchId === 'mouse') endSwipe({ identifier: 'mouse', clientX: e.clientX, clientY: e.clientY });
});

// ---------- player name (typed on connect, changeable in the help panel) ----------
// Both inputs stay in sync; the name persists and, while connected, a change is
// pushed to the server (SET_NAME → re-broadcast so the TV updates live).
const nameInput = $('name-input');
const nameEdit = $('name-edit');
nameInput.value = playerName;
nameEdit.value = playerName;
function setName(raw) {
  playerName = (raw ?? '').slice(0, 14);
  localStorage.setItem('tennis_player_name', playerName);
  if (nameInput.value !== playerName) nameInput.value = playerName;
  if (nameEdit.value !== playerName) nameEdit.value = playerName;
  if (hasJoined) send(encode(MSG.SET_NAME, { name: playerName }));
}
nameInput.addEventListener('input', () => setName(nameInput.value));
nameEdit.addEventListener('input', () => setName(nameEdit.value));

// ---------- connect screen ----------
// QR-FIRST JOIN: the TV QR carries ?code, so a player never types a code. A
// returning/named player joins with zero taps; a first-timer just enters a name.
// Manual code entry stays as a fallback when no code is available (no QR scan).
function revealCodeEntry() {
  autoCode = null;
  $('code-input').style.display = '';
  $('join-btn').textContent = 'JOIN';
}
$('join-btn').addEventListener('click', () => {
  setName(nameInput.value); // capture the latest name before connecting
  const code = autoCode ?? $('code-input').value.trim();
  if (!/^\d{4}$/.test(code)) { $('status').textContent = 'Scan the QR on the TV (or type the 4-digit code)'; return; }
  $('status').textContent = 'Connecting…';
  connect(code);
});
$('code-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click(); });

// On load, resolve a code from the QR (?code) or a prior session; if found, skip
// the code box and either auto-join (we know the name) or just ask for a name.
(function autoJoinInit() {
  const fromUrl = new URLSearchParams(location.search).get('code');
  const stored = localStorage.getItem('tennis_room_code');
  const code = [fromUrl, stored].find(c => c && /^\d{4}$/.test(c)) ?? null;
  if (!code) return;                              // no code anywhere → show the manual form
  autoCode = code;
  $('code-input').style.display = 'none';         // no typing needed
  if (playerName) {
    $('status').textContent = 'Connecting…';
    connect(code);                                // returning/named player → straight in
  } else {
    $('join-btn').textContent = 'PLAY ▶';
    $('status').textContent = 'Enter your name, then tap PLAY';
    nameInput.focus();
  }
})();

// ---------- how to play ----------
$('help-list').innerHTML = PHONE_CHEAT_SHEET
  .map(([control, what]) => `<b>${control}</b><span>${what}</span>`).join('');
const closeHelp = () => { $('help-overlay').style.display = 'none'; };
$('help-btn').addEventListener('click', () => { $('help-overlay').style.display = 'flex'; });
$('help-close').addEventListener('click', closeHelp);     // "GOT IT" at the bottom
$('help-x').addEventListener('click', closeHelp);          // always-visible corner ✕
$('help-overlay').addEventListener('click', e => { if (e.target === $('help-overlay')) closeHelp(); }); // tap the backdrop

// ---- drop out: leave the room cleanly and return to a fresh join screen ----
$('leave-btn').addEventListener('click', () => {
  hasJoined = false;                              // stop the onclose auto-reconnect
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} } // frees the seat server-side → TV roster updates
  localStorage.removeItem('tennis_room_code');
  location.href = location.pathname;              // reload to the join form (drops ?code)
});

// ---- fullscreen toggle (Android/desktop; a safe no-op where unsupported, e.g. iOS Safari) ----
$('fullscreen-btn').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen?.(); }
    else if (env.requestFullscreen) { await env.requestFullscreen(); tryNativeLock(env); } // re-assert landscape lock
  } catch { /* unsupported (iOS) — ignore */ }
});

// ---- emotes / taunts: pop a bubble on the TV ----
$('emote-bar').innerHTML = EMOTES.map(e => `<button data-emote="${e}">${e}</button>`).join('');
$('emote-btn').addEventListener('click', () => $('emote-bar').classList.toggle('show'));
$('emote-bar').addEventListener('click', e => {
  const b = e.target.closest('[data-emote]'); if (!b) return;
  send(encode(MSG.EMOTE, { emote: b.dataset.emote }));
  haptics.trigger('standardHit');
  $('emote-bar').classList.remove('show');
});

// ---- pause/resume (any phone can toggle; the TV decides and echoes the state) ----
$('pause-btn').addEventListener('click', () => send(encode(MSG.PAUSE_REQUEST, {})));
$('resume-btn').addEventListener('click', () => send(encode(MSG.PAUSE_REQUEST, {})));

// ---- end match (from the pause overlay): ask the TV to quit to the menu ----
$('end-match-btn').addEventListener('click', () => send(encode(MSG.END_MATCH, {})));

// ---- launch from phone: choose settings + start the match on the TV ----
const launchCfg = { mode: 'single', surface: 'hard', format: 'short', difficulty: 0.72 };
function wireStartChoice(rowId, attr, cast = v => v) {
  $(rowId).addEventListener('click', e => {
    const btn = e.target.closest(`[data-${attr}]`);
    if (!btn) return;
    for (const b of $(rowId).querySelectorAll('.sp-choice')) b.classList.remove('sel');
    btn.classList.add('sel');
    launchCfg[attr] = cast(btn.dataset[attr]);
  });
}
wireStartChoice('sp-mode', 'mode');
wireStartChoice('sp-surface', 'surface');
wireStartChoice('sp-format', 'format');
wireStartChoice('sp-difficulty', 'difficulty', parseFloat);

// ---- 2v2 team + shirt picker (only shown when 2v2 is selected) ----
const teamChoice = { team: null, color: null };
$('sp-shirt').insertAdjacentHTML('beforeend', SHIRT_COLORS
  .map(c => `<button class="sw" data-color="${c}" style="background:${c}" aria-label="shirt colour"></button>`).join(''));
function sendTeamChoice() {
  if (teamChoice.team == null) return;
  send(encode(MSG.TEAM_CHOICE, { team: teamChoice.team, color: teamChoice.color }));
}
$('sp-team').addEventListener('click', e => {
  const b = e.target.closest('[data-team]'); if (!b) return;
  $('sp-team').querySelectorAll('.sp-choice').forEach(x => x.classList.remove('sel'));
  b.classList.add('sel'); teamChoice.team = Number(b.dataset.team); sendTeamChoice();
});
$('sp-shirt').addEventListener('click', e => {
  const b = e.target.closest('[data-color]'); if (!b) return;
  $('sp-shirt').querySelectorAll('.sw').forEach(x => x.classList.remove('sel'));
  b.classList.add('sel'); teamChoice.color = b.dataset.color; sendTeamChoice();
});
function update2v2Rows() {
  const show = launchCfg.mode === '2v2';
  for (const el of document.querySelectorAll('.sp-2v2')) el.style.display = show ? 'flex' : 'none';
}
$('sp-mode').addEventListener('click', update2v2Rows);
update2v2Rows();

function showStartPanel(show) {
  $('startpanel').classList.toggle('show', show && hasJoined);
}
$('startgame-btn').addEventListener('click', () => {
  send(encode(MSG.LAUNCH, { config: launchCfg }));
  const b = $('startgame-btn');
  b.textContent = 'STARTING…';
  setTimeout(() => { b.textContent = 'START GAME ▶'; }, 2500);
});

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
