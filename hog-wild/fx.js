// hog-wild/fx.js
//
// Audio + haptics engine. WebAudio synthesis only — no files, no fetches,
// no external dependencies. Everything you hear in Hog Wild is oscillators,
// a single procedural noise buffer, and a procedurally generated reverb
// impulse response.
//
// Contracts
// ---------
// * Every export is safe to call at any time: before a user gesture, before
//   `ensureAudio()`, with audio unsupported, or while muted. fx.js can never
//   be the thing that breaks a turn — every public entry point is wrapped so
//   a thrown error degrades to silence.
// * Nothing here creates an AudioContext until `ensureAudio()` (or the legacy
//   alias `initAudio()`) is called from inside a real user gesture. Before
//   that every cue is a no-op, per PRD §11 ("audio must never autoplay").
// * Mute is persisted to localStorage under the same key game.js uses
//   (`hogwild.muted.v1`), so the two can't disagree after a reload.
//
// Design notes per sound live above each synth function. The short version:
// the real pigs are small hard rubber toys on a hard table (see
// ../reference-images/pass-the-pigs/) — impacts are short and plasticky, a
// "tok", never a deep wooden thunk. The voices are the charm budget: a pig
// grunt is a low pitch glide with a nasal formant bump on top, so every voice
// is a two-oscillator source (saw + sub sine) pushed through a parallel bank
// of bandpass "formants" rather than a raw buzzy oscillator.

/* =========================================================================
 * Module state
 * ==================================================================== */

const MUTE_KEY = 'hogwild.muted.v1';

/** @type {AudioContext|null} */
let ctx = null;
let master = null;      // everything sums here; mute rides this gain
let comp = null;        // glue compressor so a flurry can't clip
let verbIn = null;      // reverb send bus
let analyser = null;    // exposed for dev/audio-lab.html metering
let meterBuf = null;
let noiseBuf = null;
let unlocking = null;   // in-flight ensureAudio promise

let muted = loadMutePref();
let hapticsOn = true;

// Cheap polyphony ceiling. A settle flurry plus a fanfare should never pile
// up more than this many simultaneous synth voices on a phone.
const MAX_VOICES = 28;
let voices = 0;

/* =========================================================================
 * Small utilities
 * ==================================================================== */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

function loadMutePref() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMutePref(value) {
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    /* private mode / quota — non-fatal, the session still respects the flag */
  }
}

/** Guard for every public cue: returns the context only when it can make noise. */
function live() {
  if (!ctx || muted) return null;
  if (ctx.state === 'suspended') {
    // A cue fired after the tab was backgrounded. Try to wake it, but never
    // await — the cue this frame is simply lost.
    ctx.resume().catch(() => {});
  }
  return ctx;
}

/** Wraps a public entry point so nothing it does can escape into game.js. */
function safe(fn) {
  return function guarded(...args) {
    try {
      return fn.apply(null, args);
    } catch (err) {
      console.warn('[hog-wild/fx] cue failed (non-fatal)', err);
      return undefined;
    }
  };
}

function takeVoice(count = 1) {
  if (voices + count > MAX_VOICES) return false;
  voices += count;
  return true;
}

function releaseVoice(afterSeconds, count = 1) {
  setTimeout(() => {
    voices = Math.max(0, voices - count);
  }, Math.max(0, afterSeconds * 1000) + 60);
}

/* =========================================================================
 * Graph construction
 * ==================================================================== */

/** 2 s of white noise, generated once and reused by every noise voice. */
function buildNoise() {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * Procedural room impulse response: decaying noise with a slightly delayed
 * onset and a dark tail. Small and cheap — this is a hint of a room around
 * the table, not a cathedral.
 */
function buildImpulse(seconds = 1.1, decay = 3.2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // pre-delay ramp keeps the first ~8 ms dry so transients stay snappy
      const onset = Math.min(1, t * 140);
      const white = Math.random() * 2 - 1;
      lp = lp * 0.72 + white * 0.28; // one-pole LP → darker, less fizzy tail
      data[i] = lp * onset * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

function buildGraph() {
  master = ctx.createGain();
  master.gain.value = muted ? 0.0001 : 1;

  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 22;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;

  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.4;
  meterBuf = new Float32Array(analyser.fftSize);

  const verb = ctx.createConvolver();
  verb.buffer = buildImpulse();
  verbIn = ctx.createGain();
  verbIn.gain.value = 1;
  const verbOut = ctx.createGain();
  verbOut.gain.value = 0.3;
  verbIn.connect(verb);
  verb.connect(verbOut);
  verbOut.connect(master);

  master.connect(comp);
  comp.connect(ctx.destination);
  comp.connect(analyser); // post-everything, so the lab meter sees real output

  noiseBuf = buildNoise();
}

/**
 * Create (and unlock) the AudioContext. MUST be called from inside a real
 * user-gesture handler — game.js does this on pointerdown / Quick Toss.
 * Safe to call repeatedly; later calls just resume a suspended context.
 * @returns {Promise<AudioContext|null>}
 */
export const ensureAudio = safe(function ensureAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') return ctx.resume().then(() => ctx).catch(() => ctx);
    return Promise.resolve(ctx);
  }
  if (unlocking) return unlocking;

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return Promise.resolve(null);

  unlocking = (async () => {
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      buildGraph();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      // iOS wants an actual buffer played inside the gesture before it
      // considers the context genuinely unlocked.
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      s.connect(ctx.destination);
      s.start(0);
      return ctx;
    } catch (err) {
      console.warn('[hog-wild/fx] audio unavailable', err);
      ctx = null;
      return null;
    } finally {
      unlocking = null;
    }
  })();

  return unlocking;
});

/** Legacy alias — game.js imports this name. */
export const initAudio = ensureAudio;

/** @returns {AudioContext|null} — dev pages only. */
export function getAudioContext() {
  return ctx;
}

/** @returns {AnalyserNode|null} — dev pages only (dev/audio-lab.html meter). */
export function getAnalyser() {
  return analyser;
}

/** Instantaneous output RMS, 0..1-ish. 0 when silent or before unlock. */
export function getLevel() {
  if (!analyser || !meterBuf) return 0;
  try {
    if (analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(meterBuf);
    } else {
      return 0;
    }
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
    return Math.sqrt(sum / meterBuf.length);
  } catch {
    return 0;
  }
}

/** Snapshot for dev pages / debugging. */
export function getState() {
  return {
    state: ctx ? ctx.state : 'none',
    sampleRate: ctx ? ctx.sampleRate : 0,
    muted,
    haptics: hapticsOn,
    voices,
    shaking: !!shake,
  };
}

/* =========================================================================
 * Mute
 * ==================================================================== */

/** Persisted mute toggle (PRD §11). Ramped, so toggling mid-sound is smooth. */
export const setMuted = safe(function setMuted(value) {
  muted = !!value;
  saveMutePref(muted);
  if (master && ctx) {
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), t);
    master.gain.exponentialRampToValueAtTime(muted ? 0.0001 : 1, t + 0.08);
  }
  if (muted) stopShakeLoop();
});

export function isMuted() {
  return muted;
}

/* =========================================================================
 * Synthesis primitives
 * ==================================================================== */

function gain(value = 1) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function osc(type, freq) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  return o;
}

function biquad(type, freq, q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** White-noise source starting at a random offset so bursts never phase-lock. */
function noise(t0, dur, rate = 1) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.playbackRate.value = rate;
  s.loop = true;
  s.start(t0, Math.random() * 1.5);
  s.stop(t0 + dur + 0.02);
  return s;
}

/** Send a voice to the dry bus and (optionally) the reverb. */
function out(node, verbAmount = 0) {
  node.connect(master);
  if (verbAmount > 0) {
    const send = gain(verbAmount);
    node.connect(send);
    send.connect(verbIn);
  }
}

/** [ [seconds, hz], ... ] → exponential glide on an AudioParam. */
function pitchCurve(param, points, t0, ratio = 1, rate = 1) {
  param.setValueAtTime(Math.max(20, points[0][1] * ratio), t0);
  for (let i = 1; i < points.length; i++) {
    param.exponentialRampToValueAtTime(
      Math.max(20, points[i][1] * ratio),
      t0 + points[i][0] / rate
    );
  }
}

/** [ [fractionOfDur, level], ... ] → amplitude envelope, peak-scaled. */
function ampEnv(param, points, t0, dur, peak) {
  param.setValueAtTime(0.0001, t0);
  for (const [ft, lv] of points) {
    const t = t0 + ft * dur;
    if (lv <= 0.0005) param.exponentialRampToValueAtTime(0.0001, t);
    else param.linearRampToValueAtTime(lv * peak, t);
  }
  param.setValueAtTime(0.0001, t0 + dur + 0.005);
}

/** Parallel bandpass bank — the thing that turns a saw into a snout. */
function formantBank(src, dest, formants) {
  for (const [f, q, g] of formants) {
    const bp = biquad('bandpass', f, q);
    const gn = gain(g);
    src.connect(bp);
    bp.connect(gn);
    gn.connect(dest);
  }
}

/**
 * Bell / chime voice used by every melodic cue. Triangle fundamental plus a
 * quiet detuned octave and a whisper of a twelfth: reads as a soft mallet
 * rather than a sine beep, and stacks into chords without mud.
 */
