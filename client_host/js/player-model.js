// Stylized player models and procedural animation poses. Pure spec
// builders — the renderer turns specs into Three.js groups, so everything
// here is node-testable.
//
// Articulation: parts with a `pivot` become rotation groups (shoulders,
// hips, neck) so walk cycles, swings, gestures, and head movement read as
// real body language. Face parts (eyes, brows, mouth) sit on the head and
// are driven by the EmotionEngine's expressionFor().

const TEAM_KITS = [0x4ad8f0, 0xf04a4a]; // blue / red — torso stays team-colored for side ID
const TEAM_SHORTS = [0x16384a, 0x4a1616];

// Per-character appearance so each icon is recognizable at capsule scale:
// skin tone, hair color, build (girth) + height, signature headgear, kit
// details (sleeveless), shoe + wristband colors, optional chest logo.
const APPEARANCE = {
  // Headband, lean build, white kit accents, the RF chest mark.
  federer:  { skin: 0xe3b485, hair: 0x3a2517, headgear: 'headband', headgearColor: 0xf4f4f4, build: 0.98, height: 1.04, shoe: 0xffffff, wristband: 0xf4f4f4, sleeveless: false, logo: 0x141414 },
  // Tall, lean, neutral headband, deep-blue shoes.
  djokovic: { skin: 0xe6bd92, hair: 0x140f0a, headgear: 'headband', headgearColor: 0xcfd6dd, build: 1.0,  height: 1.06, shoe: 0x21356b, wristband: 0xffffff, sleeveless: false },
  // Sleeveless, stocky, tanned, the orange headband + bright shoes.
  nadal:    { skin: 0xbe824f, hair: 0x1a120c, headgear: 'headband', headgearColor: 0xff6a00, build: 1.18, height: 0.99, shoe: 0xff4400, wristband: 0xff6a00, sleeveless: true },
  // Cap, athletic, dark skin, the signature loud pink shoes + teal band.
  kyrgios:  { skin: 0x8f5d39, hair: 0x0b0b0b, headgear: 'cap', headgearColor: 0x141414, build: 1.08, height: 1.03, shoe: 0xff2bd6, wristband: 0x16e0c0, sleeveless: false },
  // White cap, fair skin, lighter brown hair, blue shoes.
  murray:   { skin: 0xe8caa6, hair: 0x6b4a2a, headgear: 'cap', headgearColor: 0xf0f0f0, build: 1.02, height: 1.02, shoe: 0x2f74ff, wristband: 0xffffff, sleeveless: false },
};
const DEFAULT_APPEARANCE = { skin: 0xd9a06b, hair: 0x2a1d12, headgear: 'none', headgearColor: 0, build: 1.0, height: 1.0, shoe: 0xfafafa, wristband: 0xdddddd, sleeveless: false };

