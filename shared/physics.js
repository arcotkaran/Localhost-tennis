// Core ball & player physics. Tuned for "Top Spin"-grade heavy realism:
// true gravity, quadratic aerodynamic drag, and the Magnus effect so
// topspin dives and slices float. Surface models change both the bounce
// and player movement (clay sliding).
//
// Coordinates: x = court width, y = up, z = court length.
// Units: meters, seconds, kg, rad/s.

export const G = 9.81;
export const BALL = {
  mass: 0.057,          // ITF regulation ball
  radius: 0.0335,
  area: Math.PI * 0.0335 * 0.0335,
  dragCoeff: 0.55,      // measured Cd for tennis balls
  magnusCoeff: 1.0,     // lift scaling
};
export const AIR_DENSITY = 1.21;

// Court dimensions (doubles court), used by gameplay + AI.
export const COURT = {
  length: 23.77, width: 10.97, singlesWidth: 8.23,
  netHeight: 0.914, serviceLine: 6.40,
};

// Surface dynamics:
//   restitution  — vertical energy return (bounce height)
//   gripRetention — horizontal speed kept through the bounce (pace)
//   playerFriction — deceleration of a sliding player (m/s²)
//   slides — clay allows controlled momentum slides
export const SURFACES = {
  grass: { restitution: 0.60, gripRetention: 0.86, playerFriction: 11.0, slides: false },
  hard:  { restitution: 0.73, gripRetention: 0.76, playerFriction: 12.5, slides: false },
  clay:  { restitution: 0.82, gripRetention: 0.62, playerFriction: 5.5,  slides: true  },
};

const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const mag = v => Math.hypot(v.x, v.y, v.z);

export class Ball {
  constructor({ pos, vel, spin = { x: 0, y: 0, z: 0 }, drag = true } = {}) {
    this.pos = { ...pos };
    this.vel = { ...vel };
    this.spin = { ...spin }; // angular velocity; +x component = topspin for +z travel
    this.drag = drag;
    this.bounces = 0;
  }

  // Net acceleration from gravity, drag, and Magnus lift.
  acceleration() {
    const a = { x: 0, y: -G, z: 0 };
    const speed = mag(this.vel);
    if (speed > 1e-9) {
      if (this.drag) {
        // Quadratic drag opposing motion: F = -½ρCdA|v|v
        const k = 0.5 * AIR_DENSITY * BALL.dragCoeff * BALL.area * speed / BALL.mass;
        a.x -= k * this.vel.x;
        a.y -= k * this.vel.y;
        a.z -= k * this.vel.z;
      }
      // Magnus: F = Cm·ρ·A·r·(ω × v). Perpendicular to v — does no work,
      // so it can redirect but never add energy. Topspin (ω.x>0 moving +z)
      // pulls the ball down; backspin/slice lifts it.
      const m = (BALL.magnusCoeff * AIR_DENSITY * BALL.area * BALL.radius) / BALL.mass;
      const f = cross(this.spin, this.vel);
      a.x += m * f.x;
      a.y += m * f.y;
      a.z += m * f.z;
    }
    return a;
  }

  // Semi-implicit Euler step; returns 'bounce' when the ball strikes the court.
  step(dt, surface = SURFACES.hard) {
    const a = this.acceleration();
    this.vel.x += a.x * dt;
    this.vel.y += a.y * dt;
    this.vel.z += a.z * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    if (this.pos.y <= BALL.radius && this.vel.y < 0) {
      this.bounceOff(surface);
      return 'bounce';
    }
    return 'air';
  }

  bounceOff(surface) {
    this.pos.y = BALL.radius;
    this.vel.y = -surface.restitution * this.vel.y;
    // Pace retention through the bounce + spin/court interaction:
    // topspin grips and kicks forward, slice checks up.
    const spinKick = 1 + 0.04 * Math.tanh(this.spin.x / 200);
    this.vel.x *= surface.gripRetention;
    this.vel.z *= surface.gripRetention * spinKick;
    // Friction with the court scrubs spin.
    this.spin.x *= 0.65;
    this.spin.y *= 0.65;
    this.spin.z *= 0.65;
    this.bounces++;
    // Settle: kill negligible bounce energy so the ball comes to rest.
    if (Math.abs(this.vel.y) < 0.15) this.vel.y = 0;
  }

  get atRest() {
    return this.pos.y <= BALL.radius + 1e-6 && mag(this.vel) < 0.05;
  }

  // Total mechanical energy (for conservation tests).
  energy() {
    const speed = mag(this.vel);
    return 0.5 * BALL.mass * speed * speed + BALL.mass * G * (this.pos.y - BALL.radius);
  }
}

// Simulate until first bounce; returns landing info.
export function simulateFlight(ball, surface = SURFACES.hard, dt = 1 / 240, maxT = 20) {
  let apex = ball.pos.y;
  for (let t = 0; t < maxT; t += dt) {
    apex = Math.max(apex, ball.pos.y);
    if (ball.step(dt, surface) === 'bounce') {
      return { landing: { ...ball.pos }, flightTime: t + dt, apex, ball };
    }
  }
  return null; // never landed — a physics bug
}

// ----- player movement with surface-dependent momentum & clay sliding -----

export class PlayerBody {
  // Higher accel = the player responds to the stick almost immediately
  // instead of floating up to speed (tuned for "real match" snap). Top speed
  // stays human (~8.5 m/s) so defense isn't superhuman and rallies still end.
  constructor({ pos = { x: 0, z: 0 }, maxSpeed = 8.5, accel = 48 } = {}) {
    this.pos = { ...pos };
    this.vel = { x: 0, z: 0 };
    this.maxSpeed = maxSpeed;
    this.accel = accel;
    this.sliding = false;
  }

  // input: joystick vector in [-1,1]². With no input the player decelerates
  // by surface friction — low-friction clay produces long momentum slides.
  step(dt, input, surface = SURFACES.hard) {
    const inMag = Math.hypot(input.x, input.y);
    if (inMag > 0.01) {
      this.vel.x += input.x * this.accel * dt;
      this.vel.z += input.y * this.accel * dt;
      const s = Math.hypot(this.vel.x, this.vel.z);
      if (s > this.maxSpeed) {
        this.vel.x *= this.maxSpeed / s;
        this.vel.z *= this.maxSpeed / s;
      }
      this.sliding = false;
    } else {
      const s = Math.hypot(this.vel.x, this.vel.z);
      if (s > 1e-6) {
        const drop = surface.playerFriction * dt;
        const ns = Math.max(0, s - drop);
        this.vel.x *= ns / s;
        this.vel.z *= ns / s;
        this.sliding = surface.slides && ns > 1.5;
      } else {
        this.sliding = false;
      }
    }
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
  }
}

// Distance covered after input release until stopping — clay slide length.
export function slideDistance(speed, surface, dt = 1 / 240) {
  const p = new PlayerBody();
  p.vel = { x: 0, z: speed };
  const z0 = p.pos.z;
  let guard = 0;
  while (Math.hypot(p.vel.x, p.vel.z) > 1e-3 && guard++ < 100_000) {
    p.step(dt, { x: 0, y: 0 }, surface);
  }
  return p.pos.z - z0;
}