function bell(t0, freq, dur, level, { verb = 0.4, wave = 'triangle', detune = 0 } = {}) {
  if (!takeVoice()) return;
  const amp = gain(0.0001);
  const lp = biquad('lowpass', Math.min(9000, freq * 7), 0.7);

  const o1 = osc(wave, freq);
  o1.detune.value = detune;
  const g1 = gain(0.7);
  const o2 = osc('sine', freq * 2.005);
  const g2 = gain(0.26);
  const o3 = osc('sine', freq * 3.01);
  const g3 = gain(0.07);

  o1.connect(g1); o2.connect(g2); o3.connect(g3);
  g1.connect(lp); g2.connect(lp); g3.connect(lp);
  lp.connect(amp);
  out(amp, verb);

  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.linearRampToValueAtTime(level, t0 + 0.006);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  [o1, o2, o3].forEach((o) => { o.start(t0); o.stop(t0 + dur + 0.05); });
  releaseVoice(dur + 0.1);
}

/** Bright noise sparkle — confetti glitter for banks, doubles and the win. */
function sparkle(t0, dur = 0.7, level = 0.09, count = 7) {
  if (!takeVoice()) return;
  const amp = gain(0.0001);
  const bp = biquad('bandpass', 5200, 1.1);
  const n = noise(t0, dur, 1.4);
  n.connect(bp);
  bp.connect(amp);
  out(amp, 0.5);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.linearRampToValueAtTime(level, t0 + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  bp.frequency.setValueAtTime(3200, t0);
  bp.frequency.exponentialRampToValueAtTime(8200, t0 + dur * 0.8);
  releaseVoice(dur + 0.1);

  // a few discrete high pings riding the noise
  for (let i = 0; i < count; i++) {
    bell(t0 + rand(0.01, dur * 0.7), rand(1800, 4200), rand(0.18, 0.42), level * 0.5, { verb: 0.6 });
  }
}

/* =========================================================================
 * Pig voices
 *
 * A pig grunt is a LOW PITCH GLIDE with a NASAL FORMANT BUMP. Recipe:
 *   source  = sawtooth (glottal buzz) + sine at a sub ratio (chest body)
 *   filter  = 3 parallel bandpasses (F1 nasal low, F2 nasal bump, F3 air)
 *             plus a lowpassed copy of the raw source so it has weight and
 *             doesn't read as a thin vocoder
 *   pitch   = multi-point exponential glide, that's the whole character
 *   vibrato = small LFO on frequency; without it a synth pig sounds robotic
 *   amp     = multi-point envelope; the two-bump envelope is what makes a
 *             happy oink read as "uh-OINK" instead of one long honk
 * ==================================================================== */

const VOICES = {
  'happy-oink': {
    // short grunt, then the bark up: uh-OINK
    pitch: [[0, 250], [0.05, 430], [0.15, 470], [0.30, 355]],
    amp: [[0.05, 0.85], [0.22, 0.4], [0.34, 1.0], [0.62, 0.72], [1, 0]],
    formants: [[640, 6, 1.0], [1500, 7, 0.5], [2500, 9, 0.16]],
    sub: 0.5, sawMix: 0.5, subMix: 0.55, noiseMix: 0.05,
    vib: [5.0, 7], lp: 3400, dur: 0.36, level: 0.5, verb: 0.28,
  },
  'sad-oink': {
    // the whole point is the descent — start where a happy oink ends and sag
    pitch: [[0, 330], [0.12, 296], [0.60, 172]],
    amp: [[0.07, 0.9], [0.35, 0.7], [0.7, 0.4], [1, 0]],
    formants: [[470, 5, 1.0], [980, 6, 0.42], [1950, 9, 0.1]],
    sub: 0.5, sawMix: 0.45, subMix: 0.6, noiseMix: 0.06,
    vib: [3.2, 5], lp: 2400, dur: 0.66, level: 0.5, verb: 0.34,
  },
  squeal: {
    // indignant: fast rise, a held nasal top, then a fall as it runs out
    pitch: [[0, 620], [0.045, 1180], [0.13, 1080], [0.34, 740]],
    amp: [[0.03, 1.0], [0.3, 0.82], [0.65, 0.5], [1, 0]],
    formants: [[1000, 7, 0.85], [2300, 9, 0.7], [3300, 11, 0.22]],
    sub: 1, sawMix: 0.62, subMix: 0.3, noiseMix: 0.12,
    vib: [7.2, 22], lp: 4600, dur: 0.36, level: 0.4, verb: 0.32,
  },
  // short "ugh" — the everyday bump, used by impact()
  grunt: {
    pitch: [[0, 300], [0.04, 250], [0.16, 205]],
    amp: [[0.08, 1.0], [0.5, 0.5], [1, 0]],
    formants: [[560, 5, 1.0], [1150, 6, 0.36], [2100, 9, 0.08]],
    sub: 0.5, sawMix: 0.42, subMix: 0.6, noiseMix: 0.08,
    vib: [4.0, 4], lp: 2200, dur: 0.18, level: 0.4, verb: 0.2,
  },
  // low winded "oof" — rump hits
  oof: {
    pitch: [[0, 210], [0.05, 168], [0.24, 128]],
    amp: [[0.12, 1.0], [0.55, 0.45], [1, 0]],
    formants: [[400, 4.5, 1.0], [860, 6, 0.3], [1600, 9, 0.06]],
    sub: 0.5, sawMix: 0.36, subMix: 0.7, noiseMix: 0.12,
    vib: [3.0, 3], lp: 1700, dur: 0.26, level: 0.45, verb: 0.24,
  },
};

function grunt(kind, t0, opts = {}) {
  const cfg = VOICES[kind];
  if (!cfg || !takeVoice(2)) return;
  const rate = opts.rate ?? 1;
  const dur = (opts.dur ?? cfg.dur) / rate;
  const level = cfg.level * (opts.gain ?? 1);

  const src = gain(1);            // raw two-oscillator source
  const shaped = gain(1);         // formant bank sums here
  const amp = gain(0.0001);       // envelope

  const saw = osc('sawtooth', cfg.pitch[0][1]);
  const sawG = gain(cfg.sawMix);
  const sub = osc('sine', cfg.pitch[0][1] * cfg.sub);
  const subG = gain(cfg.subMix);
  pitchCurve(saw.frequency, cfg.pitch, t0, 1, rate);
  pitchCurve(sub.frequency, cfg.pitch, t0, cfg.sub, rate);
  saw.connect(sawG); sawG.connect(src);
  sub.connect(subG); subG.connect(src);

  // breath: a little noise through the same formants keeps it organic
  if (cfg.noiseMix > 0) {
    const n = noise(t0, dur + 0.05, 1);
    const ng = gain(cfg.noiseMix);
    n.connect(ng); ng.connect(src);
  }

  // vibrato — tiny, but it is the difference between a pig and a doorbell
  const [vibHz, vibDepth] = cfg.vib;
  const lfo = osc('sine', vibHz);
  const lfoG = gain(vibDepth);
  lfo.connect(lfoG);
  lfoG.connect(saw.frequency);
  lfoG.connect(sub.frequency);
  lfo.start(t0);
  lfo.stop(t0 + dur + 0.05);

  formantBank(src, shaped, cfg.formants);
  // lowpassed dry copy for weight
  const body = biquad('lowpass', cfg.lp, 0.9);
  const bodyG = gain(0.38);
  src.connect(body); body.connect(bodyG); bodyG.connect(shaped);

  shaped.connect(amp);
  out(amp, opts.verb ?? cfg.verb);
  ampEnv(amp.gain, cfg.amp, t0, dur, level);

  saw.start(t0); saw.stop(t0 + dur + 0.05);
  sub.start(t0); sub.stop(t0 + dur + 0.05);
  releaseVoice(dur + 0.1, 2);
}

/**
 * Play a pig voice.
 * @param {'happy-oink'|'sad-oink'|'squeal'|'panic'|'grunt'|'oof'} kind
 * @param {{gain?:number, rate?:number, dur?:number, delay?:number, verb?:number}} [opts]
 */
export const pigVoice = safe(function pigVoice(kind, opts = {}) {
  if (!live()) return;
  const t0 = ctx.currentTime + 0.005 + (opts.delay ?? 0);

  if (kind === 'panic') {
    // Three accelerating squeal blips, each higher than the last — the sound
    // of a pig realising what is about to happen to the score.
    const g = (opts.gain ?? 1) * 0.85;
    const starts = [0, 0.15, 0.27, 0.365];
    starts.forEach((off, i) => {
      grunt('squeal', t0 + off, {
        gain: g * (0.75 + i * 0.1),
        rate: 2.5 + i * 0.5,
        dur: 0.34,
        verb: 0.35,
      });
    });
    return;
  }
  grunt(kind, t0, opts);
});

/* =========================================================================
 * Shake loop
 *
 * Two layers, both noise-based (there is no pitch here, only rattle):
 *  - BED: bandpassed noise around ~330 Hz, the boxy resonance of the cup,
 *    wobbled by an LFO so it breathes.
 *  - TICKS: a lookahead scheduler firing short bandpassed noise bursts with
 *    randomised spacing. Intensity raises BOTH the tick rate (13/s → 29/s)
 *    and the bandpass centre (700 Hz → 2600 Hz), which is what makes a hard
 *    shake read as faster AND brighter, per PRD §11.
 * ==================================================================== */

const SHAKE = {
  tickMin: 0.075,   // seconds between ticks at intensity 0
  tickMax: 0.034,   // ...and at intensity 1
  bpLow: 700,
  bpHigh: 2600,
  bedLow: 0.03,
  bedHigh: 0.1,
  lookahead: 0.14,
};

let shake = null;

function scheduleShakeTick(t) {
  if (!takeVoice()) return;
  const k = shake.intensity;
  const dur = rand(0.012, 0.032);
  const amp = gain(0.0001);
  const centre = lerp(SHAKE.bpLow, SHAKE.bpHigh, k) * rand(0.72, 1.45);
  const bp = biquad('bandpass', centre, rand(2.0, 3.8));
  const n = noise(t, dur, rand(0.9, 1.5));
  n.connect(bp); bp.connect(amp);

  // a scrap of tonal body so each tick is a small hard object, not a hiss
  const b = osc('triangle', rand(150, 280));
  const bg = gain(0.0001);
  b.connect(bg); bg.connect(amp);
  b.frequency.exponentialRampToValueAtTime(90, t + dur);
  bg.gain.setValueAtTime(0.35, t);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.8);
  b.start(t); b.stop(t + dur + 0.02);

  out(amp, 0.12);
  const level = (0.13 + 0.34 * k) * rand(0.55, 1.15);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.linearRampToValueAtTime(level, t + 0.002);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  releaseVoice(dur + 0.08);
}

