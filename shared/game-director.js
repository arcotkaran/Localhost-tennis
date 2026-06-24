// GameDirector: the complete, renderer-agnostic game loop.
// Owns serve flow, rally physics, swing windows for phone-controlled
// players, AI fallback for uncontrolled players, doubles slot mapping,
// and point/score resolution. The TV renderer only draws what this says
// and forwards phone inputs into it.
//
// Court convention: team 0 defends z > 0 (near side), team 1 defends z < 0.

import { Ball, PlayerBody, SURFACES, COURT, BALL, G } from './physics.js';
import { MatchScore } from './scoring.js';
import { AIPlayer, mulberry32 } from './ai.js';
import { applyNetContext } from './gestures.js';
import { GameLog } from './game-log.js';

export const SWING_WINDOW = 0.45;   // seconds a button press stays "armed"
export const REACH_X = 1.7;         // lateral reach (m)
export const REACH_Z = 1.2;         // depth reach (m)
export const SERVE_DELAY = 1.6;     // seconds between points

const SHOT_PROFILES = {
  flat:    { speed: 30, lift: 5.0, spin: 0 },
  topspin: { speed: 28, lift: 6.0, spin: 330 },
  // Slice is a SOFT DROP SHOT: slow, light backspin, lands short — it must
  // stay in the court (it used to float long and sail out).
  slice:   { speed: 15, lift: 4.2, spin: -130 },
  // Lob is a high defensive arc (the phone's TAP shot): tall enough to clear a
  // net-rusher, slow enough that the human depth clamp keeps it inside the
  // baseline rather than sailing long.
  lob:     { speed: 16, lift: 9.5, spin: -80 },
  smash:   { speed: 42, lift: 1.8, spin: 60 },
  volley:  { speed: 24, lift: 4.2, spin: 0 },
};

// slot → { playerIndex } per mode. Doubles pairs slots (0,2) vs (1,3).
export function slotMapping(mode) {
  switch (mode) {
    case 'single': return { slots: { 0: 0 }, players: 2, teams: [0, 1] };
    case '1v1':    return { slots: { 0: 0, 1: 1 }, players: 2, teams: [0, 1] };
    case '2v2':    return { slots: { 0: 0, 1: 1, 2: 2, 3: 3 }, players: 4, teams: [0, 1, 0, 1] };
    default: throw new Error(`unknown mode ${mode}`);
  }
}

// A human server who walks away must not soft-lock the match.
export const SERVE_FALLBACK = 12.0; // retained for tests/compat; a human server is NO LONGER auto-served (waits as long as they like)
// Two-step serve: a tap tosses the ball up, a swipe strikes it.
export const TOSS_STRIKE_DELAY = 0.45; // AI/fallback strikes this long after the toss (near the apex)
export const HUMAN_TOSS_WINDOW = 1.4;  // a human who tosses but never swipes is auto-struck (anti-softlock)

export class GameDirector {
  constructor({ mode = '1v1', surface = 'hard', bestOf = 3, characters = [], seed = 42, difficulty = 0.7, log = false, slotPlayers = null } = {}) {
    this.mode = mode;
    this.surfaceName = surface;
    this.surface = SURFACES[surface];
    if (!this.surface) throw new Error(`unknown surface ${surface}`);
    this.difficulty = difficulty;
    // Flight recorder — off by default (zero cost in normal play). Pass
    // `log: true` to capture a structured trace, or `log: <GameLog>` to share one.
    this.log = log ? (log instanceof GameLog ? log : new GameLog()) : null;
    this.frame = 0;       // sim frame index (advances in update)
    this.elapsed = 0;     // sim seconds elapsed
    this.score = new MatchScore({ bestOf });
    this.rng = mulberry32(seed);
    // A SEPARATE stream for serve-fault randomness, so adding faults doesn't
    // shift the main rng (AI movement/shots) and perturb every seeded test.
    this.serveRng = mulberry32(seed + 777);

    const map = slotMapping(mode);
    // Optional slot→player remap (2v2 team picks). Each phone slot can be routed
    // to a player on its chosen team (slots 0/2 are team 0, 1/3 are team 1), so a
    // player lands on the side they picked. Must be a permutation of the same
    // player indices, so teams/positions/AI are otherwise unchanged.
    if (slotPlayers && this.validSlotPlayers(slotPlayers, map)) map.slots = slotPlayers;
    this.map = map;
    this.players = [];
    for (let i = 0; i < map.players; i++) {
      const team = map.teams[i];
      const character = characters[i] ?? null;
      const traits = character?.traits ?? {};
      const sideZ = (team === 0 ? 1 : -1) * (COURT.length / 2 - 1.5);
      // Doubles partners split the court left/right.
      const pairIndex = this.players.filter(p => p.team === team).length;
      const x = map.players === 4 ? (pairIndex === 0 ? -2.2 : 2.2) : 0;
      this.players.push({
        index: i, team, character,
        body: new PlayerBody({ pos: { x, z: sideZ }, maxSpeed: 8.5 * (traits.speed ?? 1) }),
        ai: new AIPlayer({ difficulty, traits, rng: mulberry32(seed + i + 1) }),
        controlledBySlot: null,
        move: { x: 0, y: 0 },
        armed: null,           // { action, age } — buffered swing press
        swingCooldown: 0,
      });
    }

    this.ball = null;
    this.state = 'serve_pending'; // serve_pending | serve_toss | rally | finished
    this.serveTimer = SERVE_DELAY * 0.5;
    this.serveAnnounced = false;  // whether we've emitted serve_ready this point
    this.tossAge = 0;             // seconds since the ball was tossed (serve_toss)
    this.serveAuto = false;       // the toss was auto (AI/fallback) → auto-strike at the apex
    this.serveNumber = 1;         // 1 = first serve, 2 = second serve (after a fault)
    this.awaitingServeBounce = false; // a struck serve whose first bounce must land in the box
    this.serveTarget = null;      // { dir, xSign } — the diagonal box the serve must hit
    this.lastHitTeam = null;
    this.lastShot = 'flat';
    this.rallyLength = 0;
    this.events = [];
    this.positionForServe(); // everyone on the correct side for the opening serve
  }

