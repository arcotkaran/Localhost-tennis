// Digital joystick math: converts raw touch deltas into a precise, clamped,
// deadzoned movement vector in [-1, 1]² (unit-circle clamped).

export const DEADZONE = 0.07;

export class Joystick {
  constructor(radiusPx = 60) {
    this.radius = radiusPx;
    this.active = false;
    this.origin = { x: 0, y: 0 };
    this.value = { x: 0, y: 0 };
  }

  start(x, y) {
    this.active = true;
    this.origin = { x, y };
    this.value = { x: 0, y: 0 };
  }

  move(x, y) {
    if (!this.active) return this.value;
    let dx = (x - this.origin.x) / this.radius;
    let dy = (y - this.origin.y) / this.radius;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }            // clamp to unit circle
    if (mag < DEADZONE) { dx = 0; dy = 0; }            // deadzone for drift
    this.value = { x: dx, y: dy };
    return this.value;
  }

  end() {
    this.active = false;
    this.value = { x: 0, y: 0 };
    return this.value;
  }

  // Thumb position for rendering, in px relative to base center.
  get thumbOffset() {
    return { x: this.value.x * this.radius, y: this.value.y * this.radius };
  }
}