function shakePump() {
  if (!shake || !ctx) return;
  if (muted) { shake.next = ctx.currentTime; return; }
  const horizon = ctx.currentTime + SHAKE.lookahead;
  let guard = 0;
  while (shake.next < horizon && guard++ < 24) {
    scheduleShakeTick(Math.max(shake.next, ctx.currentTime + 0.001));
    const gap = lerp(SHAKE.tickMin, SHAKE.tickMax, shake.intensity);
    shake.next += gap * rand(0.6, 1.5);
  }
}

/**
 * Start (or update) the shake rattle. Call every frame with the current hold
 * ramp; intensity is smoothed onto the bed so it never zippers.
 * `shakeLoop(null)` — or `stopShakeLoop()` — stops it.
 * @param {number|null} intensity 0..1
 */
export const shakeLoop = safe(function shakeLoop(intensity) {
  if (intensity == null || intensity === false) return stopShakeLoop();
  const k = clamp(Number(intensity) || 0, 0, 1);
  if (!live()) return;

  if (!shake) {
    const bedGain = gain(0.0001);
    const bp = biquad('bandpass', 330, 1.1);
    const src = noise(ctx.currentTime, 3600, 1);
    src.connect(bp); bp.connect(bedGain);
    out(bedGain, 0.18);

    // slow wobble on the bed so the rattle isn't a static hiss
    const lfo = osc('sine', 3.4);
    const lfoG = gain(90);
    lfo.connect(lfoG); lfoG.connect(bp.frequency);
    lfo.start(ctx.currentTime);

    shake = {
      src, bp, bedGain, lfo,
      intensity: k,
      next: ctx.currentTime + 0.01,
      timer: setInterval(shakePump, 45),
    };
    takeVoice(2);
  }

  shake.intensity = k;
  const t = ctx.currentTime;
  const target = lerp(SHAKE.bedLow, SHAKE.bedHigh, k);
  shake.bedGain.gain.cancelScheduledValues(t);
  shake.bedGain.gain.setValueAtTime(Math.max(0.0001, shake.bedGain.gain.value), t);
  shake.bedGain.gain.linearRampToValueAtTime(target, t + 0.09);
  shake.bp.frequency.cancelScheduledValues(t);
  shake.bp.frequency.linearRampToValueAtTime(lerp(300, 520, k), t + 0.09);
  shakePump();
});

/** Stop the rattle with a short fade so the release doesn't click. */
export const stopShakeLoop = safe(function stopShakeLoop() {
  if (!shake) return;
  const s = shake;
  shake = null;
  clearInterval(s.timer);
  if (!ctx) return;
  const t = ctx.currentTime;
  try {
    s.bedGain.gain.cancelScheduledValues(t);
    s.bedGain.gain.setValueAtTime(Math.max(0.0001, s.bedGain.gain.value), t);
    s.bedGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    s.src.stop(t + 0.2);
    s.lfo.stop(t + 0.2);
  } catch {
    /* already stopped */
  }
  releaseVoice(0.25, 2);
});

// convenience aliases so callers can read either way
shakeLoop.start = shakeLoop;
shakeLoop.stop = stopShakeLoop;

/* =========================================================================
 * Impacts
 *
 * Every impact is CLICK + BODY:
 *   click = short bandpassed noise (the hard rubber surface)
 *   body  = a fast downward pitch glide on a triangle (the mass behind it)
 * The region picks the frequencies, the durations, the noise/body balance,
 * and whether the pig complains about it.
 *
 * Rate limiting: a settle flurry can fire a dozen contacts in 200 ms. A
 * budget refills over ~0.35 s; each impact spends 0.34 of it and is
 * attenuated by whatever is left, so the first hit of a flurry is full and
 * the tail turns into texture instead of a wall of clicks.
 * ==================================================================== */

const REGIONS = {
  snout:  { bodyF: [235, 118], bodyDur: 0.10, bodyMix: 0.55, clickF: 2200, clickQ: 1.1, clickDur: 0.035, clickMix: 0.85, voice: 'squeal', voiceAt: 0.5,  voiceGain: 0.5 },
  head:   { bodyF: [215, 108], bodyDur: 0.11, bodyMix: 0.6,  clickF: 1900, clickQ: 1.2, clickDur: 0.035, clickMix: 0.75, voice: 'grunt',  voiceAt: 0.66, voiceGain: 0.5 },
  back:   { bodyF: [190, 96],  bodyDur: 0.12, bodyMix: 0.75, clickF: 1650, clickQ: 1.3, clickDur: 0.03,  clickMix: 0.6,  voice: 'grunt',  voiceAt: 0.78, voiceGain: 0.4 },
  side:   { bodyF: [172, 88],  bodyDur: 0.13, bodyMix: 0.78, clickF: 1400, clickQ: 1.3, clickDur: 0.03,  clickMix: 0.55, voice: 'grunt',  voiceAt: 0.8,  voiceGain: 0.4 },
  rump:   { bodyF: [122, 58],  bodyDur: 0.19, bodyMix: 1.0,  clickF: 760,  clickQ: 1.0, clickDur: 0.03,  clickMix: 0.35, voice: 'oof',    voiceAt: 0.42, voiceGain: 0.6 },
  belly:  { bodyF: [168, 112], bodyDur: 0.06, bodyMix: 0.55, clickF: 1150, clickQ: 0.5, clickDur: 0.065, clickMix: 1.4,  voice: 'grunt',  voiceAt: 0.7,  voiceGain: 0.45 },
  legs:   { bodyF: [300, 190], bodyDur: 0.035, bodyMix: 0.3, clickF: 3800, clickQ: 1.5, clickDur: 0.026, clickMix: 1.5,  voice: null,     voiceAt: 2,    voiceGain: 0, clatter: 4 },
};

let impactBudget = 1;
let impactLastT = -1;

function oneImpact(t, cfg, amp) {
  if (!takeVoice()) return;
  const busAmp = gain(1);
  out(busAmp, 0.16 + 0.1 * amp);

  // click
  const cDur = cfg.clickDur * rand(0.8, 1.3);
  const cAmp = gain(0.0001);
  const bp = biquad('bandpass', cfg.clickF * rand(0.85, 1.2), cfg.clickQ);
  const n = noise(t, cDur, rand(0.9, 1.3));
  n.connect(bp); bp.connect(cAmp); cAmp.connect(busAmp);
  cAmp.gain.setValueAtTime(0.0001, t);
  cAmp.gain.linearRampToValueAtTime(0.34 * cfg.clickMix * amp, t + 0.0015);
  cAmp.gain.exponentialRampToValueAtTime(0.0001, t + cDur);

  // body
  if (cfg.bodyMix > 0.01) {
    const bDur = cfg.bodyDur * rand(0.85, 1.2);
    const bAmp = gain(0.0001);
    const b = osc('triangle', cfg.bodyF[0] * rand(0.92, 1.1));
    const lp = biquad('lowpass', 1400, 0.8);
    b.frequency.exponentialRampToValueAtTime(cfg.bodyF[1], t + bDur);
    b.connect(lp); lp.connect(bAmp); bAmp.connect(busAmp);
    bAmp.gain.setValueAtTime(0.0001, t);
    bAmp.gain.linearRampToValueAtTime(0.34 * cfg.bodyMix * amp, t + 0.003);
    bAmp.gain.exponentialRampToValueAtTime(0.0001, t + bDur);
    b.start(t); b.stop(t + bDur + 0.02);
  }
  releaseVoice(Math.max(cfg.bodyDur, cfg.clickDur) + 0.1);
}

/**
 * A physics contact. Called from replay time against Recording `events`
 * (SPEC "Physics-driven reactions").
 * @param {number} impulse normal impulse magnitude from the sim
 * @param {'snout'|'head'|'back'|'rump'|'belly'|'legs'|'side'} [region]
 */
export const impact = safe(function impact(impulse, region = 'side') {
  if (!live()) return;
  const cfg = REGIONS[region] || REGIONS.side;
  const t = ctx.currentTime + 0.004;

  // refill + spend the flurry budget
  if (impactLastT >= 0) {
    if (t - impactLastT < 0.018) return;             // physically inaudible as separate
    impactBudget = Math.min(1, impactBudget + (t - impactLastT) / 0.35);
  }
  impactLastT = t;
  if (impactBudget < 0.12) return;
  const duck = Math.min(1, 0.35 + impactBudget * 0.75);
  impactBudget -= 0.34;

  // impulse → amplitude: 8 is a solid hit, curve keeps small taps audible
  const raw = clamp(Number(impulse) || 0, 0, 40);
  const amp = clamp(Math.pow(raw / 8, 0.62), 0.05, 1.25) * duck;

  if (cfg.clatter) {
    // legs: several micro-ticks scattered over ~70 ms
    const n = 2 + Math.round(Math.random() * (cfg.clatter - 2));
    for (let i = 0; i < n; i++) {
      oneImpact(t + i * rand(0.012, 0.028), cfg, amp * rand(0.55, 1) * (1 - i * 0.12));
    }
  } else {
    oneImpact(t, cfg, amp);
  }

  if (cfg.voice && amp >= cfg.voiceAt) {
    grunt(cfg.voice, t + rand(0.02, 0.06), {
      gain: cfg.voiceGain * clamp(amp, 0.3, 1) * duck,
      rate: cfg.voice === 'squeal' ? rand(1.15, 1.5) : rand(0.95, 1.2),
    });
  }
});

