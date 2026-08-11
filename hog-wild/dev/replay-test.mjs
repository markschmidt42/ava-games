#!/usr/bin/env node
// dev/replay-test.mjs — the integration gate.
//
// Everything the browser does between "odds.js drew an outcome" and "the pigs
// are lying on the felt with labels over them", minus the DOM:
//
//   1. drawToss() picks the outcome FIRST (Approach B, SPEC.md)
//   2. TrajectoryCache serves a recording per pig, lane -1 and lane +1
//   3. replay.js samples those recordings at a display refresh rate
//   4. the sampled motion is checked for the things a player would notice:
//      no teleporting, no interpenetration, and a final rest that classifies
//      as the pose the label is about to claim
//
// Run: node hog-wild/dev/replay-test.mjs

import { PigSim, TrajectoryCache, classify, PIG_RADIUS, LANE, POSE_KEYS, withinPen, withinHalf } from '../physics.js';
import { drawToss, scoreToss, POSES } from '../odds.js';
import { sampleAt, duration, lastState, makeState, isPair, frameCount } from '../replay.js';

const D2R = Math.PI / 180;
let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
function h(title) {
  console.log(`\n${'-'.repeat(78)}\n${title}\n${'-'.repeat(78)}`);
}

// deterministic rng so a failure is reproducible
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry(20260810);

// Recorded quaternions are not exactly unit-norm (cannon renormalizes to float
// tolerance), so the dot product of a quaternion with ITSELF is ~1-5e-13 and a
// naive acos reports a spurious 5e-5°. Normalizing first is what makes "this
// sample is bit-identical to that frame" testable at all.
const angleBetween = (a, b) => {
  const la = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  const lb = Math.hypot(b[0], b[1], b[2], b[3]) || 1;
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (la * lb);
  return 2 * Math.acos(Math.min(1, d)) / D2R;
};
// acos has infinite slope at 1, so the angle metric bottoms out around 1e-5°
// even for two bit-identical quaternions. "Is this literally the same rotation"
// therefore has to be asked componentwise (up to the q/-q double cover).
const quatDiff = (a, b) => {
  const s = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) < 0 ? -1 : 1;
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.abs(a[i] - s * b[i]));
  return m;
};

console.log('='.repeat(78));
console.log('REPLAY / INTEGRATION TEST — recording → screen');
console.log('='.repeat(78));

const sim = new PigSim();
const cache = new TrajectoryCache(sim, { rng, chunkSims: 10 });

// ---------------------------------------------------------------------------
h('0. WARM CACHE  (the sliced prefill the game runs at boot and during a shake)');
// ---------------------------------------------------------------------------
{
  const t0 = Date.now();
  let filled = 0, slices = 0;
  // the game spends idle-callback slices, never one long block
  while (cache.needsRefill && slices < 120) { filled += cache.prefill(20); slices++; }
  console.log(`  ${slices} slices of ≤20ms filled ${filled} recordings in ${Date.now() - t0}ms`);
  const thin = POSE_KEYS.filter((k) => cache.count(k, -1) < 1 || cache.count(k, 1) < 1);
  check(thin.length === 0, 'every pose has a recording ready in both lanes', thin.join(', '));
  check(cache.oinkers.length > 0, 'an oinker pair is held in reserve');
}