  // A slot→player remap is only honoured if it's a true permutation of the
  // default mapping (same slots, same player indices, just reordered) — so it
  // can never drop a player, double-book one, or change team membership.
  validSlotPlayers(sp, map) {
    const a = Object.entries(map.slots), b = Object.entries(sp);
    if (a.length !== b.length) return false;
    const slots = Object.keys(map.slots).map(Number).sort((x, y) => x - y);
    if (!slots.every(s => s in sp)) return false;
    const want = Object.values(map.slots).sort((x, y) => x - y).join(',');
    const got = Object.values(sp).sort((x, y) => x - y).join(',');
    return want === got;
  }

  // The player whose team is serving (the one nearest center on that side).
  currentServer() {
    const team = this.score.server;
    const onTeam = this.players.filter(p => p.team === team);
    // In doubles, the two partners ALTERNATE service games. A team only serves
    // every OTHER game, so keying the partner on total games played makes the
    // parity constant for a given team (it's always even when team 0 serves,
    // odd when team 1 serves) — so the same partner would serve forever. Key it
    // on the team's own service rotation instead: advance the partner once per
    // two total games, i.e. each time it comes back around to this team.
    if (onTeam.length === 2) {
      const gamesPlayed = this.score.games[0] + this.score.games[1] +
        this.score.sets.reduce((s, set) => s + set[0] + set[1], 0);
      return onTeam[Math.floor(gamesPlayed / 2) % 2];
    }
    return onTeam[0];
  }

  // ----- phone wiring -----

  attachSlot(slot) {
    const idx = this.map.slots[slot];
    if (idx === undefined) return null;
    this.players[idx].controlledBySlot = slot;
    return idx;
  }

  detachSlot(slot) {
    for (const p of this.players) if (p.controlledBySlot === slot) p.controlledBySlot = null;
  }

  handleInput(slot, { move, action, aim, power, sens }) {
    const p = this.players.find(pl => pl.controlledBySlot === slot);
    if (!p) {
      this.logEvent('input', { slot, accepted: false, reason: 'no_player_for_slot', action: action ?? null }, 'warn');
      return;
    }
    if (typeof sens === 'number') p.sens = Math.max(0.4, Math.min(1.2, sens));
    // Only log a move when it actually CHANGES — a joystick streams the same
    // vector every frame and would otherwise flood the trace. A swipe (action)
    // is always logged.
    const moveChanged = !!move && (!p.move || p.move.x !== move.x || p.move.y !== move.y);
    if (move) p.move = { x: move.x, y: move.y };
    // A swipe carries both the shot and its own aim; keep them together so
    // placement comes from the swipe, not from the movement joystick.
    if (action) p.armed = {
      action,
      aim: (typeof aim === 'number' ? aim : null),
      power: (typeof power === 'number' ? power : null),
      age: 0,
    };
    if (action || moveChanged) {
      this.logEvent('input', {
        slot, player: p.index, accepted: true,
        move: move ? { x: move.x, y: move.y } : null,
        action: action ?? null,
        aim: typeof aim === 'number' ? aim : null,
        power: typeof power === 'number' ? power : null,
        sens: typeof sens === 'number' ? sens : null,
      });
    }
  }

  emit(type, data = {}) {
    this.events.push({ type, ...data });
    this.logEvent(type, data);
  }

  // Record a structured entry in the flight recorder (no-op when logging off).
  logEvent(type, fields = {}, level = 'info') {
    if (!this.log) return;
    this.log.push({ t: Math.round(this.elapsed * 1e4) / 1e4, frame: this.frame, type, level, ...fields });
  }