/* =========================================================================
 * Melodic cues (PRD §8.2) — escalating by rarity
 * ==================================================================== */

const A4 = 440;
const note = (semis) => A4 * Math.pow(2, semis / 12);
// A major pentatonic, rooted low enough that a 24-semitone climb still sings
const PENT = [-12, -10, -8, -5, -3, 0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31];

/** Points → which pip. Sider 1 is a small tick; a Jowler is way up the scale. */
function pipIndex(points) {
  if (points <= 0) return 0;
  if (points <= 1) return 2;
  if (points <= 5) return 5;
  if (points <= 10) return 8;
  if (points <= 15) return 10;
  if (points <= 20) return 11;
  return 13;
}

/**
 * A single scoring pip (PRD §8.1 beat 3). Bigger scores get a grace note
 * above, so the ear hears the size of the number.
 * @param {number} points
 * @param {{delay?:number, gain?:number}} [opts]
 */
export const score = safe(function score(points = 0, opts = {}) {
  if (!live()) return;
  const t = ctx.currentTime + 0.01 + (opts.delay ?? 0);
  const i = pipIndex(points);
  const g = 0.22 * (opts.gain ?? 1);
  bell(t, note(PENT[i]), 0.5, g, { verb: 0.35 });
  if (points >= 10) bell(t + 0.075, note(PENT[i + 2]), 0.45, g * 0.7, { verb: 0.4 });
  if (points >= 15) bell(t + 0.15, note(PENT[i + 4]), 0.5, g * 0.6, { verb: 0.45 });
});

/** Rarity tiers for doubles: razorback/trotter 20 → snouter 40 → jowler 60. */
const DOUBLE_TIER = { razorback: 1, trotter: 2, snouter: 3, jowler: 4 };

/**
 * Golden burst for a double (PRD §8.2). Tier 4 — the 1-in-28,000 Double
 * Leaning Jowler — gets the full held-note-and-confetti treatment.
 * @param {1|2|3|4|'razorback'|'trotter'|'snouter'|'jowler'} tier
 */
export const doubleFanfare = safe(function doubleFanfare(tier = 1) {
  if (!live()) return;
  const n = clamp(typeof tier === 'string' ? DOUBLE_TIER[tier] || 1 : tier, 1, 4);
  const t = ctx.currentTime + 0.01;

  const runs = {
    1: [5, 8, 10],
    2: [5, 8, 10, 12],
    3: [3, 5, 8, 10, 12, 13],
    4: [2, 3, 5, 8, 10, 12, 13, 15],
  }[n];
  const step = n >= 3 ? 0.075 : 0.09;
  const level = 0.2 + 0.04 * n;

  runs.forEach((deg, i) => {
    bell(t + i * step, note(PENT[deg]), 0.55 + i * 0.05, level, { verb: 0.4 });
  });

  // the landing chord, held longer the rarer the double
  const land = t + runs.length * step + 0.03;
  const hold = 0.9 + n * 0.55;
  [PENT[10], PENT[13], PENT[15]].slice(0, n >= 2 ? 3 : 2).forEach((deg, i) => {
    bell(land, note(deg), hold, level * (0.9 - i * 0.15), { verb: 0.6, detune: i * 4 });
  });
  if (n >= 3) bell(land, note(PENT[17]), hold * 1.1, level * 0.5, { verb: 0.7 });
  if (n >= 2) sparkle(land, 0.5 + n * 0.25, 0.05 + n * 0.02, 4 + n * 3);

  pigVoice('happy-oink', { delay: land - ctx.currentTime + 0.05, gain: 0.7 + n * 0.08 });
  if (n >= 4) {
    pigVoice('happy-oink', { delay: land - ctx.currentTime + 0.42, gain: 0.85, rate: 1.12 });
    sparkle(land + 0.5, 1.1, 0.06, 10);
  }
  haptic(n >= 3 ? 'win' : 'land');
});

/** Descending buzzer + a sagging oink. Turn wiped (PRD §8.2). */
export const pigOut = safe(function pigOut() {
  if (!live()) return;
  const t = ctx.currentTime + 0.01;

  if (takeVoice(2)) {
    // buzzer: sawtooth through a closing lowpass — sour, not painful
    const amp = gain(0.0001);
    const lp = biquad('lowpass', 2400, 3.5);
    const o1 = osc('sawtooth', 330);
    const o2 = osc('sawtooth', 330 * 1.008); // detune → a beating, unhappy edge
    o1.connect(lp); o2.connect(lp); lp.connect(amp);
    out(amp, 0.3);
    [o1, o2].forEach((o) => {
      o.frequency.setValueAtTime(330, t);
      o.frequency.exponentialRampToValueAtTime(104, t + 0.52);
      o.start(t); o.stop(t + 0.62);
    });
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(620, t + 0.52);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(0.2, t + 0.02);
    amp.gain.setValueAtTime(0.2, t + 0.34);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    releaseVoice(0.7, 2);
  }

  // the floor dropping out
  bell(t + 0.02, note(-24), 0.7, 0.16, { verb: 0.3, wave: 'sine' });
  pigVoice('sad-oink', { delay: 0.24, gain: 0.95 });
  haptic('fail');
});

/**
 * Seconds from the start of the Oinker sting to its POP — the moment the
 * panicked squeal is cut short. game.js schedules the cue so that this lands on
 * the frame the pigs actually burst (SPEC beat 4), which is the whole gag.
 */
export const OINKER_POP_S = 0.55;

/** The sting (PRD §8.2): lower, longer, and the score spinning down to zero. */
export const oinker = safe(function oinker() {
  if (!live()) return;
  const t = ctx.currentTime + 0.01;

  // panicked squeal, cut short by the pop (SPEC "Failure feedback")
  pigVoice('panic', { gain: 0.9 });

  if (takeVoice(3)) {
    // long low descent, two detuned saws over a sub sine
    const amp = gain(0.0001);
    const lp = biquad('lowpass', 1800, 2.2);
    const o1 = osc('sawtooth', 220);
    const o2 = osc('sawtooth', 220 * 1.012);
    const sub = osc('sine', 110);
    o1.connect(lp); o2.connect(lp);
    const subG = gain(0.5);
    sub.connect(subG); subG.connect(lp);
    lp.connect(amp);
    out(amp, 0.42);
    [[o1, 1], [o2, 1], [sub, 0.5]].forEach(([o, r]) => {
      o.frequency.setValueAtTime(220 * r, t);
      o.frequency.exponentialRampToValueAtTime(48 * r, t + 1.5);
      o.start(t); o.stop(t + 1.75);
    });
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 1.5);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(0.24, t + 0.06);
    amp.gain.setValueAtTime(0.24, t + 1.0);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 1.72);
    releaseVoice(1.8, 3);
  }

  // the pop that ends the squeal — the pigs bursting into particles
  const pop = t + OINKER_POP_S;
  if (takeVoice()) {
    const amp = gain(0.0001);
    const hp = biquad('highpass', 320, 0.7);
    const n = noise(pop, 0.14, 1.2);
    n.connect(hp); hp.connect(amp);
    out(amp, 0.5);
    amp.gain.setValueAtTime(0.0001, pop);
    amp.gain.linearRampToValueAtTime(0.3, pop + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, pop + 0.14);
    releaseVoice(0.2);
  }
  bell(pop, note(-17), 0.3, 0.14, { wave: 'sine', verb: 0.2 });

  // the whole score spinning down, digit by digit
  for (let i = 0; i < 9; i++) {
    bell(pop + 0.16 + i * (0.085 + i * 0.012), note(4 - i * 2), 0.28, 0.1 - i * 0.008, { verb: 0.35 });
  }
  haptic('fail');
});

/** Banking points: a small cha-ching. */
export const bank = safe(function bank() {
  if (!live()) return;
  const t = ctx.currentTime + 0.01;
  bell(t, note(PENT[8]), 0.4, 0.2, { verb: 0.35 });
  bell(t + 0.07, note(PENT[11]), 0.75, 0.2, { verb: 0.45 });
  bell(t + 0.075, note(PENT[13]), 0.7, 0.12, { verb: 0.5, detune: 6 });
  sparkle(t + 0.05, 0.45, 0.05, 4);
  haptic('land');
});

/** Win screen fanfare. */
export const win = safe(function win() {
  if (!live()) return;
  const t = ctx.currentTime + 0.01;
  const fig = [5, 8, 10, 8, 10, 12, 13, 15];
  fig.forEach((deg, i) => {
    bell(t + i * 0.115, note(PENT[deg]), 0.6, 0.2, { verb: 0.4 });
  });
  const land = t + fig.length * 0.115 + 0.04;
  [10, 13, 15, 17].forEach((deg, i) => {
    bell(land, note(PENT[deg]), 2.4, 0.2 - i * 0.03, { verb: 0.7, detune: i * 3 });
  });
  bell(land, note(PENT[5] - 12), 2.6, 0.14, { wave: 'sine', verb: 0.5 });
  sparkle(land, 1.6, 0.07, 14);
  pigVoice('happy-oink', { delay: land - ctx.currentTime + 0.1, gain: 1 });
  pigVoice('happy-oink', { delay: land - ctx.currentTime + 0.46, gain: 0.9, rate: 1.15 });
  haptic('win');
});

/* =========================================================================
 * Haptics (PRD §11)
 * ==================================================================== */