// ---------------------------------------------------------------------------
h('1. SAMPLING FIDELITY  (a sample at a frame time IS that frame)');
// ---------------------------------------------------------------------------
{
  const rec = sim.findRecording('razorback', { rng, side: -1 });
  check(!!rec, 'got a razorback recording to sample');
  const st = makeState();
  let maxErr = 0;
  for (let i = 0; i < rec.frames.length; i++) {
    sampleAt(rec, i * rec.dt, st);
    const f = rec.frames[i];
    maxErr = Math.max(
      maxErr,
      Math.abs(st.p[0] - f.p[0]), Math.abs(st.p[1] - f.p[1]), Math.abs(st.p[2] - f.p[2]),
      quatDiff(st.q, f.q),
    );
  }
  check(maxErr < 1e-12, 'sampling at exact frame times reproduces the frames', `max error ${maxErr.toExponential(2)}`);

  // halfway between two frames must land between them, not on one of them
  sampleAt(rec, 10.5 * rec.dt, st);
  const a = rec.frames[10], b = rec.frames[11];
  const mid = [0, 1, 2].every((k) => (st.p[k] - a.p[k]) * (st.p[k] - b.p[k]) <= 1e-12);
  check(mid, 'a sample between frames interpolates position');
  const halfAng = angleBetween(a.q, b.q) / 2;
  check(Math.abs(angleBetween(st.q, a.q) - halfAng) < 1e-6, 'a sample between frames slerps rotation',
    `${angleBetween(st.q, a.q).toFixed(4)}° vs half-step ${halfAng.toFixed(4)}°`);

  // past the end it holds the rest, before the start it holds frame 0
  const end = makeState(); lastState(rec, end);
  const past = makeState(); sampleAt(rec, duration(rec) + 3, past);
  check(quatDiff(end.q, past.q) < 1e-12 && Math.abs(end.p[1] - past.p[1]) < 1e-12,
    'sampling past the end holds the final rest (short pig waits for the long one)');
  const pre = makeState(); sampleAt(rec, -0.5, pre);
  check(quatDiff(pre.q, rec.frames[0].q) < 1e-12, 'sampling before the start holds frame 0');
}