export function playerModelSpec(character, team) {
  const ap = APPEARANCE[character?.id] ?? DEFAULT_APPEARANCE;
  const kit = TEAM_KITS[team];
  const skin = ap.skin;
  const b = ap.build;
  const parts = [
    { name: 'torso', geo: 'capsule', size: [0.26 * b, 0.5], color: kit, pos: [0, 1.08, 0] },
    { name: 'shorts', geo: 'capsule', size: [0.24 * b, 0.18], color: TEAM_SHORTS[team], pos: [0, 0.78, 0] },
    // Neck pivot carries the head + face + hair + headgear for tilts and shakes.
    { name: 'head', geo: 'sphere', size: [0.16], color: skin, pos: [0, 1.62, 0], pivot: [0, 1.5, 0] },
    { name: 'eyeL', geo: 'sphere', size: [0.022], color: 0x111111, pos: [-0.055, 1.645, 0.135], parent: 'head' },
    { name: 'eyeR', geo: 'sphere', size: [0.022], color: 0x111111, pos: [0.055, 1.645, 0.135], parent: 'head' },
    { name: 'browL', geo: 'box', size: [0.055, 0.011, 0.012], color: 0x21150c, pos: [-0.055, 1.685, 0.142], parent: 'head' },
    { name: 'browR', geo: 'box', size: [0.055, 0.011, 0.012], color: 0x21150c, pos: [0.055, 1.685, 0.142], parent: 'head' },
    { name: 'mouth', geo: 'torusArc', size: [0.045, 0.009], color: 0x7a2e2e, pos: [0, 1.575, 0.138], parent: 'head' },
    // Legs pivot at the hips for the run cycle.
    { name: 'legL', geo: 'capsule', size: [0.09, 0.42], color: 0xf5f5f5, pos: [-0.12, 0.42, 0], pivot: [-0.12, 0.68, 0] },
    { name: 'legR', geo: 'capsule', size: [0.09, 0.42], color: 0xf5f5f5, pos: [0.12, 0.42, 0], pivot: [0.12, 0.68, 0] },
    { name: 'shoeL', geo: 'sphere', size: [0.085], color: ap.shoe, pos: [-0.12, 0.16, 0.03], parent: 'legL', scaleY: 0.6 },
    { name: 'shoeR', geo: 'sphere', size: [0.085], color: ap.shoe, pos: [0.12, 0.16, 0.03], parent: 'legR', scaleY: 0.6 },
    // Both arms pivot at the shoulders; the racket rides the right arm.
    { name: 'armL', geo: 'capsule', size: [0.07 * b, 0.4], color: skin, pos: [-0.34, 1.16, 0], pivot: [-0.34, 1.4, 0] },
    { name: 'armR', geo: 'capsule', size: [0.07 * b, 0.4], color: skin, pos: [0.34, 1.16, 0], pivot: [0.34, 1.4, 0] },
    { name: 'racketHandle', geo: 'cylinder', size: [0.022, 0.34], color: 0x333333, pos: [0.36, 0.78, 0.05], parent: 'armR' },
    { name: 'racketHead', geo: 'torus', size: [0.13, 0.02], color: 0x111111, pos: [0.36, 0.55, 0.05], parent: 'armR' },
    { name: 'racketStrings', geo: 'circle', size: [0.12], color: 0xd8d8c8, pos: [0.36, 0.55, 0.05], parent: 'armR', opacity: 0.55 },
    // Signature wristband on the racket arm.
    { name: 'wristband', geo: 'torus', size: [0.072, 0.022], color: ap.wristband, pos: [0.34, 1.0, 0.02], rot: [Math.PI / 2, 0, 0], parent: 'armR' },
  ];
  // Sleeves (kit-colored caps over the shoulders). Nadal goes sleeveless.
  if (!ap.sleeveless) {
    parts.push({ name: 'sleeveL', geo: 'sphere', size: [0.11 * b], color: kit, pos: [-0.34, 1.33, 0], scaleY: 0.7, parent: 'armL' });
    parts.push({ name: 'sleeveR', geo: 'sphere', size: [0.11 * b], color: kit, pos: [0.34, 1.33, 0], scaleY: 0.7, parent: 'armR' });
  }
  // Hair shows when nothing covers the crown (headband / bare head). A cap or
  // bandana hides it. Sits on the crown + back so it never covers the face.
  if (ap.headgear === 'headband' || ap.headgear === 'none') {
    parts.push({ name: 'hair', geo: 'sphere', size: [0.168], color: ap.hair, pos: [0, 1.71, -0.03], scaleY: 0.6, parent: 'head' });
  }
  if (ap.headgear === 'headband') {
    parts.push({ name: 'headband', geo: 'torus', size: [0.158, 0.026], color: ap.headgearColor, pos: [0, 1.655, 0], rot: [Math.PI / 2.4, 0, 0], parent: 'head' });
  } else if (ap.headgear === 'cap') {
    parts.push({ name: 'cap', geo: 'sphere', size: [0.168], color: ap.headgearColor, pos: [0, 1.69, 0.02], scaleY: 0.55, parent: 'head' });
    parts.push({ name: 'capBrim', geo: 'box', size: [0.2, 0.015, 0.13], color: ap.headgearColor, pos: [0, 1.65, 0.18], parent: 'head' });
  } else if (ap.headgear === 'bandana') {
    parts.push({ name: 'bandana', geo: 'sphere', size: [0.168], color: ap.headgearColor, pos: [0, 1.71, 0], scaleY: 0.42, parent: 'head' });
  }
  // Federer's RF chest mark (static, sits on the torso — torso isn't articulated).
  if (ap.logo) {
    parts.push({ name: 'logo', geo: 'box', size: [0.075, 0.05, 0.012], color: ap.logo, pos: [0, 1.2, 0.25 * b] });
  }
  return { parts, teamColor: kit, characterId: character?.id ?? null, scale: ap.height };
}