const HAPTICS = {
  tick: [8],                              // a pig came to rest
  toss: [16, 40, 22],                     // the pigs leaving the cup
  land: [14],
  fail: [40, 70, 40, 70, 140],
  win: [26, 50, 26, 50, 26, 50, 200],
};

/**
 * Can we buzz at all?
 *
 * Chrome refuses `navigator.vibrate` until the frame has been tapped and logs a
 * console ERROR for every blocked call. That is fine for one call a turn and not
 * fine for the shake pulse train, which runs at up to 10 Hz: dev/shake-test.html
 * drives the game programmatically in an iframe nobody has tapped, and the first
 * run of the continuous haptics filled its console with 30+ identical errors.
 * `navigator.userActivation.hasBeenActive` is the exact condition the browser is
 * testing, so ask it first instead of being told off.
 */
function canVibrate() {
  if (!hapticsOn) return false;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  const ua = navigator.userActivation;
  if (ua && ua.hasBeenActive === false) return false;
  return true;
}

/** @param {'tick'|'toss'|'land'|'fail'|'win'} kind */
export const haptic = safe(function haptic(kind) {
  const pattern = HAPTICS[kind];
  if (!pattern) return;
  if (!canVibrate()) return;
  navigator.vibrate(pattern);
});

/**
 * A single shake pulse, its length scaled by how hard the pigs are being
 * rattled.
 *
 * SPEC "Shake interaction" 2: the hold has to feel CONTINUOUS. `haptic('toss')`
 * fires once, at the end, which is why the owner's phone buzzed once and then
 * went dead for the rest of the gesture. game.js calls this on a cadence for as
 * long as the shake runs — touch-hold or device-motion, same pipeline — so the
 * phone is buzzing exactly while the cup is rattling.
 *
 * @param {number} intensity 0..1
 */
export const shakePulse = safe(function shakePulse(intensity = 0) {
  if (!canVibrate()) return;
  const k = clamp(Number(intensity) || 0, 0, 1);
  // 6 ms at rest, 22 ms flat out. Short: a long buzz on a 90 ms cadence would
  // overlap itself into one continuous drone and drain the motor.
  navigator.vibrate([Math.round(6 + 16 * k)]);
});

/** Haptics are a separate channel from mute; this is the switch for them. */
export function setHaptics(value) {
  hapticsOn = !!value;
}

/* =========================================================================
 * Failure feedback — the visual half (SPEC "Presentation model" beat 4)
 *
 * Ported from the approved demo arena (`_watch/arena.html`) and raised to game
 * quality: the blink drives EMISSIVE on the pig material (so it reads through
 * the tone mapper instead of flattening the albedo), the burst is one Points
 * cloud per pig with additive blending and gravity, and every timing lives in
 * REVEAL_FX below.
 *
 *   Pig Out → both pigs blink red, ~180 ms cadence, ~2.4 s.
 *   Oinker  → blink red until ~1.2 s after the camera settles, then the pigs
 *             squash-pop away and burst into particles (~90/pig, ~1.3 s fade)
 *             and stay gone until the next toss brings them back.
 *
 * THREE is injected rather than imported so fx.js keeps working on pages with
 * no importmap (dev/audio-lab.html) and in node. Everything degrades to a
 * no-op if initVisualFx() was never called.
 * ==================================================================== */

export const REVEAL_FX = {
  blinkPeriodMs: 180,        // on/off cadence of the red blink
  // The arena's flat-shaded pigs went red on emissive alone. The real pig is a
  // bright pink physical material under ACES tone mapping, where adding red to
  // an already-red-heavy albedo does almost nothing — MEASURED: emissive
  // 0xff0000 at intensity 3.2 was still readably PINK on screen. So the blink
  // tints the albedo dark red as well, and the emissive is only the glow on top.
  blinkAlbedo: 0x7d0d18,
  blinkColor: 0xd41427,
  blinkEmissive: 1.5,        // emissiveIntensity while blinking
  pigOutBlinkMs: 2400,       // Pig Out: blink through the zoom-in and the hold
  oinkerExplodeDelay: 1.2,   // s after the camera settles before the pigs blow
  popTime: 0.16,             // s — the squash-scale away
  /* ---- the OINKER burst -----------------------------------------------------
   * ROUND-2 REVIEW: "the Oinker burst is worse than the cheer. 90 particles per
   * pig at size 0.15 (≈3.6 CSS px), burstSpread 0.3 / burstSpeed 5, already
   * spanning 3.6 m per pig by t=0.35 s, with no core flash, no sprite falloff, no
   * smoke, no glow, no ring. Screenshotted it: the two pigs vanish and what
   * remains is a dusting of ~180 single-pixel dots over the felt. The event that
   * zeroes a player's entire score is visually indistinguishable from a rendering
   * artifact."
   *
   * Every number below moved, and the shape of the effect changed with them:
   * FEWER and MUCH BIGGER sparks (0.15 → 0.34 m — a real sprite, not a speck),
   * and they no longer escape. `burstDrag` bleeds the lateral velocity so the
   * cloud stays a cloud instead of a 3.6 m dust field, and `groundY` stops it
   * falling through the table (MEASURED before: particles reached y −1.03, i.e.
   * below the felt). On top of the sparks there are now three things that were
   * simply absent: a core FLASH, an expanding shock RING on the felt, and a SMOKE
   * puff that lingers after the sparks have gone.
   */
  particles: 54,             // per pig
  particleLife: 1.05,        // s
  particleSize: 0.34,
  burstSpeed: 3.6,
  burstGravity: 12,
  burstDrag: 2.2,            // 1/s of velocity bleed — this is what bounds the cloud
  burstSpread: 0.22,         // m — initial cloud radius
  // Additive blending SUMS with the felt and then goes through ACES, so a
  // full-brightness pink clips straight to white — MEASURED: the first burst
  // rendered as white dust. Kept just under 1 so the sparks keep their pink and
  // the FLASH carries the brightness instead.
  // 0.5 was too dim to see, 0.82 saturated to white once the sprites overlapped
  // at reveal range (MEASURED: the burst read as a white bloom, not pink shrapnel).
  burstGain: 0.55,
  /** where "the felt" is, for particles that would otherwise fall through it */
  groundY: 0.03,
  groundBounce: 0.26,
  groundFriction: 0.55,
  /* ROUND-3 REVIEW counted the flash among the "giant pale … bubbles": "plus gold
   * flash sprites at scale 2.21 and 1.47". A flash is a BANG — the hottest,
   * smallest thing in the frame — and a 2.2 m additive disc on a 5.4 m-wide shot
   * is a wash, not a bang. Both radii are pulled in to roughly one pig-length so
   * the flash is a highlight the sparks come out of. */
  flashR0: 0.26, flashR1: 1.15, flashMs: 300,  // the core bloom
  ringR0: 0.28, ringR1: 2.2, ringMs: 520,      // the shock ring on the felt
  /* The reveal camera is LOW, so a flat ring on the felt is seen almost edge-on
   * and a bright one reads as a horizontal light bar rather than a shockwave.
   * MEASURED in an Oinker screenshot at 0.9. */
  ringOpacity: 0.40,
  /* ---- the SMOKE, and why round 2's fix was a lateral move -------------------
   * ROUND-3 REVIEW: "The burst and cheer render as giant pale-green soap bubbles.
   * ROOT CAUSE MEASURED from the live scene: the smoke is a Points with color
   * #bfd0c6 (pale grey-GREEN), size: 1 (one full board-metre per sprite),
   * NormalBlending, opacity 0.9, and only 14 particles … 4-6 overlapping
   * translucent discs with VISIBLE HARD CIRCULAR RIMS covering most of the board …
   * A pale green puff over green felt cannot say 'something was destroyed here' —
   * it says lens smudge."
   *
   * Every clause of that is a separate mistake and all four are fixed here:
   *
   *  - SIZE. One metre per sprite, growing by `grow` 2.4 to 3.4 m, is a THIRD of
   *    the green's diameter per particle. A pig is 1.0 m long; the dust it leaves
   *    cannot be three of them. 0.34 m growing to ~0.8 m.
   *  - COUNT. 14 sprites of 1 m read as four discs; 30 sprites of 0.34 m read as a
   *    cloud. Big-and-few is what makes the rims visible — the rim is only visible
   *    because there are few enough edges to resolve.
   *  - OPACITY. 0.9 on a non-additive sprite is a paint layer, not a puff. 0.34,
   *    against a sprite whose own core alpha came down too.
   *  - COLOUR. #bfd0c6 is green-grey, i.e. the felt's own hue lightened, which is
   *    the definition of a lens smudge. It is a warm neutral dust now (#cdbfae),
   *    which is the one hue the board does not contain.
   */
  smokeCount: 30, smokeSize: 0.34, smokeLife: 1.15, smokeSpeed: 1.2,
  smokeGrow: 1.4, smokeOpacity: 0.34, smokeColor: 0xcdbfae,

  /* ---- the SCORING side of the ledger --------------------------------------
   * ROUND-1 REVIEW: "nothing celebrates. The game punishes with spectacle and
   * rewards with silence." A Double Trotter — the biggest normal event in the
   * game — was gold text on a dark slab and two motionless pigs, while a Pig Out
   * got a red blink, a squash-pop and a particle burst. These constants are the
   * reward half: a gold burst SCALED TO THE POINTS, a scale pop on the pig that
   * actually scored, and (driven from game.js, which owns the camera) a punch.
   *
   * ROUND-2 REVIEW: "the scoring celebration is a scatter of brown-olive dust
   * across the whole arena … PointsMaterial size 0.13 with sizeAttenuation (≈3.6
   * CSS px), and the per-vertex colours are #836e26, #734727, #a06337, #796523 —
   * khaki and brown, not gold. Spread measured at x −4.33…4.85 and z −3.27…5.12,
   * wider than the entire board, and y down to −1.03 so particles fall through the
   * table. It reads as sensor noise, not reward."
   *
   * Three separate faults, three fixes. The KHAKI was `cheerGain: 0.62` — the
   * palette was being multiplied down to two-thirds before it ever reached the
   * additive blend, and 0.62 × gold is olive; the gain is now above 1 and the
   * palette is more saturated amber. The SPECKS were `cheerSize` at a third of
   * what a spark needs to be. The board-wide SPREAD was speed × life with nothing
   * bleeding it, so it is now shorter-lived, harder-falling, and dragged — plus
   * the same ground clamp as the burst. And the round gets a gold flash and a
   * ring so it is loud in the first frame, not just eventually.
   */
  cheerParticles: 20,       // per pig at 5 points; scales with the score
  cheerParticlesMax: 84,
  cheerLife: 0.95,
  cheerSize: 0.30,
  cheerSpeed: 2.5,
  cheerGravity: 11,
  cheerDrag: 2.6,
  cheerSpread: 0.14,
  cheerUpBias: 1.7,         // fountain, not an explosion
  // 0.62 was khaki; 1.25 clipped the overlapping sprites back to white at reveal
  // range. 0.95 keeps R just past 1 and G well under it, which is what "gold"
  // needs from an additive blend under ACES.
  cheerGain: 0.95,
  // …and the reward side of the same note: a 40-point round was scaling this to
  // 2.53 m of flat gold glow. One pig-length at the top tier.
  cheerFlashR1: 0.72, cheerFlashMs: 280,
  cheerRingR1: 1.9, cheerRingMs: 460,
  popMs: 460,               // scale-pop on a scoring pig
  popAmp: 0.30,             // × the tier, clamped
  popDamp: 2.6,
};