// ---------------------------------------------------------------------------
h('2. SMOOTHNESS  (what the player sees at 60 / 144 Hz — no teleporting)');
// ---------------------------------------------------------------------------
// The pigs really are moving fast — gravity is 21.6 m/s² and a throw released
// at 1.9 m is doing ~10 m/s when it lands, which is 16 cm per 60 Hz frame of
// honest motion. So "smooth" cannot mean "small steps"; it means the sampled
// step never exceeds the motion the simulation itself had over the same
// interval. A 60 Hz frame spans two 120 Hz physics frames, so any sampled step
// bigger than ~2× the largest physics step is interpolation gone wrong.
function physicsStep(rec, which = 0) {
  const pk = which === 1 ? 'p1' : which === 2 ? 'p2' : (isPair(rec) ? 'p1' : 'p');
  let m = 0;
  for (let i = 1; i < rec.frames.length; i++) {
    const a = rec.frames[i - 1][pk], b = rec.frames[i][pk];
    m = Math.max(m, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return m;
}

{
  const worst = { hz60: { p: 0, a: 0, pose: '', ratio: 0 }, hz144: { p: 0, a: 0, pose: '', ratio: 0 } };
  for (const pose of POSE_KEYS) {
    const rec = cache.take(pose, -1);
    if (!check(!!rec && !!rec.frames, `recording for ${pose}`)) continue;
    const simStep = physicsStep(rec);
    for (const [key, hz] of [['hz60', 60], ['hz144', 144]]) {
      const step = 1 / hz;
      const cur = makeState(), prev = makeState();
      sampleAt(rec, 0, prev);
      for (let t = step; t < duration(rec) + 0.4; t += step) {
        sampleAt(rec, t, cur);
        const dp = Math.hypot(cur.p[0] - prev.p[0], cur.p[1] - prev.p[1], cur.p[2] - prev.p[2]);
        const da = angleBetween(cur.q, prev.q);
        if (dp > worst[key].p) { worst[key].p = dp; worst[key].pose = pose; }
        if (da > worst[key].a) worst[key].a = da;
        const ratio = simStep > 1e-6 ? dp / simStep : 0;
        if (ratio > worst[key].ratio) worst[key].ratio = ratio;
        prev.p[0] = cur.p[0]; prev.p[1] = cur.p[1]; prev.p[2] = cur.p[2];
        prev.q[0] = cur.q[0]; prev.q[1] = cur.q[1]; prev.q[2] = cur.q[2]; prev.q[3] = cur.q[3];
      }
    }
  }
  console.log(`  60 Hz worst step: ${(worst.hz60.p * 100).toFixed(1)} cm, ${worst.hz60.a.toFixed(1)}°  (${worst.hz60.pose}) — ${worst.hz60.ratio.toFixed(2)}× the biggest physics step`);
  console.log(` 144 Hz worst step: ${(worst.hz144.p * 100).toFixed(1)} cm, ${worst.hz144.a.toFixed(1)}° — ${worst.hz144.ratio.toFixed(2)}×`);
  check(worst.hz60.ratio < 2.2, 'no 60 Hz step outruns 2 physics frames of real motion');
  check(worst.hz144.ratio < 1.1, 'no 144 Hz step outruns 1 physics frame of real motion');
  check(worst.hz60.a < 60, 'no rotational jump over 60° at 60 Hz (spin caps at 30 rad/s)');
  check(worst.hz144.p < worst.hz60.p * 0.6 + 1e-6, 'a faster display gets proportionally smaller steps');
}

// ---------------------------------------------------------------------------
h('3. THE LABEL TELLS THE TRUTH  (final rest classifies as the drawn pose)');
// ---------------------------------------------------------------------------
{
  const tally = {};
  let mismatched = 0, fallbacks = 0, tosses = 0;
  const st = makeState();
  for (let i = 0; i < 60; i++) {
    const outcome = drawToss(rng);
    if (outcome.oinker) continue;       // section 5
    tosses++;
    for (const [pose, side] of [[outcome.a, -1], [outcome.b, 1]]) {
      const rec = cache.take(pose, side);
      if (!rec) { mismatched++; continue; }
      if (rec.fallbackFrom) { fallbacks++; continue; }
      lastState(rec, st);
      const c = classify({ x: st.q[0], y: st.q[1], z: st.q[2], w: st.q[3] });
      tally[pose] = (tally[pose] ?? 0) + 1;
      if (c.pose !== pose) {
        mismatched++;
        console.log(`    ✗ drew ${pose}, replay ends as ${c.pose} (conf ${c.confidence.toFixed(2)})`);
      }
    }
  }
  console.log(`  ${tosses} drawn tosses served: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  check(mismatched === 0, 'every replayed recording ends in the pose the label will claim');
  check(fallbacks === 0, 'no §6.3 fallbacks needed', `${fallbacks} fallback(s)`);
}

// ---------------------------------------------------------------------------
h('4. TWO LANES, ONE SCREEN  (independent recordings replayed together)');
// ---------------------------------------------------------------------------
{
  let worstGap = Infinity, worstPair = '';
  let outOfPen = 0, outOfLane = 0;
  const A = makeState(), B = makeState();
  for (let i = 0; i < 25; i++) {
    const outcome = drawToss(rng);
    const poseA = outcome.oinker ? 'side-blank' : outcome.a;
    const poseB = outcome.oinker ? 'side-dot' : outcome.b;
    const recA = cache.take(poseA, -1);
    const recB = cache.take(poseB, 1);
    if (!recA || !recB) { failures++; continue; }
    const dur = Math.max(duration(recA), duration(recB));
    for (let t = 0; t <= dur + 0.3; t += 1 / 60) {
      sampleAt(recA, t, A);
      sampleAt(recB, t, B);
      const gap = Math.hypot(A.p[0] - B.p[0], A.p[1] - B.p[1], A.p[2] - B.p[2]);
      if (gap < worstGap) { worstGap = gap; worstPair = `${poseA}/${poseB}`; }
      if (!withinPen(A.p) || !withinPen(B.p)) outOfPen++;
      if (!withinHalf(A.p, -1) || !withinHalf(B.p, 1)) outOfLane++;
    }
  }
  console.log(`  closest the two pigs ever came: ${worstGap.toFixed(3)} (${worstPair}); collider radius ${PIG_RADIUS.toFixed(3)}, lane inner ${LANE.inner.toFixed(3)}`);
  check(worstGap > 2 * PIG_RADIUS, 'replayed pigs can never intersect (gap > 2 × collider radius)');
  check(outOfPen === 0, 'no sampled frame leaves the pen', `${outOfPen} frames`);
  check(outOfLane === 0, 'no sampled frame leaves its own half', `${outOfLane} frames`);
}

// ---------------------------------------------------------------------------
h('5. OINKER  (one PairRecording drives both pigs)');
// ---------------------------------------------------------------------------
{
  const pair = cache.takeOinker();
  if (check(!!pair, 'got a PairRecording')) {
    check(isPair(pair), 'replay.js recognises it as a pair', `${frameCount(pair)} frames`);
    const A = makeState(), B = makeState();
    lastState(pair, A, 1);
    lastState(pair, B, 2);
    const gap = Math.hypot(A.p[0] - B.p[0], A.p[1] - B.p[1], A.p[2] - B.p[2]);
    console.log(`  resting COM distance ${gap.toFixed(3)} (touching means < ~2 × ${PIG_RADIUS.toFixed(3)})`);
    check(gap < 2 * PIG_RADIUS, 'the two pigs end up touching');
    // and the pair replay must also be smooth
    let worst = 0;
    const cur = makeState(), prev = makeState();
    sampleAt(pair, 0, prev, 1);
    for (let t = 1 / 60; t < duration(pair); t += 1 / 60) {
      sampleAt(pair, t, cur, 1);
      worst = Math.max(worst, Math.hypot(cur.p[0] - prev.p[0], cur.p[1] - prev.p[1], cur.p[2] - prev.p[2]));
      prev.p[0] = cur.p[0]; prev.p[1] = cur.p[1]; prev.p[2] = cur.p[2];
    }
    const ratio = worst / physicsStep(pair, 1);
    check(ratio < 2.2, 'pair replay is smooth at 60 Hz',
      `worst step ${(worst * 100).toFixed(1)} cm = ${ratio.toFixed(2)}× a physics step`);
  }
}

// ---------------------------------------------------------------------------
h('6. SCORING PIPELINE  (drawn outcome → scoreToss → turn arithmetic)');
// ---------------------------------------------------------------------------
{
  // the exact arithmetic game.js performs, replayed headlessly over a long game
  const r2 = mulberry(7);
  let turn = 0, score = 0, banked = 0, pigouts = 0, oinkers = 0;
  for (let i = 0; i < 20000; i++) {
    const o = drawToss(r2);
    if (o.oinker) { turn = 0; score = 0; oinkers++; continue; }
    const res = scoreToss(o.a, o.b);
    if (res.type === 'pigout') { turn = 0; pigouts++; continue; }
    turn += res.points;
    if (turn >= 22) { score += turn; banked++; turn = 0; }   // a plain "bank at 22" bot
  }
  console.log(`  20k tosses: ${banked} banks, ${pigouts} pig outs, ${oinkers} oinkers, final score ${score}`);
  check(score > 0 && Number.isInteger(score), 'turn/score arithmetic stays an integer and grows');
  check(POSES['side-blank'].points === 0 && scoreToss('side-blank', 'side-blank').points === 1,
    'a Sider is 1 point even though each side pig is worth 0');
  check(scoreToss('jowler', 'jowler').points === 60, 'double jowler is 60');
  check(scoreToss('razorback', 'side-dot').points === 5, 'razorback + side is 5');
}

console.log(`\ncache stats: ${JSON.stringify(cache.stats)}`);
console.log('='.repeat(78));
console.log(`Replay gate: ${failures === 0 ? 'PASS' : `FAIL (${failures} check${failures === 1 ? '' : 's'})`}`);
console.log('='.repeat(78));
process.exit(failures === 0 ? 0 : 1);
