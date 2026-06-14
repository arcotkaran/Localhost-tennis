// Testing Gate 10: AAA experience layer.
// Body-language engine (moods, gestures, expressions), articulated model
// rig (pivots, face parts), how-to-play content completeness on both
// screens, and the stacked split-screen contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  EmotionEngine, MOODS, GESTURES, expressionFor, gesturePose,
} from '../client_host/js/emotions.js';
import {
  playerModelSpec, PIVOT_GROUPS, FACE_PARTS, clipPose,
} from '../client_host/js/player-model.js';
import { HOW_TO_PLAY, PHONE_CHEAT_SHEET } from '../shared/howto.js';
import { ACTIONS } from '../shared/protocol.js';
import { ROSTER } from '../shared/roster.js';

const DT = 1 / 60;

// ---------- emotion engine ----------

test('point outcomes: winners pump, losers slump, own-error gets the head shake', () => {
  const e = new EmotionEngine([0, 1]);
  e.pointWon(0, { reason: 'double_bounce' });
  assert.equal(e.moodOf(0), MOODS.PUMPED);
  assert.equal(e.gestureOf(0).name, 'fist_pump');
  assert.equal(e.moodOf(1), MOODS.FRUSTRATED);
  assert.equal(e.gestureOf(1).name, 'slump');

  const e2 = new EmotionEngine([0, 1]);
  e2.pointWon(1, { reason: 'out' }); // team 0 hit it out
  assert.equal(e2.gestureOf(0).name, 'head_shake', 'hitting out earns the self-directed head shake');
});

test('big points earn the full arms-up celebration', () => {
  const e = new EmotionEngine([0, 1, 0, 1]);
  e.pointWon(1, { big: true });
  assert.equal(e.gestureOf(1).name, 'arms_up');
  assert.equal(e.gestureOf(3).name, 'arms_up', 'both doubles partners celebrate');
  assert.equal(e.moodOf(0), MOODS.FRUSTRATED);
});

test('moods decay back to neutral; gestures end on schedule', () => {
  const e = new EmotionEngine([0, 1]);
  e.pointWon(0, {});
  for (let t = 0; t < GESTURES.fist_pump + 0.1; t += DT) e.update(DT);
  assert.equal(e.gestureOf(0), null, 'gesture finished');
  assert.equal(e.moodOf(0), MOODS.PUMPED, 'mood outlives the gesture');
  for (let t = 0; t < 5; t += DT) e.update(DT);
  assert.equal(e.moodOf(0), MOODS.NEUTRAL, 'mood decays to neutral');
});

test('pressure points lock players in; a set deficit hangs heads', () => {
  const e = new EmotionEngine([0, 1]);
  e.pressurePoint();
  assert.equal(e.moodOf(0), MOODS.FOCUSED);
  const e2 = new EmotionEngine([0, 1]);
  e2.scoreboardPressure([2, 0]);
  assert.equal(e2.moodOf(1), MOODS.DEJECTED, 'two sets down reads on the body');
  assert.equal(e2.moodOf(0), MOODS.NEUTRAL, 'the leader stays composed');
});

test('match end: victorious celebration persists, defeat persists', () => {
  const e = new EmotionEngine([0, 1]);
  e.matchWon(0);
  assert.equal(e.moodOf(0), MOODS.VICTORIOUS);
  assert.equal(e.gestureOf(0).name, 'arms_up');
  assert.equal(e.moodOf(1), MOODS.DEJECTED);
  for (let t = 0; t < 30; t += DT) e.update(DT);
  assert.equal(e.moodOf(0), MOODS.VICTORIOUS, 'victory does not decay');
  e.pointWon(1, {}); // stray event after the match must not flip the winner's face
  assert.equal(e.moodOf(0), MOODS.VICTORIOUS);
});

test('every mood maps to a complete facial expression', () => {
  for (const mood of Object.values(MOODS)) {
    const x = expressionFor(mood);
    assert.ok(Number.isFinite(x.browAngle), `${mood}: brow angle`);
    assert.ok(x.mouthCurve >= -1 && x.mouthCurve <= 1, `${mood}: mouth curve in range`);
    assert.ok(x.eyeOpen > 0 && x.eyeOpen <= 1, `${mood}: eyes visible`);
  }
  assert.ok(expressionFor(MOODS.FRUSTRATED).mouthCurve < 0, 'frustration frowns');
  assert.ok(expressionFor(MOODS.VICTORIOUS).mouthCurve > 0.5, 'victory beams');
  assert.ok(expressionFor(MOODS.FOCUSED).browAngle < 0, 'focus knits the brows');
});

