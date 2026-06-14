// Stylized player models and procedural animation poses. Pure spec
// builders — the renderer turns specs into Three.js groups, so everything
// here is node-testable.
//
// Articulation: parts with a `pivot` become rotation groups (shoulders,
// hips, neck) so walk cycles, swings, gestures, and head movement read as
// real body language. Face parts (eyes, brows, mouth) sit on the head and
// are driven by the EmotionEngine's expressionFor().

const SKIN_TONES = [0xd9a06b, 0xe8c39e, 0xa9744f, 0xc68955];
const TEAM_KITS = [0x4ad8f0, 0xf04a4a]; // blue / red
const TEAM_SHORTS = [0x16384a, 0x4a1616];

// Character accents keep the icons recognizable at capsule scale.
const ACCENTS = {
  federer:  { headgear: 'bandana', headgearColor: 0x1a1a2e, skin: 1 },
  djokovic: { headgear: 'none', headgearColor: 0, skin: 1 },
  nadal:    { headgear: 'headband', headgearColor: 0xff7700, skin: 2 },
  kyrgios:  { headgear: 'cap', headgearColor: 0x222222, skin: 2 },
  murray:   { headgear: 'cap', headgearColor: 0xffffff, skin: 1 },
};

export function playerModelSpec(character, team) {
  const accent = ACCENTS[character?.id] ?? { headgear: 'none', headgearColor: 0, skin: (team + 1) % SKIN_TONES.length };
  const kit = TEAM_KITS[team];
  const skin = SKIN_TONES[accent.skin];
  const parts = [
    { name: 'torso', geo: 'capsule', size: [0.26, 0.5], color: kit, pos: [0, 1.08, 0] },
    { name: 'shorts', geo: 'capsule', size: [0.24, 0.18], color: TEAM_SHORTS[team], pos: [0, 0.78, 0] },
    // Neck pivot carries the head + face + headgear for tilts and shakes.
    { name: 'head', geo: 'sphere', size: [0.16], color: skin, pos: [0, 1.62, 0], pivot: [0, 1.5, 0] },
    { name: 'eyeL', geo: 'sphere', size: [0.022], color: 0x111111, pos: [-0.055, 1.645, 0.135], parent: 'head' },
    { name: 'eyeR', geo: 'sphere', size: [0.022], color: 0x111111, pos: [0.055, 1.645, 0.135], parent: 'head' },
    { name: 'browL', geo: 'box', size: [0.055, 0.011, 0.012], color: 0x21150c, pos: [-0.055, 1.685, 0.142], parent: 'head' },
    { name: 'browR', geo: 'box', size: [0.055, 0.011, 0.012], color: 0x21150c, pos: [0.055, 1.685, 0.142], parent: 'head' },
    { name: 'mouth', geo: 'torusArc', size: [0.045, 0.009], color: 0x7a2e2e, pos: [0, 1.575, 0.138], parent: 'head' },
    // Legs pivot at the hips for the run cycle.
    { name: 'legL', geo: 'capsule', size: [0.09, 0.42], color: 0xf5f5f5, pos: [-0.12, 0.42, 0], pivot: [-0.12, 0.68, 0] },
    { name: 'legR', geo: 'capsule', size: [0.09, 0.42], color: 0xf5f5f5, pos: [0.12, 0.42, 0], pivot: [0.12, 0.68, 0] },
    { name: 'shoeL', geo: 'sphere', size: [0.085], color: 0xfafafa, pos: [-0.12, 0.16, 0.03], parent: 'legL', scaleY: 0.6 },
    { name: 'shoeR', geo: 'sphere', size: [0.085], color: 0xfafafa, pos: [0.12, 0.16, 0.03], parent: 'legR', scaleY: 0.6 },
    // Both arms pivot at the shoulders; the racket rides the right arm.
    { name: 'armL', geo: 'capsule', size: [0.07, 0.4], color: skin, pos: [-0.34, 1.16, 0], pivot: [-0.34, 1.4, 0] },
    { name: 'armR', geo: 'capsule', size: [0.07, 0.4], color: skin, pos: [0.34, 1.16, 0], pivot: [0.34, 1.4, 0] },
    { name: 'racketHandle', geo: 'cylinder', size: [0.022, 0.34], color: 0x333333, pos: [0.36, 0.78, 0.05], parent: 'armR' },
    { name: 'racketHead', geo: 'torus', size: [0.13, 0.02], color: 0x111111, pos: [0.36, 0.55, 0.05], parent: 'armR' },
    { name: 'racketStrings', geo: 'circle', size: [0.12], color: 0xd8d8c8, pos: [0.36, 0.55, 0.05], parent: 'armR', opacity: 0.55 },
  ];
  if (accent.headgear === 'headband') {
    parts.push({ name: 'headband', geo: 'torus', size: [0.155, 0.025], color: accent.headgearColor, pos: [0, 1.66, 0], rot: [Math.PI / 2.4, 0, 0], parent: 'head' });
  } else if (accent.headgear === 'cap') {
    parts.push({ name: 'cap', geo: 'sphere', size: [0.165], color: accent.headgearColor, pos: [0, 1.67, 0.02], scaleY: 0.55, parent: 'head' });
    parts.push({ name: 'capBrim', geo: 'box', size: [0.18, 0.015, 0.12], color: accent.headgearColor, pos: [0, 1.64, 0.17], parent: 'head' });
  } else if (accent.headgear === 'bandana') {
    parts.push({ name: 'bandana', geo: 'sphere', size: [0.165], color: accent.headgearColor, pos: [0, 1.7, 0], scaleY: 0.4, parent: 'head' });
  }
  return { parts, teamColor: kit, characterId: character?.id ?? null };
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
