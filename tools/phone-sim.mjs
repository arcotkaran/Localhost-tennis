// Phone-controller SIMULATOR — drives the headless game exactly the way a real
// phone does, so every gameplay feature can be tested end to end without a
// browser, a TV, or a physical phone.
//
// A real phone's only outputs are wire INPUT payloads: { move, action, aim,
// power, sens }. swipes are turned into shots by the SHARED gestureToShot()
// mapping (the same code controller.js runs), and the GameDirector consumes the
// payload via handleInput() — exactly what the TV renderer feeds it after the
// server relays a phone packet. So this simulator exercises the true contract.
//
//   SimPhone      — intent → wire payload (move / swipe / tap / serve gestures)
//   HeadlessMatch — a GameDirector + stepping loop + phone attach/apply
//   connectPhone  — (optional) a real WebSocket phone, to exercise the full
//                   network path (server relay + lag compensation)

import { gestureToShot } from '../shared/gestures.js';
import { GameDirector } from '../shared/game-director.js';
import { MSG, encode, decode } from '../shared/protocol.js';

// Canned swipe gestures (visual-landscape px: +x right, +y down). Tuned to land
// on each shot family through the real gestureToShot thresholds.
export const GESTURES = {
  tapLob:        { dx: 2,   dy: 1,   durationMs: 60 },   // tap → lob
  topspin:       { dx: 6,   dy: -90, durationMs: 320 },  // slow up → topspin
  flat:          { dx: 6,   dy: -90, durationMs: 70 },   // fast up → flat
  slice:         { dx: -6,  dy: 90,  durationMs: 200 },  // down → slice
  topspinRight:  { dx: 90,  dy: -90, durationMs: 300 },  // up-right → drive aimed right
  topspinLeft:   { dx: -90, dy: -90, durationMs: 300 },  // up-left  → drive aimed left
  sliceRight:    { dx: 90,  dy: 90,  durationMs: 200 },  // down-right → slice aimed right
  sliceLeft:     { dx: -90, dy: 90,  durationMs: 200 },  // down-left  → slice aimed left
  hardFlatRight: { dx: 200, dy: -40, durationMs: 70 },   // fast up-right → hard flat right
};

export class SimPhone {
  constructor(slot, { name = `sim-${slot}` } = {}) {
    this.slot = slot;
    this.name = name;
    this.moveVec = { x: 0, y: 0 };
    this.sens = 0.85;
  }

  setSensitivity(s) { this.sens = s; return this._payload({}); }

  // Joystick push in screen space (+x = right, +y = "down"/back as the phone
  // holds it). The engine handles team-1 camera inversion itself.
  move(x, y) { this.moveVec = { x, y }; return this._payload({}); }
  stop() { return this.move(0, 0); }

  // A swipe → shot through the SHARED mapping (identical to controller.js).
  swipe(gesture) {
    const shot = gestureToShot(gesture);
    this._lastShot = shot;
    return this._payload({ action: shot.action, aim: shot.aimX, power: shot.power });
  }

  // A tap (tiny movement) — used to toss a serve and, in a rally, to lob.
  tap() { return this.swipe(GESTURES.tapLob); }

  _payload(extra) {
    return { move: { ...this.moveVec }, sens: this.sens, ...extra };
  }
}

export class HeadlessMatch {
  constructor(opts = {}) {
    this.director = new GameDirector(opts);
    this.phones = new Map();   // slot -> SimPhone
    this.events = [];
    this.t = 0;
    this.dt = opts.dt ?? 1 / 120;
  }

  get state() { return this.director.state; }
  get score() { return this.director.score; }

  // Attach a phone to the next free controllable slot for this mode.
  joinPhone(opts) {
    const slots = Object.keys(this.director.map.slots).map(Number);
    const free = slots.find(s => !this.phones.has(s));
    if (free === undefined) throw new Error('no free controllable slot for this mode');
    this.director.attachSlot(free);
    const phone = new SimPhone(free, opts);
    this.phones.set(free, phone);
    return phone;
  }

  // The role the server + TV play: relay a phone's payload into the director.
  send(phone, payload) { this.director.handleInput(phone.slot, payload); return payload; }

  // Advance the sim, collecting events.
  step(seconds) {
    const n = Math.max(1, Math.round(seconds / this.dt));
    for (let i = 0; i < n; i++) {
      this.director.update(this.dt);
      this.t += this.dt;
      this.events.push(...this.director.drainEvents());
    }
    return this.events;
  }

  stepUntil(pred, maxSeconds = 14) {
    const n = Math.round(maxSeconds / this.dt);
    for (let i = 0; i < n && !pred(); i++) {
      this.director.update(this.dt);
      this.t += this.dt;
      this.events.push(...this.director.drainEvents());
    }
    return pred();
  }

  drain() { const e = this.events; this.events = []; return e; }

  // The phone controlling whoever is serving right now (or null if it's AI).
  servingPhone() {
    const server = this.director.currentServer();
    return this.phones.get(server.controlledBySlot) ?? null;
  }

  // Two-step serve as a human: wait for serve_pending, tap to toss, then strike
  // with the given gesture. Returns false if no human is on serve.
  serve(gesture = GESTURES.flat) {
    this.stepUntil(() => this.state === 'serve_pending' || this.state === 'finished');
    if (this.state !== 'serve_pending') return false;
    const phone = this.servingPhone();
    if (!phone) return false;
    this.send(phone, phone.tap());                         // toss
    this.stepUntil(() => this.state === 'serve_toss' || this.state === 'finished', 2);
    if (this.state !== 'serve_toss') return false;
    this.send(phone, phone.swipe(gesture));                // strike
    this.step(0.05);
    return true;
  }
}

// ---------- optional: a real WebSocket phone (full network path) ----------
// Uses the same SimPhone payloads but ships them over the wire to a running
// TennisServer, with monotonic seq + client timestamps like InputMapper.

export async function connectPhone(port, { code, playerId, name } = {}) {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  ws.on('message', raw => inbox.push(decode(raw)));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(encode(MSG.JOIN, { code, playerId, name }));
  let seq = 0;
  const phone = new SimPhone(null, { name });
  const sendInput = payload => ws.send(encode(MSG.INPUT, { seq: seq++, t: Date.now ? 0 : 0, ...payload }));
  return {
    ws, inbox, phone,
    move: (x, y) => sendInput(phone.move(x, y)),
    swipe: g => sendInput(phone.swipe(g)),
    tap: () => sendInput(phone.tap()),
    setSensitivity: s => sendInput(phone.setSensitivity(s)),
    waitFor: (type, ms = 1500) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout ' + type)), ms);
      const tick = () => { const m = inbox.find(x => x?.type === type); if (m) { clearTimeout(t); resolve(m); } else setTimeout(tick, 10); };
      tick();
    }),
    close: () => ws.close(),
  };
}