// Names of the articulation groups the renderer must expose.
export const PIVOT_GROUPS = ['head', 'legL', 'legR', 'armL', 'armR'];
export const FACE_PARTS = ['eyeL', 'eyeR', 'browL', 'browR', 'mouth'];

// ----- procedural swing animation -----
// t01: 0 at swing start, 1 at completion. Returns radians for the racket
// arm and torso. Zero at both endpoints, peak action in the middle.

export const SWING_DURATION = 0.34; // seconds

export function swingPose(action, t01) {
  const t = Math.max(0, Math.min(1, t01));
  const arc = Math.sin(t * Math.PI);              // 0 → 1 → 0
  const whip = Math.sin(t * Math.PI * 2) * 0.5;   // follow-through wobble
  switch (action) {
    case 'smash':
      return { armSwing: -2.6 * arc, armLSwing: -0.6 * arc, torsoTwist: 0.35 * arc, crouch: 0.08 * arc, overhead: true };
    case 'lob':
      return { armSwing: 1.5 * arc, armLSwing: -0.3 * arc, torsoTwist: -0.25 * arc, crouch: 0.18 * arc, overhead: false };
    case 'slice':
      return { armSwing: 1.1 * arc + whip * 0.2, armLSwing: 0.4 * arc, torsoTwist: -0.45 * arc, crouch: 0.12 * arc, overhead: false };
    case 'volley':
      return { armSwing: 0.8 * arc, armLSwing: 0.2 * arc, torsoTwist: 0.15 * arc, crouch: 0.05 * arc, overhead: false };
    case 'topspin':
      return { armSwing: 1.9 * arc + whip * 0.3, armLSwing: -0.5 * arc, torsoTwist: 0.6 * arc, crouch: 0.15 * arc, overhead: false };
    default: // flat
      return { armSwing: 1.6 * arc + whip * 0.25, armLSwing: -0.4 * arc, torsoTwist: 0.5 * arc, crouch: 0.1 * arc, overhead: false };
  }
}

// ----- cinematic pose presets (entry, handshakes, celebration) -----

export function clipPose(pose, t01, walkPhase = 0) {
  switch (pose) {
    case 'walk': {
      const swing = Math.sin(walkPhase * 7);
      return { armSwing: swing * 0.45, armLSwing: -swing * 0.45,
               legSwing: -swing * 0.55, legLSwing: swing * 0.55,
               torsoTwist: 0, crouch: 0, bob: Math.abs(Math.sin(walkPhase * 7)) * 0.05 };
    }
    case 'wave':
      return { armSwing: -2.4 + Math.sin(t01 * Math.PI * 6) * 0.35, armLSwing: 0, torsoTwist: 0, crouch: 0, bob: 0 };
    case 'shake':
      return { armSwing: 0.9 + Math.sin(t01 * Math.PI * 8) * 0.12, armLSwing: 0, torsoTwist: 0.2, crouch: 0.05, bob: 0 };
    case 'tap':
      return { armSwing: 1.2, armLSwing: 0, torsoTwist: 0.3, crouch: 0.05, bob: 0 };
    case 'lift':
      return { armSwing: -2.9, armLSwing: -2.9, torsoTwist: 0, crouch: Math.max(0, 0.2 - t01 * 0.2), bob: Math.sin(t01 * Math.PI * 4) * 0.06 };
    default: // idle: subtle ready bounce, racket in front
      return { armSwing: 0.15, armLSwing: 0.15, torsoTwist: 0, crouch: 0.05, bob: 0 };
  }
}

export const CLIP_POSES = ['walk', 'wave', 'shake', 'tap', 'lift', 'idle'];