/** Bubblegum/strawberry sparks: the pig is pink, so its confetti is too. */
const BURST_PALETTE = [[1, 0.45, 0.6], [1, 0.25, 0.3], [1, 0.7, 0.5], [0.9, 0.12, 0.2]];
/** Gold/amber sparks for the things worth celebrating. Deliberately SATURATED:
 *  the old set was pale enough that scaling it by a sub-1 gain landed in khaki. */
const CHEER_PALETTE = [[1, 0.80, 0.20], [1, 0.60, 0.08], [1, 0.93, 0.55], [0.98, 0.45, 0.05]];

let vfx = null;              // { THREE, scene }
let sparkTex = null;         // soft round sprite for the burst points
let blinkEnd = 0;            // wall clock; pigs blink red until this
let blinkOn = false;
let blinkGroups = null;
let pop = null;              // { t, groups } — the Oinker squash-away
let bursts = null;           // [{ points, vel, t, life }]
let pops = null;             // [{ group, t, ms, amp }] — scoring scale-pops
let decals = null;           // [{ mesh, t, ms, r0, r1, kind }] — flashes and rings
let fxLast = 0;              // wall clock of the previous stepVisualFx (see there)

/**
 * Hand fx.js the renderer's THREE namespace and scene so it can add particles.
 * @param {{THREE:object, scene:object}} deps
 */
export const initVisualFx = safe(function initVisualFx({ THREE, scene } = {}) {
  if (!THREE || !scene) return false;
  vfx = { THREE, scene };
  return true;
});

/**
 * A soft round spark, built once. Without it the burst is a cloud of square
 * pixels — GL points are quads, and at this size the corners are obvious.
 */
function spark(THREE) {
  if (sparkTex) return sparkTex;
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  // ROUND-2: "no sprite falloff". A hot core with a long tail is what makes a
  // 20-px sprite read as a glowing ember rather than as a soft grey disc.
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0.00, 'rgba(255,255,255,1)');
  rg.addColorStop(0.16, 'rgba(255,255,255,0.95)');
  rg.addColorStop(0.34, 'rgba(255,255,255,0.55)');
  rg.addColorStop(0.62, 'rgba(255,255,255,0.16)');
  rg.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  sparkTex = new THREE.CanvasTexture(cv);
  return sparkTex;
}

/** A soft round puff, used for smoke. Flatter than `spark` and never additive. */
let smokeTex = null;
function smokeSprite(THREE) {
  if (smokeTex) return smokeTex;
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  // ROUND-3: "VISIBLE HARD CIRCULAR RIMS". A puff sprite still at alpha 0.32 by
  // r = 0.45 and only reaching 0 at r = 1.0 holds a NEARLY CONSTANT alpha across
  // most of its area, so its silhouette is a disc with an edge. The falloff is
  // front-loaded now: a small bright core and a long thin tail with nothing
  // resolvable at the rim.
  rg.addColorStop(0.00, 'rgba(232,226,216,0.62)');
  rg.addColorStop(0.22, 'rgba(216,208,196,0.34)');
  rg.addColorStop(0.48, 'rgba(200,190,176,0.13)');
  rg.addColorStop(0.74, 'rgba(186,176,162,0.04)');
  rg.addColorStop(1.00, 'rgba(180,170,156,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  smokeTex = new THREE.CanvasTexture(cv);
  return smokeTex;
}

/** A radial glow for the core flash: white-hot centre, coloured by the material. */
let glowTex = null;
function glowSprite(THREE) {
  if (glowTex) return glowTex;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0.00, 'rgba(255,255,255,1)');
  rg.addColorStop(0.22, 'rgba(255,255,255,0.62)');
  rg.addColorStop(0.52, 'rgba(255,255,255,0.20)');
  rg.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  glowTex = new THREE.CanvasTexture(cv);
  return glowTex;
}

/** A thin bright annulus for the shock ring. */
let ringTex = null;
function ringSprite(THREE) {
  if (ringTex) return ringTex;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0.00, 'rgba(255,255,255,0)');
  rg.addColorStop(0.68, 'rgba(255,255,255,0)');
  rg.addColorStop(0.84, 'rgba(255,255,255,0.55)');
  rg.addColorStop(0.95, 'rgba(255,255,255,1)');
  rg.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  ringTex = new THREE.CanvasTexture(cv);
  return ringTex;
}

/** Walk a pig group's unique materials once (both pigs share one material). */
function eachMaterial(groups, fn) {
  const seen = new Set();
  for (const g of groups || []) {
    if (!g || !g.traverse) continue;
    g.traverse((o) => {
      const m = o.material;
      if (!m || !m.emissive || seen.has(m)) return;
      seen.add(m);
      fn(m);
    });
  }
}

/** material → its look before the blink took it over */
const blinkSaved = new Map();

function applyBlink(on) {
  blinkOn = on;
  eachMaterial(blinkGroups, (m) => {
    if (on) {
      if (!blinkSaved.has(m)) {
        blinkSaved.set(m, {
          color: m.color ? m.color.getHex() : null,
          emissive: m.emissive.getHex(),
          intensity: m.emissiveIntensity,
        });
      }
      if (m.color) m.color.setHex(REVEAL_FX.blinkAlbedo);
      m.emissive.setHex(REVEAL_FX.blinkColor);
      m.emissiveIntensity = REVEAL_FX.blinkEmissive;
      return;
    }
    const was = blinkSaved.get(m);
    if (was) {
      if (m.color && was.color !== null) m.color.setHex(was.color);
      m.emissive.setHex(was.emissive);
      m.emissiveIntensity = was.intensity;
    } else {
      m.emissive.setHex(0x000000);
    }
  });
  if (!on) blinkSaved.clear();
}

/**
 * Blink the pigs angry red for `ms`. Call again to extend or restart.
 * @param {Array} groups pig groups (THREE.Group from buildPig)
 * @param {number} ms
 */
export const blinkRed = safe(function blinkRed(groups, ms = REVEAL_FX.pigOutBlinkMs) {
  if (!groups || !groups.length) return;
  blinkGroups = groups;
  blinkEnd = performance.now() + Math.max(0, ms);
});

/** Stop blinking and put the emissive back where it was. */
export const clearBlink = safe(function clearBlink() {
  blinkEnd = 0;
  if (blinkOn) applyBlink(false);
});

/**
 * The Oinker exit: squash-pop the pigs away and burst them into particles.
 * @param {Array} groups pig groups
 * @param {Array<{x:number,y:number,z:number}|number[]>} at world positions, one per group
 */
export const burstPigs = safe(function burstPigs(groups, at) {
  clearBlink();
  pop = { t: 0, born: performance.now(), groups: groups || [] };
  if (!vfx || !groups) return;
  groups.forEach((g, i) => {
    const src = at && at[i];
    spawnBurst({
      x: src ? (src.x ?? src[0] ?? 0) : 0,
      y: src ? (src.y ?? src[1] ?? 0) : 0.3,
      z: src ? (src.z ?? src[2] ?? 0) : 0,
    }, {
      count: REVEAL_FX.particles,
      palette: BURST_PALETTE,
      gain: REVEAL_FX.burstGain,
      speed: REVEAL_FX.burstSpeed,
      gravity: REVEAL_FX.burstGravity,
      drag: REVEAL_FX.burstDrag,
      spread: REVEAL_FX.burstSpread,
      size: REVEAL_FX.particleSize,
      life: REVEAL_FX.particleLife,
      upBias: 1.2,
      lift: 0.2,
    });
  });
  // …and the three things the round-2 review found missing, in the order they
  // read: the flash is the bang, the ring is the shock leaving, the smoke is what
  // is left where a pig used to be.
  groups.forEach((g, i) => {
    const src = at && at[i];
    const p = {
      x: src ? (src.x ?? src[0] ?? 0) : 0,
      y: src ? (src.y ?? src[1] ?? 0) : 0.3,
      z: src ? (src.z ?? src[2] ?? 0) : 0,
    };
    spawnFlash(p, {
      r0: REVEAL_FX.flashR0, r1: REVEAL_FX.flashR1,
      ms: REVEAL_FX.flashMs, color: 0xff5c8a,
    });
    spawnRing(p, {
      r0: REVEAL_FX.ringR0, r1: REVEAL_FX.ringR1,
      ms: REVEAL_FX.ringMs, color: 0xff7ba2,
    });
    spawnSmoke(p, {
      count: REVEAL_FX.smokeCount, size: REVEAL_FX.smokeSize,
      life: REVEAL_FX.smokeLife, speed: REVEAL_FX.smokeSpeed,
    });
  });
});

