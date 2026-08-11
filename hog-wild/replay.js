// hog-wild/replay.js
//
// Recording playback math. Turns a physics.js Recording (fixed 1/120s frames)
// into an interpolated { p, q } at an arbitrary wall-clock time, so a 120 Hz
// simulation can be shown honestly on a 60 Hz — or 144 Hz — display without
// the pigs stepping or teleporting.
//
// ZERO DEPENDENCIES on purpose: no DOM, no three, no cannon. That is what lets
// dev/replay-test.mjs verify the interpolation headlessly in node against real
// recordings, which is the only way to be sure the replay the player sees is
// the trajectory the physics actually produced.
//
// Recording format (SPEC.md):
//   single: { dt, frames:[{ p:[x,y,z], q:[x,y,z,w] }], settledPose }
//   pair:   { dt, frames:[{ p1,q1,p2,q2 }], pair:true }   // Oinker only

/** true for a PairRecording (both pigs in one simulation — Oinker). */
export function isPair(rec) {
  if (!rec || !rec.frames || !rec.frames.length) return false;
  return rec.pair === true || rec.frames[0].p1 !== undefined;
}

export function frameCount(rec) {
  return rec && rec.frames ? rec.frames.length : 0;
}

/** Wall-clock length of a recording, in seconds. */
export function duration(rec) {
  return frameCount(rec) * (rec?.dt ?? 1 / 120);
}

/** which: 0 → {p,q} (single) · 1 → {p1,q1} · 2 → {p2,q2} (pair) */
function keysFor(rec, which) {
  if (which === 1) return ['p1', 'q1'];
  if (which === 2) return ['p2', 'q2'];
  return isPair(rec) ? ['p1', 'q1'] : ['p', 'q'];
}

export function lerpInto(out, a, b, f) {
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
  return out;
}

/**
 * Shortest-arc quaternion interpolation. Hand-rolled so this module stays
 * dependency-free; falls back to normalized lerp for nearly-parallel inputs,
 * where the trig form loses precision.
 */
export function slerpInto(out, a, b, f) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0, s1;
  if (cos > 0.9995) {
    s0 = 1 - f; s1 = f;
  } else {
    const theta = Math.acos(cos < -1 ? -1 : cos > 1 ? 1 : cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - f) * theta) / sin;
    s1 = Math.sin(f * theta) / sin;
  }
  let x = ax * s0 + bx * s1;
  let y = ay * s0 + by * s1;
  let z = az * s0 + bz * s1;
  let w = aw * s0 + bw * s1;
  const l = Math.hypot(x, y, z, w) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l; out[3] = w / l;
  return out;
}

/**
 * State of one pig `t` seconds into `rec`, written into out = { p:[3], q:[4] }.
 * Before the start it holds frame 0; past the end it holds the final rest —
 * which is exactly what a shorter recording should do while the other pig is
 * still tumbling, and what both should do during the settle beat.
 */
export function sampleAt(rec, t, out, which = 0) {
  const [pk, qk] = keysFor(rec, which);
  const frames = rec.frames;
  const n = frames.length;
  const dt = rec.dt ?? 1 / 120;
  const idx = t / dt;
  let i0 = Math.floor(idx);
  if (i0 < 0) i0 = 0;
  if (i0 > n - 1) i0 = n - 1;
  let f = idx - i0;
  if (f < 0) f = 0; else if (f > 1) f = 1;
  // t is usually built up by repeated float addition, so a caller asking for
  // exactly frame k can land on k-1 + 0.99999999. Snap: an interpolation that
  // close to a frame must BE that frame, or "sampling at a frame time returns
  // that frame" stops being true and dev/replay-test.mjs can't assert it.
  if (f > 1 - 1e-9) { i0 = i0 + 1 > n - 1 ? n - 1 : i0 + 1; f = 0; }
  else if (f < 1e-9) f = 0;
  const i1 = i0 + 1 > n - 1 ? n - 1 : i0 + 1;
  const a = frames[i0], b = frames[i1];
  if (i0 === i1 || f === 0) {
    const p = a[pk], q = a[qk];
    out.p[0] = p[0]; out.p[1] = p[1]; out.p[2] = p[2];
    out.q[0] = q[0]; out.q[1] = q[1]; out.q[2] = q[2]; out.q[3] = q[3];
    return out;
  }
  lerpInto(out.p, a[pk], b[pk], f);
  slerpInto(out.q, a[qk], b[qk], f);
  return out;
}

/** The recording's final resting state, written into out. */
export function lastState(rec, out, which = 0) {
  return sampleAt(rec, duration(rec) + 1, out, which);
}

/** The recording's first frame, written into out. */
export function firstState(rec, out, which = 0) {
  return sampleAt(rec, 0, out, which);
}

/** Interpolate between two { p, q } states (used for the cup → release tween). */
export function tweenInto(out, from, to, f) {
  lerpInto(out.p, from.p, to.p, f);
  slerpInto(out.q, from.q, to.q, f);
  return out;
}

/** Smoothstep ease, for tweens that must not start or stop with a jerk. */
export function ease(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** A fresh, reusable sample target. */
export function makeState() {
  return { p: [0, 0, 0], q: [0, 0, 0, 1] };
}

export default { isPair, frameCount, duration, sampleAt, lastState, firstState, tweenInto, slerpInto, lerpInto, ease, makeState };
