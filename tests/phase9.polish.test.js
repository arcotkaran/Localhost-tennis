// Testing Gate 9: audiovisual polish.
// Synth recipes must cover every sample the AudioDirector can emit, with
// the right loudness/brightness character; player model specs must be
// valid, team-colored, and character-accented; swing/clip poses must be
// well-formed animation curves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthRecipe, recipeLoudness } from '../client_host/js/audio-synth.js';
import { SAMPLES, AudioDirector } from '../client_host/js/audio-manager.js';
import { playerModelSpec, swingPose, clipPose, CLIP_POSES, SWING_DURATION } from '../client_host/js/player-model.js';
import { ROSTER } from '../shared/roster.js';
import { ACTIONS } from '../shared/protocol.js';
import { CLIPS, entrySequence, postMatchSequence } from '../client_host/js/interactions.js';
import { actorPose } from '../shared/session.js';

// ---------- synth coverage & character ----------

test('every sample the AudioDirector can emit has a synth recipe', () => {
  const allSamples = [
    ...Object.values(SAMPLES.racket),
    ...Object.values(SAMPLES.bounce),
    ...SAMPLES.grunt,
    ...Object.values(SAMPLES.crowd).filter(Boolean),
  ];
  for (const sample of allSamples) {
    const recipe = synthRecipe({ sample, volume: 0.8, pitch: 1 });
    assert.ok(Array.isArray(recipe) && recipe.length > 0, `recipe for ${sample}`);
    for (const v of recipe) {
      assert.ok(['noise', 'osc'].includes(v.kind), `${sample}: valid voice kind`);
      assert.ok(v.attack > 0 && v.decay > 0 && v.gain > 0, `${sample}: positive envelope`);
      assert.ok(Number.isFinite(v.gain) && v.gain <= 1, `${sample}: sane gain`);
      if (v.kind === 'osc') assert.ok(v.freq > 20 && v.freq < 8000, `${sample}: audible freq`);
    }
  }
  assert.equal(synthRecipe({ sample: null }), null, 'silence stays silent');
});

test('sound character: smash loudest thwack, clay dullest bounce, grunts scale', () => {
  const loud = s => recipeLoudness(synthRecipe({ sample: s, volume: 0.8 }));
  assert.ok(loud('thwack_smash') > loud('thwack_soft'), 'smash > lob thwack');
  const filt = s => synthRecipe({ sample: s, volume: 0.8 }).find(v => v.kind === 'noise').filter.freq;
  assert.ok(filt('bounce_hard') > filt('bounce_grass') && filt('bounce_grass') > filt('bounce_clay'),
    'bounce brightness: hard > grass > clay');
  assert.ok(loud('grunt_hard') > loud('grunt_mid') && loud('grunt_mid') > loud('grunt_soft'),
    'grunt tiers scale in loudness');
  assert.ok(loud('crowd_cheer') > loud('crowd_murmur'), 'cheer drowns the murmur');
  // Volume scaling flows through descriptors end-to-end.
  const audio = new AudioDirector();
  const soft = audio.racketHit({ action: 'flat', power: 0.2, pos: { x: 0 } });
  const hard = audio.racketHit({ action: 'flat', power: 1.0, pos: { x: 0 } });
  assert.ok(recipeLoudness(synthRecipe(hard)) > recipeLoudness(synthRecipe(soft)));
});

// ---------- player models ----------

test('every roster character gets a valid, team-colored, accented model', () => {
  const seen = new Set();
  for (const character of ROSTER) {
    for (const team of [0, 1]) {
      const spec = playerModelSpec(character, team);
      const names = spec.parts.map(p => p.name);
      for (const required of ['torso', 'head', 'armR', 'racketHandle', 'racketHead']) {
        assert.ok(names.includes(required), `${character.id}: has ${required}`);
      }
      const torso = spec.parts.find(p => p.name === 'torso');
      assert.equal(torso.color, team === 0 ? 0x4ad8f0 : 0xf04a4a, 'kit matches team');
      for (const p of spec.parts) {
        assert.ok(p.size.every(Number.isFinite) && p.pos.every(Number.isFinite), `${character.id}/${p.name}: finite geometry`);
      }
      const racketParts = spec.parts.filter(p => p.parent === 'armR');
      assert.ok(racketParts.length >= 2, 'racket is parented to the swinging arm');
    }
    seen.add(JSON.stringify(playerModelSpec(character, 0).parts.map(p => p.name).sort()));
  }
  // Nadal's headband is distinct.
  const nadal = playerModelSpec(ROSTER.find(p => p.id === 'nadal'), 0);
  assert.ok(nadal.parts.some(p => p.name === 'headband'), 'Nadal wears the headband');
  // Guests get a model too.
  const guest = playerModelSpec(null, 1);
  assert.ok(guest.parts.some(p => p.name === 'torso'));
});

// ---------- animation curves ----------

test('swing poses: rest at endpoints, peak mid-swing, smash goes overhead', () => {
  for (const action of ACTIONS) {
    const start = swingPose(action, 0);
    const mid = swingPose(action, 0.5);
    const end = swingPose(action, 1);
    assert.ok(Math.abs(start.armSwing) < 0.01 && Math.abs(end.armSwing) < 0.01,
      `${action}: arm at rest at the endpoints`);
    assert.ok(Math.abs(mid.armSwing) > 0.5, `${action}: real swing at the peak`);
    assert.ok(Number.isFinite(mid.torsoTwist) && Number.isFinite(mid.crouch));
  }
  assert.equal(swingPose('smash', 0.5).overhead, true);
  assert.ok(swingPose('smash', 0.5).armSwing < -2, 'smash arm rises overhead');
  assert.ok(swingPose('volley', 0.5).armSwing < swingPose('topspin', 0.5).armSwing,
    'volley is a compact punch, topspin a full swing');
  assert.ok(SWING_DURATION > 0.2 && SWING_DURATION < 0.6, 'swing duration is visible but snappy');
});

test('every cinematic clip maps to a renderable pose', () => {
  // Collect every pose name actorPose can output across all clips.
  const clips = [
    ...entrySequence([{ id: 'a', team: 0 }, { id: 'b', team: 1 }]).timeline,
    ...postMatchSequence([{ id: 'a', team: 0 }, { id: 'b', team: 1 }], 0).timeline,
    { clip: CLIPS.RACKET_TAP, at: 0, duration: 1 },
  ];
  for (const item of clips) {
    for (const t of [0.1, 0.5, 0.9]) {
      const pose = actorPose(item, item.at + item.duration * t, 0, { x: 0, z: 10 });
      assert.ok(CLIP_POSES.includes(pose.pose), `clip ${item.clip} samples to known pose "${pose.pose}"`);
      const angles = clipPose(pose.pose, t, 1.2);
      assert.ok(Number.isFinite(angles.armSwing) && Number.isFinite(angles.bob ?? 0),
        `pose ${pose.pose} produces finite animation values`);
    }
  }
  // Trophy lift raises the arm like a celebration should.
  assert.ok(clipPose('lift', 0.5).armSwing < -2, 'trophy lift arm goes up');
});