/**
 * One particle cloud. Extracted from burstPigs so the Oinker's pink shrapnel and
 * the scoring cheer's gold fountain are literally the same code path with
 * different constants — there is no second particle system to keep in step.
 *
 * @param {{x:number,y:number,z:number}} at world centre
 */
/**
 * The core FLASH — a camera-facing additive glow that blooms and dies.
 *
 * ROUND-2 REVIEW listed "no core flash, no glow" for the Oinker and "it reads as
 * sensor noise, not reward" for the cheer. This is the single cheapest fix for
 * both: one sprite, additive, 0.3 s. It is what makes the first FRAME of an event
 * loud, which is the frame the player's eye is actually on.
 */
function spawnFlash(at, { r0, r1, ms, color }) {
  if (!vfx) return;
  const { THREE, scene } = vfx;
  const m = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowSprite(THREE),
    color: new THREE.Color(color),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: true,
  }));
  m.position.set(at.x, at.y + 0.12, at.z);
  m.scale.setScalar(r0);
  m.renderOrder = 12;
  scene.add(m);
  decals = decals || [];
  decals.push({ mesh: m, t: 0, born: performance.now(), ms, r0, r1, kind: 'flash' });
}

/** The shock RING: a flat annulus on the felt that expands and fades. */
function spawnRing(at, { r0, r1, ms, color }) {
  if (!vfx) return;
  const { THREE, scene } = vfx;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({
      map: ringSprite(THREE),
      color: new THREE.Color(color),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: true,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(at.x, 0.012, at.z);
  m.scale.setScalar(r0);
  m.renderOrder = 11;
  scene.add(m);
  decals = decals || [];
  decals.push({ mesh: m, t: 0, born: performance.now(), ms, r0, r1, kind: 'ring' });
}

/**
 * SMOKE: big, slow, NON-additive puffs that outlive the sparks.
 *
 * The one thing additive sparks can never do is leave a mark — they only ever add
 * light, so the instant they fade the felt looks untouched. A normal-blended puff
 * darkens and then clears, which is what sells "something was destroyed here".
 */
function spawnSmoke(at, o) {
  if (!vfx) return;
  const { THREE, scene } = vfx;
  const N = Math.max(1, Math.round(o.count));
  const positions = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    positions[k * 3] = at.x + (Math.random() - 0.5) * 0.3;
    positions[k * 3 + 1] = at.y + 0.1 + Math.random() * 0.2;
    positions[k * 3 + 2] = at.z + (Math.random() - 0.5) * 0.3;
    const th = Math.random() * Math.PI * 2;
    const sp = o.speed * (0.3 + Math.random() * 0.8);
    vel[k * 3] = Math.cos(th) * sp * 0.7;
    vel[k * 3 + 1] = sp * (0.5 + Math.random() * 0.6);
    vel[k * 3 + 2] = Math.sin(th) * sp * 0.7;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    size: o.size,
    map: smokeSprite(THREE),
    color: new THREE.Color(REVEAL_FX.smokeColor),
    transparent: true,
    opacity: REVEAL_FX.smokeOpacity,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 9;
  scene.add(points);
  bursts = bursts || [];
  bursts.push({
    points, vel, t: 0, born: performance.now(), life: o.life, gravity: -0.5, drag: 1.6,
    grow: REVEAL_FX.smokeGrow, size0: o.size, fade: REVEAL_FX.smokeOpacity,
    ground: false,
  });
}

function spawnBurst(at, o) {
  if (!vfx) return;
  const { THREE, scene } = vfx;
  const N = Math.max(1, Math.round(o.count));
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    const s = o.spread;
    positions[k * 3] = at.x + (Math.random() - 0.5) * s;
    positions[k * 3 + 1] = at.y + (o.lift || 0) + (Math.random() - 0.5) * s;
    positions[k * 3 + 2] = at.z + (Math.random() - 0.5) * s;
    // uniform direction on the sphere, biased upward so it reads as a puff
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const sp = o.speed * (0.4 + Math.random() * 0.8);
    vel[k * 3] = Math.sin(ph) * Math.cos(th) * sp;
    vel[k * 3 + 1] = Math.abs(Math.cos(ph)) * sp * (o.upBias || 1.2);
    vel[k * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
    const c = o.palette[(Math.random() * o.palette.length) | 0];
    const g = o.gain * (0.7 + Math.random() * 0.5);
    colors[k * 3] = c[0] * g; colors[k * 3 + 1] = c[1] * g; colors[k * 3 + 2] = c[2] * g;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: o.size,
    map: spark(THREE),
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 10;
  scene.add(points);
  bursts = bursts || [];
  bursts.push({
    points, vel, t: 0, born: performance.now(), life: o.life, gravity: o.gravity,
    // ROUND-2: drag bounds the cloud (it spanned the whole board before) and
    // `ground` stops it sinking through the felt (it reached y −1.03).
    drag: o.drag || 0, ground: true,
  });
}

/**
 * cheer(at, points) — the visual payoff for a SCORE (SPEC "Presentation model":
 * the reward beats must be at least as loud as the failure beats).
 *
 * A gold fountain per scoring pig, sized by what the round was worth: a 5-point
 * Trotter gets a modest puff, a 60-point Double Jowler gets a wall of sparks.
 * Deliberately a fountain rather than a sphere — it rises off the pig and falls
 * back onto the felt, which reads as celebration; the Oinker's burst is a
 * sphere, which reads as destruction. Same code, opposite feeling.
 *
 * @param {Array<{x:number,y:number,z:number}>} at one world position per burst
 * @param {number} points the round's score, used to size the burst
 */
export const cheer = safe(function cheer(at, points = 5) {
  if (!vfx || !at || !at.length) return;
  const tier = clamp(points / 10, 0.5, 4);
  const count = Math.min(
    REVEAL_FX.cheerParticlesMax,
    Math.round(REVEAL_FX.cheerParticles * (0.7 + tier * 0.9)),
  );
  for (const p of at) {
    const c = { x: p.x ?? p[0] ?? 0, y: p.y ?? p[1] ?? 0, z: p.z ?? p[2] ?? 0 };
    spawnBurst(c, {
      count,
      palette: CHEER_PALETTE,
      gain: REVEAL_FX.cheerGain,
      speed: REVEAL_FX.cheerSpeed * (0.82 + tier * 0.12),
      gravity: REVEAL_FX.cheerGravity,
      drag: REVEAL_FX.cheerDrag,
      spread: REVEAL_FX.cheerSpread,
      size: REVEAL_FX.cheerSize * (0.85 + tier * 0.10),
      life: REVEAL_FX.cheerLife,
      upBias: REVEAL_FX.cheerUpBias,
      lift: 0.12,
    });
    // SPEC beat 5, "must match beat 4 for loudness": the failure beat has a flash
    // and a ring, so the reward beat has a flash and a ring. Both scale with the
    // tier, so a Sider gets a spark and a Double Jowler gets a bloom.
    spawnFlash(c, {
      r0: 0.24, r1: REVEAL_FX.cheerFlashR1 * (0.7 + tier * 0.22),
      ms: REVEAL_FX.cheerFlashMs, color: 0xffd257,
    });
    spawnRing(c, {
      r0: 0.22, r1: REVEAL_FX.cheerRingR1 * (0.7 + tier * 0.22),
      ms: REVEAL_FX.cheerRingMs, color: 0xffc93f,
    });
  }
});

/**
 * popPigs(groups, points) — a squash-and-stretch bounce on the pigs that scored.
 *
 * Scale only, on purpose: game.js's `apply()` rewrites position and quaternion
 * from the replay state every frame, so a hop would be stamped out, but nothing
 * else touches `scale`. Damped, so it lands rather than wobbling.
 */
export const popPigs = safe(function popPigs(groups, points = 5) {
  if (!groups || !groups.length) return;
  const amp = REVEAL_FX.popAmp * clamp(points / 20, 0.55, 1.6);
  pops = pops || [];
  for (const g of groups) {
    if (!g) continue;
    pops = pops.filter((p) => p.group !== g);
    pops.push({ group: g, t: 0, born: performance.now(), ms: REVEAL_FX.popMs, amp });
  }
});

/** Pigs back on stage: visible, unit scale, no blink, no leftover sparks. */
export const resetPigVisuals = safe(function resetPigVisuals(groups) {
  clearBlink();
  pop = null;
  pops = null;
  for (const g of groups || []) {
    if (!g) continue;
    g.visible = true;
    g.scale.set(1, 1, 1);
  }
  disposeBursts(true);
});

function disposeBursts(all = false) {
  if (bursts) {
    bursts = bursts.filter((b) => {
      if (!all && b.t < b.life) return true;
      vfx?.scene.remove(b.points);
      b.points.geometry.dispose();
      b.points.material.dispose();
      return false;
    });
    if (!bursts.length) bursts = null;
  }
  if (all && decals) {
    for (const d of decals) {
      vfx?.scene.remove(d.mesh);
      d.mesh.geometry?.dispose();
      d.mesh.material.dispose();
    }
    decals = null;
  }
}

/**
 * Age the visual FX. Call once per rendered frame from the game's rAF loop.
 * @param {number} dt seconds since the previous call
 * @returns {boolean} true while anything is still animating (so the caller
 *   knows it must keep painting even though the pigs themselves are at rest)
 */
export const stepVisualFx = safe(function stepVisualFx(dtArg = 0) {
  let active = false;
  const now = performance.now();
  /* ROUND-3, and it is the other half of the "bubbles" report: "on the Oinker the
   * entire board is bubbles with a pig sitting untouched in the middle" — a pig
   * that had already come back for the NEXT toss. The blink has always run on the
   * wall clock; everything else here aged on the caller's frame `dt`, which the
   * game clamps to 0.1 s so one slow frame cannot teleport a pig. On a renderer
   * that paints twice a second that clamp means a 1.15 s puff takes twelve real
   * SECONDS to expire, so it is still on screen several beats later — and every
   * screenshot in between catches it near t = 0, at full size and full opacity.
   *
   * So the whole of this function is on the wall clock now: every effect carries
   * its `born` timestamp and its age is `now − born`, exactly like the blink's
   * cadence — not a sum of frame deltas, which is also what stops an effect that
   * happened to be spawned just before a long stall from being aged to death on
   * the frame after it. Integration still steps by a CLAMPED dt (a 5 s gap must
   * not fling a spark across the room), so a starved renderer shows fewer frames
   * of an effect rather than a slow-motion one that never ends. */
  const raw = fxLast ? (now - fxLast) / 1000 : dtArg;
  fxLast = now;
  const dt = Math.min(raw > 0 ? raw : dtArg, 0.1);

  // red blink — a square wave on the wall clock, so it stays on cadence even
  // if a frame is late
  const want = now < blinkEnd && Math.floor(now / REVEAL_FX.blinkPeriodMs) % 2 === 0;
  if (want !== blinkOn) applyBlink(want);
  if (now < blinkEnd) active = true;

  if (pop) {
    pop.t = (now - pop.born) / 1000;
    const s = Math.max(0, 1 - pop.t / REVEAL_FX.popTime);
    for (const g of pop.groups) {
      if (!g) continue;
      if (s > 0) g.scale.set(1 + s * 0.2, s, 1 + s * 0.2); // squash as it vanishes
      else { g.visible = false; g.scale.set(1, 1, 1); }
    }
    // once they are gone they STAY gone (SPEC: "until the next toss brings them
    // back"), so the pop retires itself rather than re-hiding them every frame
    if (s > 0) active = true; else pop = null;
  }

  // scoring scale-pops: a damped squash-and-stretch that lands on 1
  if (pops) {
    for (const p of pops) {
      p.t = (now - p.born) / 1000;
      const f = Math.min(1, (p.t * 1000) / p.ms);
      const k = Math.sin(f * Math.PI * 1.5) * Math.exp(-REVEAL_FX.popDamp * f);
      const sy = 1 + p.amp * k;
      const sxz = 1 - p.amp * k * 0.42;
      p.group.scale.set(sxz, sy, sxz);
    }
    pops = pops.filter((p) => {
      if (p.t * 1000 < p.ms) return true;
      p.group.scale.set(1, 1, 1);
      return false;
    });
    if (!pops.length) pops = null;
    else active = true;
  }

  if (bursts) {
    for (const b of bursts) {
      b.t = (now - b.born) / 1000;
      const g = b.gravity;
      const damp = b.drag ? Math.exp(-b.drag * dt) : 1;
      const pos = b.points.geometry.attributes.position;
      const arr = pos.array, vel = b.vel;
      for (let i = 0; i < vel.length; i += 3) {
        vel[i + 1] -= g * dt;
        if (damp !== 1) { vel[i] *= damp; vel[i + 1] *= damp; vel[i + 2] *= damp; }
        arr[i] += vel[i] * dt;
        arr[i + 1] += vel[i + 1] * dt;
        arr[i + 2] += vel[i + 2] * dt;
        // The felt is solid. MEASURED before this existed: sparks reached y −1.03,
        // i.e. a metre UNDER the table, which is the tell that turned the burst
        // into "sensor noise". They now land, skip once, and die on the cloth.
        if (b.ground && arr[i + 1] < REVEAL_FX.groundY) {
          arr[i + 1] = REVEAL_FX.groundY;
          if (vel[i + 1] < 0) {
            vel[i + 1] *= -REVEAL_FX.groundBounce;
            vel[i] *= REVEAL_FX.groundFriction;
            vel[i + 2] *= REVEAL_FX.groundFriction;
          }
        }
      }
      pos.needsUpdate = true;
      const f = b.t / b.life;
      // hold full brightness for the first third, then fall away — a spark that
      // starts fading on frame one never reads as a spark
      const peak = b.fade === undefined ? 1 : b.fade;
      b.points.material.opacity = peak * Math.max(0, Math.min(1, (1 - f) / 0.67));
      if (b.grow) b.points.material.size = (b.size0 || REVEAL_FX.smokeSize) * (1 + f * b.grow);
    }
    disposeBursts();
    if (bursts) active = true;
  }

  // flashes and rings: expand on an ease-out and fade
  if (decals) {
    for (const d of decals) {
      d.t = (now - d.born) / 1000;
      const f = Math.min(1, (d.t * 1000) / d.ms);
      const e = 1 - (1 - f) * (1 - f) * (1 - f);
      d.mesh.scale.setScalar(d.r0 + (d.r1 - d.r0) * e);
      // a flash punches out fast; a ring holds its edge longer
      d.mesh.material.opacity = d.kind === 'flash'
        ? Math.max(0, 1 - f * f)
        : Math.max(0, 1 - f) * REVEAL_FX.ringOpacity;
    }
    decals = decals.filter((d) => {
      if (d.t * 1000 < d.ms) return true;
      vfx?.scene.remove(d.mesh);
      d.mesh.geometry?.dispose();
      d.mesh.material.dispose();
      return false;
    });
    if (!decals.length) decals = null; else active = true;
  }

  return active;
});

/** @returns {boolean} is any reveal animation (failure OR celebration) running? */
export function visualFxActive() {
  return performance.now() < blinkEnd || !!bursts || !!pop || !!pops || !!decals;
}

/* =========================================================================
 * High-level cues game.js already calls
 *
 * game.js fires BOTH a specific cue and revealToss for the same event
 * (`sadness('pigout')` then `revealToss({type:'pigout'})`), so every
 * headline cue passes through a short dedupe window. Whichever call arrives
 * first wins and the echo is dropped.
 * ==================================================================== */

const recent = new Map();
function once(key, ms = 500) {
  const now = performance.now();
  const prev = recent.get(key);
  if (prev != null && now - prev < ms) return false;
  recent.set(key, now);
  if (recent.size > 24) recent.clear();
  return true;
}

const POSE_POINTS = {
  'side-blank': 0, 'side-dot': 0, razorback: 5, trotter: 5, snouter: 10, jowler: 15,
};

/**
 * The audio half of the reveal sequence (PRD §8.1): a pip per pig, staggered,
 * then the sum landing, then the pig's opinion of the result.
 * @param {object} result { type, points, a, b, oinker }
 */
export const revealToss = safe(function revealToss(result) {
  if (!result) return;
  const type = result.oinker ? 'oinker' : result.type;

  if (type === 'oinker') { if (once('oinker', 2500)) oinker(); return; }
  if (type === 'pigout') { if (once('pigout', 900)) pigOut(); return; }
  if (!live()) return;

  if (type === 'double') {
    if (once('double', 900)) doubleFanfare(result.a || 1);
    return;
  }

  // per-pig pips, ~150 ms apart per PRD §8.1 beat 3
  const pa = POSE_POINTS[result.a] ?? 0;
  const pb = POSE_POINTS[result.b] ?? 0;
  score(Math.max(pa, 1), { delay: 0, gain: pa > 0 ? 1 : 0.55 });
  score(Math.max(pb, 1), { delay: 0.15, gain: pb > 0 ? 1 : 0.55 });

  // beat 4: the sum landing in the turn total
  const total = Number(result.points) || 0;
  if (total > 0) score(total, { delay: 0.42, gain: 1.05 });

  if (total >= 10) pigVoice('happy-oink', { delay: 0.6, gain: 0.8 });
  else if (total > 0) pigVoice('grunt', { delay: 0.58, gain: 0.55, rate: 0.9 });
  haptic('land');
});

/**
 * The AUDIO half of a celebration. The visual half is `cheer()` + `popPigs()`,
 * driven from game.js because it is the only module that knows where the pigs
 * are and which of them scored — and a camera punch, which only game.js can do.
 * Round-1 review: this function used to BE the whole celebration, which is how
 * the game ended up rewarding a Double Trotter with silence.
 * @param {'double'|'bank'|'win'} type
 */
export const celebrate = safe(function celebrate(type) {
  if (type === 'double') { if (once('double', 900)) doubleFanfare(1); return; }
  if (type === 'bank') { if (once('bank', 400)) bank(); return; }
  if (type === 'win') { if (once('win', 3000)) win(); }
});

/** @param {'pigout'|'oinker'} type */
export const sadness = safe(function sadness(type) {
  if (type === 'oinker') { if (once('oinker', 2500)) oinker(); return; }
  if (type === 'pigout') { if (once('pigout', 900)) pigOut(); }
});

/* =========================================================================
 * Housekeeping
 * ==================================================================== */

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    // rAF stops in a hidden tab but setInterval does not — don't leave a
    // rattle scheduling ticks into a backgrounded context.
    if (document.hidden) stopShakeLoop();
  });
}
