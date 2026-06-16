// Testing Gate 9: audiovisual polish.
// Synth recipes must cover every sample the AudioDirector can emit, with
// the right loudness/brightness character; player model specs must be
// valid, team-colored, and character-accented; swing/clip poses must be
// well-formed animation curves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthRecipe, recipeLoudness } from '../client_host/js/audio-synth.js';
import { SAMPLES, AudioDirector } from '../client_host/js/audio-manager.js';
import { playerModelSpec, swingPose, clipPose, CLIP_POSES, SWING_DURATION, SWING_CONTACT } from '../client_host/js/player-model.js';
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

test('each roster character yields a DISTINCT, recognizable model', () => {
  const partOf = (spec, name) => spec.parts.find(p => p.name === name);
  const fingerprints = new Set();
  for (const character of ROSTER) {
    const spec = playerModelSpec(character, 0);
    // A distinct visual fingerprint across the whole roster (same team!).
    fingerprints.add(JSON.stringify({ parts: spec.parts, scale: spec.scale }));
    assert.ok(Number.isFinite(spec.scale) && spec.scale > 0.8 && spec.scale < 1.3,
      `${character.id}: sane height scale`);
    // Torso stays team-colored (side identification) even with per-character looks.
    assert.equal(partOf(spec, 'torso').color, 0x4ad8f0, `${character.id}: torso is the team kit`);
  }
  assert.equal(fingerprints.size, ROSTER.length, 'every roster character looks different');

  const spec = id => playerModelSpec(ROSTER.find(p => p.id === id), 0);

  // Signature gear — the things that make each player recognizable.
  const nadal = spec('nadal');
  assert.equal(partOf(nadal, 'headband').color, 0xff6a00, 'Nadal: orange headband');
  assert.ok(!partOf(nadal, 'sleeveL'), 'Nadal is sleeveless');
  assert.equal(partOf(nadal, 'shoeL').color, 0xff4400, 'Nadal: bright shoes');

  const federer = spec('federer');
  assert.ok(partOf(federer, 'headband'), 'Federer wears a headband');
  assert.ok(partOf(federer, 'logo'), 'Federer has the RF chest mark');

  const kyrgios = spec('kyrgios');
  assert.ok(partOf(kyrgios, 'cap'), 'Kyrgios wears a cap');
  assert.equal(partOf(kyrgios, 'shoeL').color, 0xff2bd6, 'Kyrgios: loud pink shoes');
  assert.ok(!partOf(kyrgios, 'hair'), 'cap hides the hair part');

  const murray = spec('murray');
  assert.equal(partOf(murray, 'cap').color, 0xf0f0f0, 'Murray: white cap');

  const djokovic = spec('djokovic');
  assert.ok(partOf(djokovic, 'headband'), 'Djokovic wears a headband');

  // Sleeved roster characters carry kit-colored sleeves over the shoulders.
  for (const id of ['federer', 'djokovic', 'kyrgios', 'murray']) {
    assert.ok(partOf(spec(id), 'sleeveR'), `${id} has a sleeve`);
  }

  // Distinct skin tones (the head color) across the roster.
  const skins = new Set(ROSTER.map(c => partOf(playerModelSpec(c, 0), 'head').color));
  assert.equal(skins.size, ROSTER.length, 'every character has a distinct skin tone');

  // Builds vary: Nadal is stockier than Federer (wider torso radius).
  assert.ok(partOf(nadal, 'torso').size[0] > partOf(federer, 'torso').size[0],
    'Nadal has a heavier build than Federer');
});

// ---------- animation curves ----------

test('swing poses: a real strike — settle at endpoints, drive through contact, smash overhead', () => {
  const samples = [0.1, SWING_CONTACT, 0.35, 0.5];
  const peakOf = action => Math.max(...samples.map(t => Math.abs(swingPose(action, t).armSwing)));
  for (const action of ACTIONS) {
    const start = swingPose(action, 0);
    const end = swingPose(action, 1);
    // Settles near the ready stance at both ends so it blends with idle (no pop).
    assert.ok(Math.abs(start.armSwing) < 0.35 && Math.abs(end.armSwing) < 0.35,
      `${action}: settles at the endpoints`);
    assert.ok(peakOf(action) > 0.6, `${action}: a real swing happens`);
    // The cross-body sweep is a distinct axis the renderer applies.
    assert.ok(Number.isFinite(swingPose(action, SWING_CONTACT).armAcross), `${action}: has a sweep axis`);
    const c = swingPose(action, SWING_CONTACT);
    assert.ok(Number.isFinite(c.torsoTwist) && Number.isFinite(c.crouch));
  }
  // Smash goes overhead (arm strongly up = very negative) around the wind-up/contact.
  const smashTop = Math.min(swingPose('smash', 0.1).armSwing, swingPose('smash', SWING_CONTACT).armSwing);
  assert.ok(smashTop < -1.5, 'smash rises overhead');
  assert.equal(swingPose('smash', SWING_CONTACT).overhead, true);
  // Volley is a compact punch; a topspin drive is a fuller swing.
  assert.ok(peakOf('volley') < peakOf('topspin'), 'volley is compact, topspin is a full swing');
  // Distinct shots produce distinct contact-moment poses.
  const fingerprints = new Set(ACTIONS.map(a => {
    const p = swingPose(a, SWING_CONTACT);
    return `${p.armSwing.toFixed(2)}|${p.armAcross.toFixed(2)}|${p.torsoTwist.toFixed(2)}`;
  }));
  assert.ok(fingerprints.size >= 5, 'shots have distinct swings');
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
