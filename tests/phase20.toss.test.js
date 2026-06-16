// Testing Gate 20: tap-to-toss serve.
// Serving is two-step like real tennis — a TAP tosses the ball up (new
// 'serve_toss' state), a SWIPE strikes it. The AI auto-tosses-and-strikes, and
// anti-softlock fallbacks rescue an idle human at both steps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { GameDirector, SERVE_DELAY, SERVE_FALLBACK, TOSS_STRIKE_DELAY, HUMAN_TOSS_WINDOW } from '../shared/game-director.js';
import { COURT } from '../shared/physics.js';
import { createTennisServer } from '../server/game-server.js';
import { MSG, encode, decode } from '../shared/protocol.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DT = 1 / 120;
const step = (d, secs) => { const e = []; for (let t = 0; t < secs; t += DT) { d.update(DT); e.push(...d.drainEvents()); } return e; };

// ---------- human two-step serve ----------

test('a human TAP tosses the ball into the new serve_toss state', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  step(d, SERVE_DELAY + 0.5);
  assert.equal(d.state, 'serve_pending', 'waiting to serve');
  d.handleInput(0, { action: 'flat' }); // tap
  const events = step(d, 0.05);
  assert.equal(d.state, 'serve_toss', 'the tap tossed the ball');
  assert.ok(d.ball && d.ball.vel.y > 0, 'the toss is rising');
  assert.ok(Math.abs(d.ball.pos.x) > 1.5, 'tossed from a service corner');
  assert.ok(events.some(e => e.type === 'serve_toss'), 'a serve_toss event fired for the cue');
});

test('a human SWIPE after the toss strikes the serve into play', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  step(d, SERVE_DELAY + 0.5);
  d.handleInput(0, { action: 'flat' });   // toss
  step(d, 0.1);
  assert.equal(d.state, 'serve_toss');
  d.handleInput(0, { action: 'topspin', aim: 0, power: 0.6 }); // strike
  const events = step(d, 0.1);
  assert.ok(events.some(e => e.type === 'serve'), 'the swipe struck the serve');
  assert.equal(d.state, 'rally');
  assert.equal(d.lastShot, 'topspin');
});

test('the strike swipe — not the toss tap — sets the serve shot', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  step(d, SERVE_DELAY + 0.5);
  d.handleInput(0, { action: 'lob' });    // the toss tap (shot here is ignored)
  step(d, 0.1);
  d.handleInput(0, { action: 'slice' });  // the strike sets the shot
  step(d, 0.1);
  assert.equal(d.lastShot, 'slice', 'the serve uses the strike shot, not the toss');
});

// ---------- AI auto toss + strike ----------

test('AI auto-tosses then auto-strikes near the apex', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 }); // no slots → all AI
  // The opening serve fires after SERVE_DELAY/2; step just past the toss.
  const tossEvents = step(d, SERVE_DELAY * 0.5 + 0.05);
  assert.equal(d.state, 'serve_toss', 'AI tossed');
  assert.ok(tossEvents.some(e => e.type === 'serve_toss'));
  assert.ok(!tossEvents.some(e => e.type === 'serve'), 'not struck yet — the toss is still rising');
  // It strikes on its own a moment later (no input needed).
  const events = step(d, TOSS_STRIKE_DELAY + 0.1);
  assert.ok(events.some(e => e.type === 'serve'), 'AI struck the serve unprompted');
  assert.equal(d.state, 'rally');
});

// ---------- anti-softlock ----------

test('a human who tosses but never swipes is auto-struck (no soft-lock)', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  step(d, SERVE_DELAY + 0.5);
  d.handleInput(0, { action: 'flat' });  // toss, then walk away
  const events = step(d, HUMAN_TOSS_WINDOW + 0.3);
  assert.ok(events.some(e => e.type === 'serve'), 'the toss is struck for them');
  assert.notEqual(d.state, 'serve_toss', 'not stuck mid-toss');
});

test('a human who never even tosses is rescued by the serve fallback', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  const events = step(d, SERVE_DELAY + SERVE_FALLBACK + TOSS_STRIKE_DELAY + 0.5);
  assert.ok(events.some(e => e.type === 'serve_toss'), 'the fallback tossed');
  assert.ok(events.some(e => e.type === 'serve'), 'the fallback struck the serve');
});

// ---------- snapshot mid-toss ----------

test('serialize/restore preserves a mid-toss serve', () => {
  const d = new GameDirector({ mode: '1v1', seed: 3 });
  d.attachSlot(0);
  step(d, SERVE_DELAY + 0.5);
  d.handleInput(0, { action: 'flat' });
  step(d, 0.1);
  assert.equal(d.state, 'serve_toss');
  const snap = d.serialize();
  const d2 = new GameDirector({ mode: '1v1', seed: 77 });
  d2.attachSlot(0);
  d2.restore(snap);
  assert.equal(d2.state, 'serve_toss', 'resumed mid-toss');
  // The resumed director can still complete the serve (swipe to strike).
  d2.handleInput(0, { action: 'flat', power: 0.6 });
  const events = step(d2, 0.1);
  assert.ok(events.some(e => e.type === 'serve'), 'resumed toss can be struck');
});

// ---------- the serve cue carries its phase to the phone ----------

test('the TV serve cue relays its toss/strike phase to the serving phone', async () => {
  const server = await createTennisServer({ port: 0 });
  try {
    const open = port => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.inbox = []; ws.on('message', r => ws.inbox.push(decode(r))); ws.once('open', () => res(ws)); ws.once('error', rej); });
    const next = (ws, type, ms = 1500) => new Promise((res, rej) => {
      const take = () => { const hit = ws.inbox.find(m => m.type === type); if (!hit) return false; ws.inbox = ws.inbox.filter(m => m !== hit); clearTimeout(t); ws.off('message', p); res(hit); return true; };
      const p = () => take(); const t = setTimeout(() => { ws.off('message', p); rej(new Error('timeout ' + type)); }, ms);
      if (!take()) ws.on('message', p);
    });
    const host = await open(server.port);
    host.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));
    await new Promise(r => setTimeout(r, 40));
    const phone = await open(server.port);
    phone.send(encode(MSG.JOIN, { code: server.roomCode, playerId: 'p' }));
    await next(phone, MSG.JOINED);

    const tossCue = next(phone, MSG.SERVE_CUE);
    host.send(encode(MSG.SERVE_CUE, { slot: 0, on: true, phase: 'toss' }));
    assert.equal((await tossCue).phase, 'toss', 'phone is told to TAP to toss');

    const strikeCue = next(phone, MSG.SERVE_CUE);
    host.send(encode(MSG.SERVE_CUE, { slot: 0, on: true, phase: 'strike' }));
    assert.equal((await strikeCue).phase, 'strike', 'then to SWIPE to strike');

    for (const ws of [host, phone]) ws.close();
  } finally {
    await server.stop();
  }
});

test('the TV page still serves when opened with a ?code= query string', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const server = await createTennisServer({ port: 0, staticRoot: root });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/client_host/index.html?code=1234`);
    assert.equal(res.status, 200, 'a query string must not 404 the page');
    const html = await res.text();
    assert.ok(html.includes('<canvas') || html.includes('id="menu"'), 'real TV HTML was served, not an error');
  } finally {
    await server.stop();
  }
});
