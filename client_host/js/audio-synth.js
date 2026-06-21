// Procedural sound design. Converts AudioDirector descriptors into synth
// recipes — declarative voice lists a WebAudio engine plays back. Pure and
// node-testable; only buildVoices() at the bottom touches the AudioContext.
//
// A voice: { kind: 'noise'|'osc', wave?, freq, freqEnd?, attack, decay,
//            gain, filter?: { type, freq, q }, delay? }

export function synthRecipe(desc) {
  const { sample, volume = 0.7, pitch = 1, pan = 0 } = desc;
  if (!sample) return null;
  const v = volume;

  // ---- racket impacts: noise crack + body resonance ----
  if (sample.startsWith('thwack')) {
    const variant = sample.split('_')[1];
    const bright = { flat: 2100, brush: 1500, slice: 2600, soft: 1100, smash: 2900, punch: 2300 }[variant] ?? 2000;
    const body = { flat: 190, brush: 165, slice: 210, soft: 140, smash: 120, punch: 200 }[variant] ?? 180;
    const weight = { flat: 1.0, brush: 0.95, slice: 0.85, soft: 0.7, smash: 1.35, punch: 1.05 }[variant] ?? 1;
    return [
      { kind: 'noise', attack: 0.001, decay: variant === 'smash' ? 0.09 : 0.05,
        gain: 0.5 * v * weight, filter: { type: 'bandpass', freq: bright * pitch, q: 1.1 } },
      { kind: 'osc', wave: 'sine', freq: body * pitch, freqEnd: body * pitch * 0.6,
        attack: 0.001, decay: variant === 'smash' ? 0.16 : 0.09, gain: 0.55 * v * weight },
    ];
  }

  // ---- bounces: surface-tuned thump ----
  if (sample.startsWith('bounce')) {
    const surface = sample.split('_')[1];
    const tone = { grass: 95, clay: 70, hard: 115 }[surface] ?? 100;
    const brightness = { grass: 900, clay: 500, hard: 1400 }[surface] ?? 1000;
    return [
      { kind: 'osc', wave: 'sine', freq: tone, freqEnd: tone * 0.55,
        attack: 0.001, decay: 0.11, gain: 0.5 * v },
      { kind: 'noise', attack: 0.001, decay: surface === 'clay' ? 0.09 : 0.04,
        gain: (surface === 'clay' ? 0.3 : 0.18) * v,
        filter: { type: 'lowpass', freq: brightness, q: 0.7 } },
    ];
  }

  // ---- grunts: voiced burst with a formant ----
  if (sample.startsWith('grunt')) {
    const tier = { soft: 0, mid: 1, hard: 2 }[sample.split('_')[1]] ?? 1;
    const base = [120, 105, 92][tier] * pitch;
    return [
      { kind: 'osc', wave: 'sawtooth', freq: base, freqEnd: base * 0.8,
        attack: 0.02, decay: 0.16 + 0.08 * tier, gain: (0.16 + 0.1 * tier) * v,
        filter: { type: 'bandpass', freq: 560, q: 2.2 } },
      { kind: 'osc', wave: 'sine', freq: base * 0.5, attack: 0.02,
        decay: 0.14 + 0.07 * tier, gain: 0.12 * v },
    ];
  }

  // ---- UI: menu select blip + match-start flourish ----
  if (sample === 'ui_select') {
    return [
      { kind: 'osc', wave: 'sine', freq: 660 * pitch, freqEnd: 990 * pitch, attack: 0.002, decay: 0.10, gain: 0.28 * v },
      { kind: 'osc', wave: 'triangle', freq: 1320 * pitch, attack: 0.002, decay: 0.05, gain: 0.08 * v },
    ];
  }
  if (sample === 'ui_start') {
    return [ // a rising two-note "go!" chime
      { kind: 'osc', wave: 'triangle', freq: 523 * pitch, freqEnd: 784 * pitch, attack: 0.004, decay: 0.20, gain: 0.32 * v },
      { kind: 'osc', wave: 'sine', freq: 784 * pitch, freqEnd: 1046 * pitch, attack: 0.02, decay: 0.24, gain: 0.20 * v, delay: 0.07 },
    ];
  }

  // ---- crowd ----
  if (sample === 'crowd_cheer') {
    return [
      { kind: 'noise', attack: 0.06, decay: 1.9, gain: 0.5 * v,
        filter: { type: 'lowpass', freq: 1100, q: 0.5 } },
      { kind: 'noise', attack: 0.04, decay: 1.2, gain: 0.28 * v,
        filter: { type: 'bandpass', freq: 2400, q: 0.8 }, delay: 0.05 },
    ];
  }
  if (sample === 'crowd_gasp') {
    return [
      { kind: 'noise', attack: 0.18, decay: 0.35, gain: 0.4 * v,
        filter: { type: 'bandpass', freq: 1700, q: 1.4 } },
    ];
  }
  if (sample === 'crowd_murmur') {
    return [
      { kind: 'noise', attack: 0.25, decay: 1.4, gain: 0.10 * v,
        filter: { type: 'lowpass', freq: 600, q: 0.5 } },
    ];
  }
  return [{ kind: 'osc', wave: 'sine', freq: 220 * pitch, attack: 0.005, decay: 0.1, gain: 0.2 * v }];
}

// Peak loudness of a recipe (for tests and ducking).
export function recipeLoudness(recipe) {
  return recipe ? recipe.reduce((s, voice) => s + voice.gain, 0) : 0;
}

// ----- WebAudio playback (browser-only; injected ctx keeps this testable) -----

let noiseBuffer = null;
export function playRecipe(ctx, recipe, pan = 0, destination = null) {
  if (!recipe) return;
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const out = destination ?? ctx.destination;
  for (const v of recipe) {
    const t0 = ctx.currentTime + (v.delay ?? 0);
    let src;
    if (v.kind === 'noise') {
      src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
    } else {
      src = ctx.createOscillator();
      src.type = v.wave ?? 'sine';
      src.frequency.setValueAtTime(v.freq, t0);
      if (v.freqEnd) src.frequency.exponentialRampToValueAtTime(Math.max(20, v.freqEnd), t0 + v.decay);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(v.gain, t0 + v.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + v.attack + v.decay);
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    let node = src;
    if (v.filter) {
      const f = ctx.createBiquadFilter();
      f.type = v.filter.type;
      f.frequency.value = v.filter.freq;
      f.Q.value = v.filter.q ?? 1;
      node.connect(f);
      node = f;
    }
    node.connect(gain).connect(panner).connect(out);
    src.start(t0);
    src.stop(t0 + v.attack + v.decay + 0.05);
  }
}