  // Change state, logging the transition (from → to + why) for the trace.
  setState(next, reason = null) {
    if (next !== this.state) this.logEvent('state', { from: this.state, to: next, reason });
    this.state = next;
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ----- core loop -----

  update(dt) {
    if (this.state === 'finished') return;
    this.frame++;
    this.elapsed += dt;
    for (const p of this.players) {
      if (p.armed && (p.armed.age += dt) > SWING_WINDOW) p.armed = null;
      if (p.swingCooldown > 0) p.swingCooldown -= dt;
    }
    if (this.state === 'serve_pending') {
      this.serveTimer -= dt;
      const server = this.currentServer();
      const human = server.controlledBySlot !== null;
      if (human) {
        // Announce once that it's their serve, then wait for a TAP to toss —
        // for as long as the player likes. A human server is NEVER auto-served
        // (no timeout); a disconnect pauses the match, so there is no soft-lock.
        if (!this.serveAnnounced) {
          this.emit('serve_ready', { team: server.team, player: server.index, slot: server.controlledBySlot, serveNumber: this.serveNumber });
          this.serveAnnounced = true;
        }
        if (server.armed) {
          server.armed = null;
          this.tossServe(false);     // tap → toss the ball up; the swipe will strike it
        }
      } else if (this.serveTimer <= 0) {
        this.tossServe(true);        // AI auto-tosses (then auto-strikes at the apex)
      }
    } else if (this.state === 'serve_toss') {
      this.tossAge += dt;
      const server = this.currentServer();
      const awaitingHuman = server.controlledBySlot !== null && !this.serveAuto;
      if (awaitingHuman) {
        if (server.armed) {
          const { action, aim, power } = server.armed;
          server.armed = null;
          this.serve(action, aim, power); // swipe strikes the toss
        } else if (this.tossAge >= HUMAN_TOSS_WINDOW) {
          this.serve('flat');             // tossed but never swung — strike anyway
        }
      } else if (this.tossAge >= TOSS_STRIKE_DELAY) {
        this.serve('flat');               // AI / fallback strikes near the apex
      }
      // Animate the tossed ball rising and falling until it's struck.
      if (this.state === 'serve_toss' && this.ball) this.ball.step(dt, this.surface);
    }
    this.stepPlayers(dt);
    if (this.state === 'rally' && this.ball) this.stepBall(dt);
  }

  // Which side the server stands: deuce court (right) on even points, ad
  // court (left) on odd. +1 = the server's right.
  serveSide() {
    const pts = this.score.inTiebreak
      ? this.score.tiebreakPoints[0] + this.score.tiebreakPoints[1]
      : this.score.points[0] + this.score.points[1];
    return pts % 2 === 0 ? 1 : -1; // deuce : ad
  }

  // Stand the server at their deuce/ad baseline corner and the receiver(s)
  // diagonally across to receive the cross-court serve — everyone on the
  // correct side before the ball is struck.
  positionForServe() {
    const servingTeam = this.score.server;
    const side = this.serveSide();                       // +1 deuce(right), -1 ad(left)
    const server = this.currentServer();
    const serverTeamSign = servingTeam === 0 ? 1 : -1;
    const boxWorldX = -side * serverTeamSign * (COURT.singlesWidth / 4); // serve target side

    for (const team of [0, 1]) {
      const teamSign = team === 0 ? 1 : -1;
      const baseline = teamSign * (COURT.length / 2 - 0.4);
      const mates = this.players.filter(p => p.team === team);
      if (team === servingTeam) {
        server.body.pos = { x: side * serverTeamSign * (COURT.singlesWidth / 2 - 0.6), z: baseline };
        server.body.vel = { x: 0, z: 0 };
        // Real doubles formation: the partner stands at the net DIAGONALLY
        // across from the server (opposite half), ready to poach — not beside
        // them. boxWorldX is the half opposite the server's corner.
        const partner = mates.find(p => p !== server);
        if (partner) { partner.body.pos = { x: boxWorldX, z: teamSign * COURT.serviceLine * 0.45 }; partner.body.vel = { x: 0, z: 0 }; }
      } else {
        const returner = mates[0];
        returner.body.pos = { x: boxWorldX, z: baseline };   // diagonally across, on the serve's side
        returner.body.vel = { x: 0, z: 0 };
        const partner = mates[1];
        if (partner) { partner.body.pos = { x: -boxWorldX, z: teamSign * COURT.serviceLine * 0.7 }; partner.body.vel = { x: 0, z: 0 }; }
      }
    }
  }

  // Step 1 of the serve: toss the ball up from the deuce/ad corner. `auto` =
  // the engine will also strike it (AI or the idle-human fallback); otherwise
  // we wait for the human's swipe to strike.
  tossServe(auto) {
    const server = this.currentServer();
    const teamSign = server.team === 0 ? 1 : -1;
    const side = this.serveSide();
    const cornerX = side * teamSign * (COURT.singlesWidth / 2 - 0.6);
    server.body.pos = { x: cornerX, z: teamSign * (COURT.length / 2 - 0.2) };
    server.body.vel = { x: 0, z: 0 };
    this.ball = new Ball({ pos: { x: cornerX, y: 1.5, z: server.body.pos.z }, vel: { x: 0, y: 5.5, z: 0 } });
    this.setState('serve_toss', auto ? 'auto_toss' : 'tap_toss');
    this.serveAuto = auto;
    this.tossAge = 0;
    this.serveAnnounced = false;
    this.emit('serve_toss', { team: server.team, player: server.index, slot: server.controlledBySlot, serveNumber: this.serveNumber, auto });
  }

  // Step 2: strike the (already tossed) ball into the service box.
  serve(action = 'flat', aim = null, power = null) {
    const server = this.currentServer();
    const servingTeam = server.team;
    const dir = servingTeam === 0 ? -1 : 1;
    const teamSign = servingTeam === 0 ? 1 : -1;
    // Real serves start from BEHIND the baseline, at the deuce/ad corner.
    const side = this.serveSide();              // +1 right, -1 left (server's view)
    const cornerX = side * teamSign * (COURT.singlesWidth / 2 - 0.6);
    server.body.pos = { x: cornerX, z: teamSign * (COURT.length / 2 - 0.2) };
    server.body.vel = { x: 0, z: 0 };

    const isHuman = server.controlledBySlot !== null;
    const serveSpeed = server.character?.traits.serveSpeed ?? 1;
    const powerEff = isHuman ? (power ?? 0.6) : 0.7;        // AI hits a steady, competent serve
    // Aim diagonally into the opposite service box (cross-court).
    const boxX = -side * teamSign * (COURT.singlesWidth / 4);
    this.serveTarget = { dir, xSign: Math.sign(boxX) };
    // PACE comes straight from the serveSpeed trait + power (so a big server
    // really does serve faster); the arc (vy) is then solved so it still lands
    // in the box. A slice serve is a touch slower.
    const pace = (16 + 10 * powerEff) * serveSpeed * (action === 'slice' ? 0.9 : 1);
    this.ball = new Ball({
      // Contact up at full reach (~3 m) like a real serve: more downward room to
      // clear the net AND drop into the box, so honest serves stop catching the
      // tape (the old 2.7 m contact netted ~1 serve in 4).
      pos: { x: cornerX, y: 3.0, z: server.body.pos.z },
      vel: { x: 0, y: 1.0, z: dir * pace },
      spin: { x: dir * (action === 'slice' ? -160 : 110), y: 0, z: 0 },
    });

    // SKILL-BASED placement — this, and ONLY this, decides whether the serve is
    // in. No random fault roll and no artificial "overhit" nudge:
    //   • aim (swipe ANGLE) → WIDTH: box centre out toward (or past) the singles
    //     line. Aim near the line for an ace; over-aim and it lands wide.
    //   • power (swipe SPEED) → DEPTH (and pace): a soft serve drops in short and
    //     safe; a big one drives deep toward — or past — the service line.
    // Serve within yourself → in; go for too much angle/pace → physics puts it
    // out. Team 1's screen-right is world −x, so flip a human's nudge.
    const aimNudge = aim != null ? (servingTeam === 1 ? -aim : aim) : 0;
    const lineReach = COURT.singlesWidth / 2 - Math.abs(boxX) + 0.6; // full aim → just past the singles line
    let targetX = boxX + aimNudge * lineReach;
    let targetZ = dir * COURT.serviceLine * (0.55 + 0.5 * powerEff); // 0.55→1.05 of the box depth
    // The AI's PRECISION is its skill: a weaker server sprays its target more
    // (deterministic serveRng, so match replays stay stable) and so faults from
    // imperfect placement, not a coin flip — and it plays a second serve safer.
    if (!isHuman) {
      const spray = (1 - this.difficulty) * 2.4 * (this.serveNumber === 2 ? 0.4 : 1);
      targetX += (this.serveRng() * 2 - 1) * spray;
      targetZ += dir * (this.serveRng() * 2 - 1) * spray * 0.8;
    }

    this.solveServeLanding(targetX, targetZ, dir);
    this.awaitingServeBounce = true;
    this.lastHitTeam = servingTeam;
    this.lastShot = action;
    this.rallyLength = 0;
    this.serveAnnounced = false;
    // Trace the skill inputs vs. where physics will actually put the ball — the
    // record that explains any "looked in but FAULT". landingPoint() is a
    // forward-sim, so only pay for it when logging is on.
    if (this.log) {
      const lp = this.landingPoint();
      this.logEvent('serve_strike', {
        team: servingTeam, player: server.index, slot: server.controlledBySlot,
        serveNumber: this.serveNumber, side: side === 1 ? 'deuce' : 'ad', isHuman, action,
        intendedAim: aim ?? null, intendedPower: power ?? null, powerEff,
        targetBox: { ...this.serveTarget },
        targetX: Math.round(targetX * 1e3) / 1e3, targetZ: Math.round(targetZ * 1e3) / 1e3,
        vel: { x: Math.round(this.ball.vel.x * 100) / 100, y: Math.round(this.ball.vel.y * 100) / 100, z: Math.round(this.ball.vel.z * 100) / 100 },
        predictedLanding: { x: Math.round(lp.x * 100) / 100, z: Math.round(lp.z * 100) / 100 },
        predictedInBox: this.serveLandedInBox(lp.x, lp.z),
      });
    }
    this.setState('rally', 'serve_struck');
    this.emit('serve', { team: servingTeam, player: server.index, serveNumber: this.serveNumber, speed: Math.abs(this.ball.vel.z) });
    this.emit('hit', { player: server.index, slot: server.controlledBySlot, action, power: 0.85, pos: { ...this.ball.pos } });
  }

  stepPlayers(dt) {
    for (const p of this.players) {
      let input = p.move;
      if (p.controlledBySlot === null) {
        input = (this.ball && this.state === 'rally' && this.ballComingTo(p.team))
          ? p.ai.decideMovement(this.ball, p.body.pos, this.surface)
          : this.recoverToward(p);
      } else if (p.team === 1) {
        // Team 1's camera faces the opposite way, so a human's screen-relative
        // stick is inverted on both axes vs. world space. (AI input above is
        // already world-space and must NOT be flipped.)
        input = { x: -p.move.x, y: -p.move.y };
      }
      // Humans get responsive but not twitchy control; their top speed scales
      // with the phone's sensitivity slider so the avatar isn't too fast. The
      // AI keeps a steady human-like accel and top speed.
      if (p.controlledBySlot !== null) {
        const sens = p.sens ?? 0.85;
        p.body.accel = 36;
        p.body.maxSpeed = 8.5 * (p.character?.traits.speed ?? 1) * sens;
      } else {
        p.body.accel = 24;
        p.body.maxSpeed = 8.5 * (p.character?.traits.speed ?? 1);
      }
      p.body.step(dt, input, this.surface);
      // Keep players on their own side, inside sane bounds.
      const zMin = p.team === 0 ? 0.5 : -(COURT.length / 2 + 3);
      const zMax = p.team === 0 ? COURT.length / 2 + 3 : -0.5;
      p.body.pos.z = Math.max(zMin, Math.min(zMax, p.body.pos.z));
      p.body.pos.x = Math.max(-COURT.width / 2 - 1.5, Math.min(COURT.width / 2 + 1.5, p.body.pos.x));
    }
  }

  recoverToward(p) {
    // Drift back to the ready position between shots.
    const homeZ = (p.team === 0 ? 1 : -1) * (COURT.length / 2 - 1.5);
    const pair = this.players.filter(q => q.team === p.team);
    const homeX = pair.length === 2 ? (pair[0] === p ? -2.2 : 2.2) : 0;
    const dx = homeX - p.body.pos.x, dz = homeZ - p.body.pos.z;
    const d = Math.hypot(dx, dz);
    return d < 0.3 ? { x: 0, y: 0 } : { x: dx / d * 0.6, y: dz / d * 0.6 };
  }

  ballComingTo(team) {
    return (team === 0) === (this.ball.vel.z > 0);
  }

  stepBall(dt) {
    const x0 = this.ball.pos.x, y0 = this.ball.pos.y, z0 = this.ball.pos.z;
    const ev = this.ball.step(dt, this.surface);
    // Net collision: if the ball crosses the net plane (z=0) below the cord,
    // it hits the net and falls — the hitter loses the point (like real life).
    const z1 = this.ball.pos.z;
    if (z0 !== 0 && Math.sign(z1) !== Math.sign(z0)) {
      const f = z0 / (z0 - z1);                       // fraction to the z=0 crossing
      const yAtNet = y0 + (this.ball.pos.y - y0) * f;
      const xAtNet = x0 + (this.ball.pos.x - x0) * f;
      const clearsCord = yAtNet > COURT.netHeight + BALL.radius;
      const withinPosts = Math.abs(xAtNet) < COURT.width / 2 + 0.5;
      if (!clearsCord && withinPosts) {
        this.ball.pos = { x: xAtNet, y: Math.max(BALL.radius, yAtNet), z: 0 };
        this.ball.vel = { x: 0, y: -1, z: 0 };        // dead — drops at the net
        this.emit('net', { pos: { ...this.ball.pos } });
        // A serve into the net is a fault, not an instant point.
        if (this.awaitingServeBounce) return this.faultServe('net');
        return this.endPoint(1 - this.lastHitTeam, 'net');
      }
    }
    if (ev === 'bounce') {
      const speed = Math.hypot(this.ball.vel.x, this.ball.vel.z);
      this.emit('bounce', { pos: { ...this.ball.pos }, speed, surface: this.surfaceName });
      // A struck serve's FIRST bounce must land in the diagonal service box.
      if (this.awaitingServeBounce) {
        this.awaitingServeBounce = false;
        const inBox = this.serveLandedInBox(this.ball.pos.x, this.ball.pos.z);
        this.logEvent('serve_result', {
          serveNumber: this.serveNumber, inBox,
          landing: { x: Math.round(this.ball.pos.x * 100) / 100, z: Math.round(this.ball.pos.z * 100) / 100 },
          box: this.serveTarget ? { ...this.serveTarget } : null,
        });
        if (!inBox) {
          return this.faultServe('out');
        }
        // Legal serve — play on (the receiver returns it like any other ball).
      } else {
        // Singles (1v1 / vs-AI) uses the narrower SINGLES court — a ball in the
        // doubles alley is OUT. Only 2v2 doubles plays the full width.
        const halfWidth = (this.map.players === 4 ? COURT.width : COURT.singlesWidth) / 2;
        const inCourt = Math.abs(this.ball.pos.x) <= halfWidth &&
                        Math.abs(this.ball.pos.z) <= COURT.length / 2;
        if (this.ball.bounces === 1 && !inCourt) {
          // Out: the team that hit it loses the point.
          return this.endPoint(1 - this.lastHitTeam, 'out');
        }
        if (this.ball.bounces >= 2) {
          // Double bounce on side X → X failed to return.
          const side = this.ball.pos.z > 0 ? 0 : 1;
          return this.endPoint(1 - side, 'double_bounce');
        }
      }
    }
    // Escaped past the back wall without bouncing in (e.g. long lob) — out.
    if (Math.abs(this.ball.pos.z) > COURT.length / 2 + 6 && this.ball.bounces === 0) {
      if (this.awaitingServeBounce) return this.faultServe('out');
      return this.endPoint(1 - this.lastHitTeam, 'out');
    }
    this.tryHits();
  }

  tryHits() {
    if (!this.ball || this.ball.bounces > 1) return;
    // A serve must bounce in the box before it can be returned — otherwise a
    // returner who reaches it in the air would volley the serve, and the
    // serve-bounce bookkeeping (awaitingServeBounce) would never clear, mis-
    // attributing the next net contact as a serve fault.
    if (this.awaitingServeBounce) return;
    const receivingTeam = this.ball.vel.z > 0 ? 0 : 1;
    if (receivingTeam === this.lastHitTeam && this.rallyLength > 0) return; // no hitting it back to yourself mid-flight
    // Nearest eligible teammate takes the ball (prevents doubles double-swings).
    const candidates = this.players
      .filter(p => p.team === receivingTeam && p.swingCooldown <= 0)
      .map(p => ({ p, dx: Math.abs(this.ball.pos.x - p.body.pos.x), dz: Math.abs(this.ball.pos.z - p.body.pos.z) }))
      .filter(c => c.dx < REACH_X && c.dz < REACH_Z && this.ball.pos.y < 3.0)
      .sort((a, b) => (a.dx + a.dz) - (b.dx + b.dz));
    if (!candidates.length) return;
    const player = candidates[0].p;

    let action, aim = null, power = null;
    if (player.controlledBySlot !== null) {
      if (!player.armed) return; // human at the ball but no swipe armed — ball passes
      action = player.armed.action;
      aim = player.armed.aim;
      power = player.armed.power;
      player.armed = null;
    } else {
      action = player.ai.chooseShot(
        { pos: this.ball.pos, vel: this.ball.vel },
        player.body.pos,
        this.opponentPos(player.team),
      ).action;
    }
    this.hit(player, action, aim, power);
  }

  opponentPos(team) {
    const opp = this.players.filter(p => p.team !== team);
    return opp[0]?.body.pos ?? null;
  }

  // Forward-simulate the current ball to its first bounce and return the
  // landing point (so we can keep shots inside the court — depth AND width).
  landingPoint() {
    const test = new Ball({ pos: { ...this.ball.pos }, vel: { ...this.ball.vel }, spin: { ...this.ball.spin } });
    for (let i = 0; i < 600; i++) {
      if (test.step(1 / 120, this.surface) === 'bounce') break;
    }
    return { x: test.pos.x, z: test.pos.z };
  }
  landingZ() { return this.landingPoint().z; }

  // Ease a shot's horizontal pace (vx, vz together — keeps the aimed
  // direction, preserves the vertical arc / net clearance) until it lands
  // inside the given bounds. Guarantees the ball cannot sail out.
  keepLandingWithin(maxZ, maxX) {
    for (let i = 0; i < 22; i++) {
      const lp = this.landingPoint();
      if (Math.abs(lp.z) <= maxZ && Math.abs(lp.x) <= maxX) break;
      this.ball.vel.x *= 0.9;
      this.ball.vel.z *= 0.9;
    }
  }

  // Forward-simulate the current ball to the net plane (z=0) and return its
  // height there, so net-clearance accounts for real drag + spin. Returns
  // Infinity if the ball never reaches the net (e.g. hit backwards).
  heightAtNet() {
    const test = new Ball({ pos: { ...this.ball.pos }, vel: { ...this.ball.vel }, spin: { ...this.ball.spin } });
    for (let i = 0; i < 160; i++) {
      const z0 = test.pos.z;
      test.step(1 / 120, this.surface);
      if (z0 !== 0 && Math.sign(test.pos.z) !== Math.sign(z0)) {
        return test.pos.y; // height right after crossing the net plane
      }
      if (test.bounces > 0) return Infinity; // bounced before the net — irrelevant here
    }
    return Infinity;
  }

  hit(player, action, aim = null, swipePower = null) {
    const isHuman = player.controlledBySlot !== null;
    // At the net, a groundstroke becomes a volley automatically — players
    // never need a separate volley gesture.
    action = applyNetContext(action, Math.abs(player.body.pos.z));
    // A high sitter inside the court is smashed automatically (the phone has
    // no ball-height info, so the engine upgrades the swing). A deep player
    // keeps their lob.
    const insideCourt = Math.abs(player.body.pos.z) < COURT.length / 2 - 1;
    if (this.ball.pos.y >= 1.9 && insideCourt && action !== 'slice') {
      action = 'smash';
    }
    const profile = SHOT_PROFILES[action] ?? SHOT_PROFILES.flat;
    const dir = player.team === 0 ? -1 : 1;
    const traits = player.character?.traits ?? {};
    // Power: a human's swipe SPEED drives pace; AI uses a competent default.
    const power = (action === 'smash' ? 1
      : isHuman && swipePower != null ? swipePower
      : 0.55 + 0.35 * this.rng()) * (traits.power ?? 1);
    // Aim: a human's swipe direction sets placement (aim ∈ [-1,1]); AI targets
    // the open court. Team 1's screen-right is world -x, so flip a human's aim.
    const rawAim = aim != null ? aim : player.move.x;
    const humanAim = player.team === 1 ? -rawAim : rawAim;
    let aimX = isHuman
      ? humanAim * (COURT.singlesWidth / 2 - 0.3)
      : (this.opponentPos(player.team)?.x >= 0 ? -1 : 1) * (COURT.singlesWidth / 2 - 0.8);

    // AI unforced errors: even a reachable ball is sometimes mishit, so rallies
    // end on mistakes like real tennis. Scales with difficulty.
    let depthScale = 1, netDump = false;
    if (!isHuman) {
      const errorChance = (1 - this.difficulty) * 0.16 + 0.04;
      if (this.rng() < errorChance) {
        const r = this.rng();
        if (r < 0.4) aimX *= 1.7 + this.rng();        // spray it wide
        else if (r < 0.7) depthScale = 1.3 + this.rng() * 0.3; // overcook → long
        else netDump = true;                          // dump it into the net
      }
    }

    // A slice drop shot stays soft regardless of swipe speed, so it lands
    // short instead of carrying out.
    const effPower = action === 'slice' ? Math.min(power, 0.5) : power;
    const vz = dir * profile.speed * (0.75 + 0.45 * Math.min(1, effPower)) * depthScale;
    this.ball.vel = { x: (aimX - this.ball.pos.x) * 0.55, y: profile.lift, z: vz };
    this.ball.spin = { x: dir * profile.spin * (action === 'topspin' ? (traits.topspin ?? 1) : 1), y: 0, z: 0 };
    this.ball.bounces = 0;

    // Net clearance — done by ACTUALLY simulating the shot to the net plane
    // (so drag and topspin dip are accounted for, unlike a kinematic guess).
    // A clean shot is lifted until it clears by a margin; a netDump error is
    // pushed down until it's guaranteed to fail into the net.
    const netTop = COURT.netHeight + BALL.radius;
    if (netDump) {
      for (let i = 0; i < 8 && this.heightAtNet() > netTop - 0.05; i++) this.ball.vel.y -= 1.0;
    } else {
      for (let i = 0; i < 10 && this.heightAtNet() < netTop + 0.28; i++) this.ball.vel.y += 1.0;
    }

    // Keep a human's shot IN — both depth and width, with a safety margin so
    // it lands comfortably inside the lines (not right on the baseline). Eases
    // horizontal pace only, so the arc still clears the net. A slice naturally
    // becomes a short drop shot; nothing sails long or wide.
    //
    // A LOB travels high and slow, so a small change in the integration step
    // (this predictor runs at a fixed dt, the live loop may not) swings its long
    // carry by more than a flat drive's — and a lob that lands right on the
    // baseline reads as "out" in real play. So give lobs a deeper buffer: they
    // land well inside the baseline while the tall arc still clears the net.
    if (isHuman) {
      // Keep the shot IN, but decouple DEPTH from PLACEMENT so sharp cross-court
      // angles are actually reachable. The old combined clamp eased vx and vz
      // together, so pulling a long shot in also straightened it out — a full
      // swipe barely moved the ball ~1 m sideways. Now:
      const depthMargin = action === 'lob' ? 2.0 : 1.0;       // lobs land well inside the baseline
      const maxZ = COURT.length / 2 - depthMargin;
      const maxX = COURT.singlesWidth / 2 - 0.2;
      // 1) DEPTH — ease forward pace (vz only) until it lands inside the baseline.
      for (let i = 0; i < 22; i++) {
        if (Math.abs(this.landingPoint().z) <= maxZ) break;
        this.ball.vel.z *= 0.9;
      }
      // 2) PLACEMENT — solve lateral pace (vx only) so the first bounce lands at
      // the AIMED x (true angle), against the real flight sim.
      const reach = Math.min(maxX, COURT.singlesWidth / 2 - 0.5);
      const aimTargetX = Math.max(-reach, Math.min(reach, humanAim * reach));
      for (let i = 0; i < 16; i++) {
        this.ball.vel.x += (aimTargetX - this.landingPoint().x) * 0.6;
      }
      // 3) WIDTH safety — never let it sail past the sideline.
      for (let i = 0; i < 10; i++) {
        if (Math.abs(this.landingPoint().x) <= maxX) break;
        this.ball.vel.x *= 0.9;
      }
    }
    this.lastHitTeam = player.team;
    this.lastShot = action;
    this.rallyLength++;
    player.swingCooldown = 0.35;
    // Intended (aim/power the swipe asked for) vs. actual (struck velocity and
    // where physics says it lands) — the record for "my shot went the wrong way".
    if (this.log) {
      const lp = this.landingPoint();
      this.logEvent('shot', {
        player: player.index, slot: player.controlledBySlot, isHuman, action,
        intendedAim: isHuman ? (aim != null ? aim : player.move.x) : null,
        intendedPower: isHuman ? (swipePower != null ? swipePower : null) : null,
        aiError: !isHuman && netDump ? 'net_dump' : (!isHuman && depthScale > 1 ? 'overcook' : null),
        contact: { x: Math.round(this.ball.pos.x * 100) / 100, y: Math.round(this.ball.pos.y * 100) / 100, z: Math.round(this.ball.pos.z * 100) / 100 },
        vel: { x: Math.round(this.ball.vel.x * 100) / 100, y: Math.round(this.ball.vel.y * 100) / 100, z: Math.round(this.ball.vel.z * 100) / 100 },
        predictedLanding: { x: Math.round(lp.x * 100) / 100, z: Math.round(lp.z * 100) / 100 },
        rallyLength: this.rallyLength,
      }, netDump ? 'warn' : 'info');
    }
    this.emit('hit', {
      player: player.index, slot: player.controlledBySlot, action, power,
      pos: { ...this.ball.pos }, rallyLength: this.rallyLength,
      ballSpeed: Math.abs(this.ball.vel.z),
    });
  }

  // Tune the current serve's ARC (vy) and WIDTH (vx) so its first bounce lands
  // at (tX, tZ) — leaving vz (the trait-driven pace) untouched. A damped
  // fixed-point iteration on the real flight sim: more vy ⇒ the ball carries
  // deeper, more vx ⇒ it lands wider. Then ensure it clears the net.
  solveServeLanding(tX, tZ, dir) {
    for (let i = 0; i < 28; i++) {
      const lp = this.landingPoint();
      this.ball.vel.y += (tZ - lp.z) * dir * 0.35; // deeper target needs a higher arc
      this.ball.vel.x += (tX - lp.x) * 0.5;
    }
    const netTop = COURT.netHeight + BALL.radius;
    // Clear the cord by a healthy margin (finer, more iterations than before) so
    // honest serves don't catch the tape — the dominant cause of "it looked in
    // but FAULT". vz (pace) is untouched, so a harder swipe still serves faster.
    for (let i = 0; i < 16 && this.heightAtNet() < netTop + 0.33; i++) this.ball.vel.y += 0.5;
  }

  // Did a struck serve land in the diagonally-correct service box? (Past the
  // net on the receiver's side, inside the service line and the singles line,
  // in the correct deuce/ad half.)
  serveLandedInBox(x, z) {
    const t = this.serveTarget;
    if (!t) return true;
    return Math.sign(z) === t.dir && Math.abs(z) <= COURT.serviceLine &&
           Math.sign(x) === t.xSign && Math.abs(x) <= COURT.singlesWidth / 2;
  }

  // A serve that missed the box. First fault → a second serve; second fault →
  // DOUBLE FAULT, the point to the receiver.
  faultServe(reason) {
    const servingTeam = this.lastHitTeam;
    // Classify WHERE it missed so the TV can say why ("into the net" / "long" /
    // "wide") — otherwise a serve that lands deep on the court reads as a
    // mystery "FAULT" to the player.
    let detail = 'out';
    if (reason === 'net') {
      detail = 'net';
    } else if (this.ball) {
      const long = Math.abs(this.ball.pos.z) > COURT.serviceLine;
      const wide = Math.abs(this.ball.pos.x) > COURT.singlesWidth / 2;
      detail = long && wide ? 'long & wide' : long ? 'long' : wide ? 'wide' : 'out';
    }
    // A serve ruled fault that ACTUALLY bounced inside the box is the classic
    // "looked in but FAULT" bug — flag it loudly so the report catches it.
    if (reason !== 'net' && this.ball && this.serveLandedInBox(this.ball.pos.x, this.ball.pos.z)) {
      this.logEvent('contradiction', {
        what: 'serve_in_box_but_fault', detail,
        landing: { x: Math.round(this.ball.pos.x * 100) / 100, z: Math.round(this.ball.pos.z * 100) / 100 },
        box: this.serveTarget ? { ...this.serveTarget } : null,
      }, 'warn');
    }
    this.awaitingServeBounce = false;
    this.ball = null;
    this.emit('fault', { team: servingTeam, serveNumber: this.serveNumber, reason, detail });
    if (this.serveNumber === 1) {
      this.serveNumber = 2;
      this.setState('serve_pending', 'fault');
      this.serveTimer = SERVE_DELAY;
      this.serveAnnounced = false;   // re-prompt the human for the second serve
      this.positionForServe();
    } else {
      this.emit('double_fault', { team: servingTeam });
      this.endPoint(1 - servingTeam, 'double_fault');
    }
  }

  endPoint(winningTeam, reason) {
    this.serveNumber = 1;            // next point starts on a first serve
    this.awaitingServeBounce = false;
    const events = this.score.pointWon(winningTeam);
    this.emit('point', {
      team: winningTeam, reason,
      winningShot: this.lastShot, rallyLength: this.rallyLength,
      isPressurePoint: this.score.isPressurePoint,
      display: this.score.gameDisplay,
      games: [...this.score.games], setsWon: [...this.score.setsWon],
    });
    for (const e of events) {
      if (e.type === 'game') this.emit('game', { team: e.team });
      if (e.type === 'set') this.emit('set', { team: e.team, games: e.games });
      if (e.type === 'match') this.emit('match', { team: e.team });
    }
    this.ball = null;
    if (this.score.completed) {
      this.setState('finished', 'match_complete');
    } else {
      this.setState('serve_pending', 'next_point');
      this.serveTimer = SERVE_DELAY;
      this.serveAnnounced = false; // re-announce on the next point's serve
      this.positionForServe();     // reset both players to the correct sides
    }
  }

  // ----- pause/resume support (feeds the server's snapshot machinery) -----

  serialize() {
    return structuredClone({
      mode: this.mode, surfaceName: this.surfaceName,
      state: this.state, serveTimer: this.serveTimer,
      tossAge: this.tossAge, serveAuto: this.serveAuto,
      serveNumber: this.serveNumber, awaitingServeBounce: this.awaitingServeBounce, serveTarget: this.serveTarget,
      lastHitTeam: this.lastHitTeam, lastShot: this.lastShot, rallyLength: this.rallyLength,
      score: this.score.snapshot(),
      scoreInternal: {
        points: this.score.points, games: this.score.games, sets: this.score.sets,
        setsWon: this.score.setsWon, inTiebreak: this.score.inTiebreak,
        tiebreakPoints: this.score.tiebreakPoints, server: this.score.server,
        tiebreakFirstServer: this.score.tiebreakFirstServer,
        completed: this.score.completed, winner: this.score.winner,
      },
      ball: this.ball ? { pos: this.ball.pos, vel: this.ball.vel, spin: this.ball.spin, bounces: this.ball.bounces } : null,
      players: this.players.map(p => ({ pos: p.body.pos, vel: p.body.vel, controlledBySlot: p.controlledBySlot })),
    });
  }

  restore(snap) {
    this.state = snap.state;
    this.serveTimer = snap.serveTimer;
    this.tossAge = snap.tossAge ?? 0;
    this.serveAuto = snap.serveAuto ?? false;
    this.serveNumber = snap.serveNumber ?? 1;
    this.awaitingServeBounce = snap.awaitingServeBounce ?? false;
    this.serveTarget = snap.serveTarget ?? null;
    this.lastHitTeam = snap.lastHitTeam;
    this.lastShot = snap.lastShot;
    this.rallyLength = snap.rallyLength;
    Object.assign(this.score, structuredClone(snap.scoreInternal));
    this.ball = snap.ball
      ? new Ball({ pos: snap.ball.pos, vel: snap.ball.vel, spin: snap.ball.spin })
      : null;
    if (this.ball) this.ball.bounces = snap.ball.bounces;
    snap.players.forEach((sp, i) => {
      this.players[i].body.pos = { ...sp.pos };
      this.players[i].body.vel = { ...sp.vel };
      this.players[i].controlledBySlot = sp.controlledBySlot;
    });
  }
}