test('gesture poses are finite, expressive, and return to rest', () => {
  for (const name of Object.keys(GESTURES)) {
    const start = gesturePose(name, 0);
    const mid = gesturePose(name, 0.5);
    const end = gesturePose(name, 1);
    for (const pose of [start, mid, end]) {
      for (const v of Object.values(pose)) assert.ok(Number.isFinite(v), `${name}: finite values`);
    }
    assert.ok(Math.abs(end.armSwing) < 0.05 && Math.abs(end.crouch) < 0.05, `${name}: returns to rest`);
    const energy = Math.abs(mid.armSwing) + Math.abs(mid.armLSwing) + Math.abs(mid.crouch) + Math.abs(mid.headTilt ?? 0);
    assert.ok(energy > 0.2, `${name}: actually reads as body language`);
  }
  assert.ok(gesturePose('arms_up', 0.5).armLSwing < -2, 'celebration raises BOTH arms');
  assert.ok(gesturePose('slump', 0.5).headTilt > 0.3, 'slump hangs the head');
  assert.ok(Math.abs(gesturePose('head_shake', 0.5).headShake) > 0.1, 'head shake shakes the head');
});

// ---------- articulated rig ----------

test('models expose articulation pivots and a full face on every character', () => {
  for (const character of [...ROSTER, null]) {
    const spec = playerModelSpec(character, 0);
    const names = spec.parts.map(p => p.name);
    for (const pivot of PIVOT_GROUPS) {
      const part = spec.parts.find(p => p.name === pivot);
      assert.ok(part?.pivot, `${character?.id ?? 'guest'}: ${pivot} has a pivot for articulation`);
    }
    for (const face of FACE_PARTS) {
      const part = spec.parts.find(p => p.name === face);
      assert.ok(part, `${character?.id ?? 'guest'}: has ${face}`);
      assert.equal(part.parent, 'head', `${face} rides the head pivot (tilts/shakes move it)`);
    }
    assert.ok(names.includes('shorts') && names.includes('shoeL') && names.includes('shoeR'),
      'kit details present');
  }
});

test('walk cycle counter-swings arms and legs like a human gait', () => {
  const a = clipPose('walk', 0, 0.3);
  assert.ok(Number.isFinite(a.legSwing) && Number.isFinite(a.legLSwing), 'legs animate');
  assert.ok(Math.sign(a.legSwing) !== Math.sign(a.legLSwing) || a.legSwing === 0, 'legs alternate');
  assert.ok(Math.sign(a.armSwing) !== Math.sign(a.armLSwing) || a.armSwing === 0, 'arms counter-swing');
  assert.ok(Math.sign(a.armSwing) !== Math.sign(a.legSwing) || a.armSwing === 0, 'arm opposes same-side leg');
});

// ---------- how to play ----------

test('how-to-play documents every shot and the swipe/move scheme', () => {
  const allText = HOW_TO_PLAY.sections.flatMap(s => s.lines).join(' ').toLowerCase();
  for (const action of ACTIONS) {
    assert.ok(allText.includes(action.toLowerCase()), `documents the ${action} shot`);
  }
  assert.ok(allText.includes('swipe'), 'documents swipe-to-hit');
  assert.ok(allText.includes('drag') || allText.includes('joystick'), 'documents movement');
  assert.ok(allText.includes('aim'), 'documents aiming via swipe angle');
  assert.ok(/armed|half a second/.test(allText), 'documents the swing timing window');
  assert.ok(allText.includes('join code'), 'documents joining');
  assert.ok(allText.includes('resume'), 'documents disconnect recovery');
  assert.ok(allText.includes('tournament') && allText.includes('doubles'), 'documents the modes');
  assert.ok(HOW_TO_PLAY.sections.every(s => s.heading && s.icon && s.lines.length > 0), 'well-formed sections');
});

test('phone cheat sheet covers move, swipe-to-hit, and aiming', () => {
  const text = PHONE_CHEAT_SHEET.flat().join(' ').toLowerCase();
  assert.ok(/drag|move/.test(text), 'cheat sheet explains movement');
  assert.ok(text.includes('swipe'), 'cheat sheet explains swipe-to-hit');
  assert.ok(text.includes('aim'), 'cheat sheet explains aiming');
  // The three swipe shots a player must know (drive / lob / slice).
  for (const shot of ['drive', 'lob', 'slice']) {
    assert.ok(text.includes(shot), `cheat sheet covers ${shot}`);
  }
  assert.ok(PHONE_CHEAT_SHEET.every(([, desc]) => desc.length > 4), 'every entry explains itself');
});

test('both screens render the shared how-to content (no drift)', async () => {
  const tv = await readFile(new URL('../client_host/index.html', import.meta.url), 'utf8');
  const phone = await readFile(new URL('../client_mobile/index.html', import.meta.url), 'utf8');
  assert.ok(tv.includes('howto.js') || tv.includes('HOW_TO_PLAY'), 'TV imports the shared how-to');
  assert.ok(/how-?to|how to play/i.test(tv), 'TV has a how-to entry point');
  const phoneJs = await readFile(new URL('../client_mobile/js/controller.js', import.meta.url), 'utf8');
  assert.ok(phone.includes('help') || phoneJs.includes('CHEAT_SHEET') || phoneJs.includes('howto'),
    'phone exposes the cheat sheet');
});
