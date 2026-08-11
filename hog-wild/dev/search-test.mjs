// M1 GATE (PRD §12 / SPEC "Approach B invariants"): prove the trajectory search
// can produce EVERY drawn outcome, from real physics, inside the game's budget.
//
//   node dev/search-test.mjs [--trials 6] [--seed 11] [--verbose]
//
// Five sections:
//   1. DETERMINISM   a stored toss replays bit-identically even after the search
//                    has abandoned other candidates mid-flight in the same world
//                    (the fallback path and the cache both rely on this)
//   2. PER-POSE      findRecording must hit every pose within maxSims=800, on
//                    BOTH halves of the pen; every frame of every accepted
//                    recording is checked against the pen and its own half, and
//                    the last frame is re-classified independently
//   3. MIRROR        mirror augmentation: reflecting a recording through the
//                    pen's long axis must produce either a verified recording of
//                    the mirror pose, or nothing (the pig is chiral — see
//                    physics.js MIRROR_POSE)
//   4. OINKER        the joint search finds two pigs at rest in contact within
//                    3000 sims (halves deliberately do not apply here)
//   5. CACHE         prefill(budgetMs) respects its budget and fills every pool;
//                    take() hands back verified recordings and asks for a refill
import {
  PigSim, TrajectoryCache, POSE_KEYS, POSE_UP, PEN, PIG_RADIUS, LANE, FIXED_DT,
  MIRROR_POSE, POSE_SAMPLING, classify, mirrorRecording, verifyRecording,
  withinPen, withinHalf, randomToss,
} from '../physics.js';

// --- args ------------------------------------------------------------------
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const TRIALS = Number(arg('trials', 6));
const SEED = Number(arg('seed', 11));
const VERBOSE = process.argv.includes('--verbose');

const MAX_SIMS = 800;          // per-pose search budget (mission requirement)
const OINKER_MAX_SIMS = 3000;
const JOWLER_MS_BUDGET = 400;  // the gate: jowler search must average under this
const MIN_CONFIDENCE = 0.12;
// The rare poses are geometric-tail searches: the sims-to-first-hit is roughly
// exponential, so its sample mean is noisy and the rarest pose needs the most
// samples before the printed average means anything.
const EXTRA_TRIALS = { snouter: 2, jowler: 3 };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const quant = (a, q) => {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

let failures = 0;
const fail = (msg) => { failures++; console.log(`   FAIL  ${msg}`); };
const ok = (msg) => { if (VERBOSE) console.log(`   ok    ${msg}`); };

// ---------------------------------------------------------------------------
// Independent frame audit. Deliberately does NOT call physics.js's own
// verifyRecording for the containment part: the point of the test is to check
// the recordings against the pen geometry itself, not against the module's
// opinion of the pen geometry.
// ---------------------------------------------------------------------------
const HW = PEN.w / 2, HD = PEN.d / 2;

function auditFrames(rec, side) {
  const out = { n: 0, penFail: -1, halfFail: -1, unitFail: -1, minX: Infinity, maxAbsX: 0, maxY: -Infinity, closestToMid: Infinity };
  const frames = rec.frames || [];
  out.n = frames.length;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const p = f.p ?? f.p1;
    const q = f.q ?? f.q1;
    if (Math.abs(p[0]) > HW || Math.abs(p[2]) > HD || p[1] < -0.02) { if (out.penFail < 0) out.penFail = i; }
    if (side && (side > 0 ? p[0] < PIG_RADIUS : p[0] > -PIG_RADIUS)) { if (out.halfFail < 0) out.halfFail = i; }
    const ql = Math.hypot(q[0], q[1], q[2], q[3]);
    if (Math.abs(ql - 1) > 1e-6) { if (out.unitFail < 0) out.unitFail = i; }
    out.closestToMid = Math.min(out.closestToMid, Math.abs(p[0]));
    out.maxAbsX = Math.max(out.maxAbsX, Math.abs(p[0]));
    out.maxY = Math.max(out.maxY, p[1]);
  }
  return out;
}

function auditPair(rec) {
  const out = { n: rec.frames.length, penFail: -1, minGap: Infinity };
  for (let i = 0; i < rec.frames.length; i++) {
    const f = rec.frames[i];
    for (const p of [f.p1, f.p2]) {
      if (Math.abs(p[0]) > HW || Math.abs(p[2]) > HD || p[1] < -0.02) { if (out.penFail < 0) out.penFail = i; }
    }
    out.minGap = Math.min(out.minGap, Math.hypot(f.p1[0] - f.p2[0], f.p1[1] - f.p2[1], f.p1[2] - f.p2[2]));
  }
  return out;
}

// ===========================================================================
console.log('='.repeat(78));
console.log('HOG WILD — M1 trajectory search gate');
console.log('='.repeat(78));
console.log(`pen ${PEN.w} x ${PEN.d}   pig bounding radius ${PIG_RADIUS.toFixed(4)}`);
console.log(`halves: a COM may never come within ${LANE.inner.toFixed(3)} of the midline, so two`);
console.log(`        recordings on opposite halves are >= ${(2 * LANE.inner).toFixed(3)} apart — wider than`);
console.log(`        the ${(2 * PIG_RADIUS).toFixed(3)} it would take for the two colliders to touch`);
console.log(`spawn : x ${LANE.spawnLo}..${LANE.spawnHi} from the midline, drifting outward`);
console.log(`budget: maxSims ${MAX_SIMS} per pose, ${OINKER_MAX_SIMS} for the oinker, dt 1/${Math.round(1 / FIXED_DT)}`);
console.log(`conditioned sampling: ${Object.keys(POSE_SAMPLING).join(', ')} (mix ` +
  `${POSE_KEYS.filter((k) => POSE_SAMPLING[k]).map((k) => `${k} ${POSE_SAMPLING[k].mix}`).join(', ')})`);

const sim = new PigSim();

// ===========================================================================
// 1. DETERMINISM
// ===========================================================================
console.log(`\n${'-'.repeat(78)}\n1. DETERMINISM  (abandoned candidates must not leak into later sims)\n${'-'.repeat(78)}`);
{
  const probe = randomToss(mulberry32(777), -1, 'jowler');
  const a = sim.simulateOne(probe, { record: true });
  // now pollute the world the way a search does: dozens of sims, most of them
  // abandoned mid-flight by the lane and attitude early-outs
  const rng = mulberry32(31);
  let aborted = 0;
  for (let i = 0; i < 60; i++) {
    const r = sim.simulateOne(randomToss(rng, 1, 'snouter'), { record: 'buffer', side: 1, target: 'snouter' });
    if (r.rejected) aborted++;
  }
  const b = sim.simulateOne(probe, { record: true });
  const qErr = Math.max(...a.finalQ.map((v, i) => Math.abs(v - b.finalQ[i])));
  const pErr = Math.max(...a.finalP.map((v, i) => Math.abs(v - b.finalP[i])));
  const sameLen = a.frames.length === b.frames.length;
  console.log(`${aborted}/60 intervening sims abandoned early; replay error q ${qErr.toExponential(1)} p ${pErr.toExponential(1)}, ` +
    `frames ${a.frames.length} vs ${b.frames.length}`);
  if (qErr > 0 || pErr > 0 || !sameLen) {
    fail('a stored toss does not replay identically after aborted sims — the §6.3 fallback and the cache cannot be trusted');
  } else ok('bit-identical replay after 60 aborted sims');
}

// ===========================================================================
// 2. PER-POSE SEARCH
// ===========================================================================
console.log(`\n${'-'.repeat(78)}\n2. PER-POSE SEARCH  (seed ${SEED}, both halves, maxSims ${MAX_SIMS})\n${'-'.repeat(78)}`);

const rows = {};
for (const pose of POSE_KEYS) {
  const n = TRIALS * (EXTRA_TRIALS[pose] ?? 1);
  const rng = mulberry32(SEED + pose.length * 17);
  const sims = [], ms = [], rejects = { lane: 0, pen: 0, attitude: 0, pose: 0, unsettled: 0, weak: 0 };
  let confMin = 1, frames = [], closest = Infinity, sideOk = { '-1': 0, 1: 0 };
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1;
    const t0 = performance.now();
    const rec = sim.findRecording(pose, { maxSims: MAX_SIMS, rng, side, minConfidence: MIN_CONFIDENCE });
    const dt = performance.now() - t0;
    if (!rec) { fail(`${pose}: no trajectory found in ${MAX_SIMS} sims (half ${side})`); continue; }
    sims.push(rec.sims); ms.push(dt); frames.push(rec.frames.length);
    for (const k of Object.keys(rejects)) rejects[k] += rec.rejects[k] ?? 0;
    sideOk[side < 0 ? '-1' : 1]++;

    // --- the recording must actually be what the search claims -------------
    if (rec.settledPose !== pose) fail(`${pose}: recording reports settledPose ${rec.settledPose}`);
    if (!rec.settled) fail(`${pose}: recording never settled`);
    if (rec.dt !== FIXED_DT) fail(`${pose}: recording dt ${rec.dt} != ${FIXED_DT}`);
    if (rec.fallbackFrom) fail(`${pose}: search returned a fallback when none was allowed`);

    // independent re-classification of the final frame
    const last = rec.frames[rec.frames.length - 1];
    const c = classify({ x: last.q[0], y: last.q[1], z: last.q[2], w: last.q[3] });
    if (c.pose !== pose) fail(`${pose}: final frame re-classifies as ${c.pose} (${c.contacts.join('+')})`);
    if (c.confidence < MIN_CONFIDENCE) fail(`${pose}: final frame confidence ${c.confidence.toFixed(3)}`);
    confMin = Math.min(confMin, c.confidence);
    // the last frame must agree with the body state the search classified
    const drift = Math.max(...rec.finalQ.map((v, k) => Math.abs(v - last.q[k])));
    if (drift > 1e-12) fail(`${pose}: last frame is not the settled attitude (drift ${drift.toExponential(1)})`);

    // --- containment: EVERY frame, in the pen and in its own half ----------
    const a = auditFrames(rec, side);
    if (a.penFail >= 0) fail(`${pose}: frame ${a.penFail} of ${a.n} is outside the pen`);
    if (a.halfFail >= 0) fail(`${pose}: frame ${a.halfFail} of ${a.n} crossed into the other half`);
    if (a.unitFail >= 0) fail(`${pose}: frame ${a.unitFail} has a non-unit quaternion`);
    closest = Math.min(closest, a.closestToMid);

    // physics.js's own verifier must agree (it also checks the rest sits ON the floor)
    const v = verifyRecording(rec, { side, minConfidence: MIN_CONFIDENCE });
    if (!v.ok) fail(`${pose}: verifyRecording rejected an accepted recording — ${v.why}`);
  }
  rows[pose] = {
    n, sims, ms, rejects, confMin, frames, closest, sideOk,
    avgSims: mean(sims), avgMs: mean(ms), maxMs: Math.max(...ms), p90Ms: quant(ms, 0.9),
  };
  if (sideOk['-1'] === 0 || sideOk[1] === 0) fail(`${pose}: never found on one of the two halves`);
}

console.log('pose         trials  avg sims  max sims   avg ms   p90 ms   max ms   frames  minConf  nearest-mid');
for (const pose of POSE_KEYS) {
  const r = rows[pose];
  console.log(
    '  ' + pose.padEnd(11), String(r.n).padStart(5),
    r.avgSims.toFixed(1).padStart(10), String(Math.max(...r.sims)).padStart(10),
    r.avgMs.toFixed(1).padStart(9), r.p90Ms.toFixed(1).padStart(8), r.maxMs.toFixed(1).padStart(9),
    String(Math.round(mean(r.frames))).padStart(8), r.confMin.toFixed(2).padStart(8),
    r.closest.toFixed(3).padStart(13),
  );
}
console.log('\nwhy candidates were thrown away (share of all sims run, per pose):');
console.log('pose          left half   wrong pose   spent tumble   not settled   weak rest');
for (const pose of POSE_KEYS) {
  const r = rows[pose];
  const total = r.sims.reduce((a, b) => a + b, 0);
  const p = (v) => `${((100 * v) / total).toFixed(1)}%`;
  console.log('  ' + pose.padEnd(11), p(r.rejects.lane + r.rejects.pen).padStart(10),
    p(r.rejects.pose).padStart(12), p(r.rejects.attitude).padStart(15),
    p(r.rejects.unsettled).padStart(14), p(r.rejects.weak).padStart(11));
}
console.log('("spent tumble" = abandoned mid-flight once the tumble was over and the attitude');
console.log(' was nowhere near the target; that early-out is what keeps the rare searches cheap.)');

// ===========================================================================
// 3. MIRROR AUGMENTATION
// ===========================================================================
console.log(`\n${'-'.repeat(78)}\n3. MIRROR AUGMENTATION  (reflect through the pen's long axis)\n${'-'.repeat(78)}`);
console.log('pose          mirror of it   verified   why not');
{
  const rng = mulberry32(SEED + 5);
  for (const pose of POSE_KEYS) {
    const rec = sim.findRecording(pose, { maxSims: MAX_SIMS, rng, side: -1, minConfidence: MIN_CONFIDENCE });
    if (!rec) { fail(`${pose}: no recording to mirror`); continue; }
    const m = mirrorRecording(rec);
    const v = verifyRecording(m, { minConfidence: MIN_CONFIDENCE });
    // the mirror must land in the other half, whatever else is true of it
    if (m.side !== 1) fail(`${pose}: mirrored recording kept side ${m.side}`);
    const a = auditFrames(m, 1);
    if (a.penFail >= 0) fail(`${pose}: mirrored frame ${a.penFail} is outside the pen`);
    if (v.ok && a.halfFail >= 0) fail(`${pose}: mirrored frame ${a.halfFail} crossed into the other half`);
    if (v.ok && m.settledPose !== MIRROR_POSE[pose]) {
      fail(`${pose}: mirror verified but as ${m.settledPose}, not MIRROR_POSE ${MIRROR_POSE[pose]}`);
    }
    console.log('  ' + pose.padEnd(11), (MIRROR_POSE[pose] ?? '-').padEnd(14),
      (v.ok ? 'yes' : 'no').padEnd(10), v.ok ? '' : v.why);
  }
  console.log('\nA failed mirror is not a bug: the collider is chiral (one swept-back ear, leg lean),');
  console.log('so a reflected trajectory is a motion of the pig\'s mirror image. verifyRecording');
  console.log('re-runs the real classifier on it, so only mirrors that are genuine rests of the');
  console.log('real pig ever reach a pool.');
}

// ===========================================================================
// 4. OINKER
// ===========================================================================
console.log(`\n${'-'.repeat(78)}\n4. OINKER  (joint sim, must END in contact at rest; halves do not apply)\n${'-'.repeat(78)}`);
const oink = { sims: [], ms: [] };
{
  const rng = mulberry32(SEED + 9);
  for (let i = 0; i < Math.max(3, Math.round(TRIALS / 2)); i++) {
    const t0 = performance.now();
    const rec = sim.findOinker({ maxSims: OINKER_MAX_SIMS, rng });
    const dt = performance.now() - t0;
    if (!rec) { fail(`oinker: not found in ${OINKER_MAX_SIMS} sims`); continue; }
    oink.sims.push(rec.sims); oink.ms.push(dt);
    if (!rec.touching) fail('oinker: recording is not flagged as ending in contact');
    if (!rec.frames.length) fail('oinker: no frames');
    const f = rec.frames[rec.frames.length - 1];
    if (!('p1' in f) || !('p2' in f)) fail('oinker: PairRecording frames must carry p1/q1/p2/q2');
    const gap = Math.hypot(f.p1[0] - f.p2[0], f.p1[1] - f.p2[1], f.p1[2] - f.p2[2]);
    // touching is a contact-manifold fact; the necessary geometric condition is
    // that the two bounding spheres overlap
    if (gap > 2 * PIG_RADIUS) fail(`oinker: pigs rest ${gap.toFixed(3)} apart, further than 2R ${(2 * PIG_RADIUS).toFixed(3)}`);
    const a = auditPair(rec);
    if (a.penFail >= 0) fail(`oinker: frame ${a.penFail} left the pen`);
    console.log(`  found in ${String(rec.sims).padStart(4)} sims / ${dt.toFixed(0).padStart(4)}ms  ` +
      `(${rec.contacts} of those sims made contact at all)  ${rec.frames.length} frames, ` +
      `resting ${gap.toFixed(3)} apart, poses ${rec.settledPose}/${rec.settledPoseB}`);
  }
  if (oink.sims.length) {
    console.log(`  avg ${mean(oink.sims).toFixed(0)} sims / ${mean(oink.ms).toFixed(0)}ms, worst ` +
      `${Math.max(...oink.sims)} sims / ${Math.max(...oink.ms).toFixed(0)}ms  (budget ${OINKER_MAX_SIMS} sims)`);
    if (Math.max(...oink.sims) > OINKER_MAX_SIMS) fail('oinker: exceeded its sim budget');
  }
}

// ===========================================================================
// 5. TRAJECTORY CACHE
// ===========================================================================
console.log(`\n${'-'.repeat(78)}\n5. TRAJECTORY CACHE  (prefill budget, pools, take)\n${'-'.repeat(78)}`);
{
  let refills = 0;
  const cache = new TrajectoryCache(sim, {
    perPose: 2, rng: mulberry32(SEED + 3), onRefill: () => { refills++; },
  });
  const BUDGET = 120;
  let slices = 0, filled = 0, overrun = 0;
  const t0 = performance.now();
  while (cache.neediest() && slices < 200) {
    const s0 = performance.now();
    filled += cache.prefill(BUDGET);
    const spent = performance.now() - s0;
    // a slice may overrun by at most the single search it was in the middle of
    if (spent > BUDGET * 3 + 60) overrun++;
    slices++;
  }
  const totalMs = performance.now() - t0;
  console.log(`prefill: ${slices} slices of ${BUDGET}ms filled ${filled} recordings in ${totalMs.toFixed(0)}ms ` +
    `(${cache.stats.sims} sims, ${cache.stats.mirrored} of the recordings came free from mirroring)`);
  if (overrun) fail(`${overrun} prefill slice(s) blew well past their ${BUDGET}ms budget`);
  if (cache.neediest()) fail(`prefill never filled every pool (still wanting ${JSON.stringify(cache.neediest())})`);

  console.log('pose         pool L  pool R');
  for (const pose of POSE_KEYS) {
    const l = cache.count(pose, -1), r = cache.count(pose, 1);
    console.log('  ' + pose.padEnd(11), String(l).padStart(5), String(r).padStart(7));
    if (l < 2 || r < 2) fail(`${pose}: pools are ${l}/${r}, SPEC wants >= 2 each`);
  }
  console.log(`  oinker pool ${cache.oinkers.length}`);
  if (!cache.oinkers.length) fail('prefill left the oinker pool empty');

  // take(): must be instant, verified, and must ask for a refill
  refills = 0;
  for (const pose of POSE_KEYS) {
    for (const side of [-1, 1]) {
      const t1 = performance.now();
      const rec = cache.take(pose, side);
      const dt = performance.now() - t1;
      if (!rec) { fail(`take(${pose}, ${side}) returned nothing`); continue; }
      if (rec.settledPose !== pose) fail(`take(${pose}) handed back a ${rec.settledPose}`);
      const v = verifyRecording(rec, { side, minConfidence: MIN_CONFIDENCE });
      if (!v.ok) fail(`take(${pose}, ${side}) handed back an unusable recording — ${v.why}`);
      const a = auditFrames(rec, side);
      if (a.penFail >= 0 || a.halfFail >= 0) fail(`take(${pose}, ${side}): frame left the pen/half`);
      if (dt > 40) fail(`take(${pose}, ${side}) took ${dt.toFixed(0)}ms — a pool hit must be instant`);
      ok(`take(${pose}, ${side}) -> ${rec.mirrored ? 'mirrored ' : ''}recording in ${dt.toFixed(2)}ms`);
    }
  }
  const oinkRec = cache.takeOinker();
  if (!oinkRec?.touching) fail('takeOinker() did not return a contact recording');
  if (refills === 0) fail('take() never asked for a refill — pools would drain to empty');
  console.log(`take: 12 pose recordings + 1 oinker served from the pools, ${refills} refill requests raised`);
  console.log(`stats: ${JSON.stringify(cache.stats)}`);
}

// ===========================================================================
// TIMING TABLE
// ===========================================================================
console.log(`\n${'-'.repeat(78)}\nTIMING  (what the game actually pays; PRD §10 budgets the shake, >=250ms)\n${'-'.repeat(78)}`);
console.log('pose          hit rate    avg sims    avg ms    p90 ms    max ms   worst case');
for (const pose of POSE_KEYS) {
  const r = rows[pose];
  const totalSims = r.sims.reduce((a, b) => a + b, 0);
  console.log(
    '  ' + pose.padEnd(11), `${((100 * r.sims.length) / totalSims).toFixed(2)}%`.padStart(9),
    r.avgSims.toFixed(1).padStart(11), r.avgMs.toFixed(0).padStart(9), r.p90Ms.toFixed(0).padStart(9),
    r.maxMs.toFixed(0).padStart(9), `${Math.max(...r.sims)} sims`.padStart(12),
  );
}
if (oink.sims.length) {
  console.log('  ' + 'oinker'.padEnd(11), ''.padStart(9), mean(oink.sims).toFixed(1).padStart(11),
    mean(oink.ms).toFixed(0).padStart(9), quant(oink.ms, 0.9).toFixed(0).padStart(9),
    Math.max(...oink.ms).toFixed(0).padStart(9), `${Math.max(...oink.sims)} sims`.padStart(12));
}
const jowlerMs = rows.jowler.avgMs;
console.log(`\njowler (the rarest, so the expensive one): ${jowlerMs.toFixed(0)}ms average, budget ${JOWLER_MS_BUDGET}ms`);
if (jowlerMs > JOWLER_MS_BUDGET) fail(`jowler search averages ${jowlerMs.toFixed(0)}ms, over the ${JOWLER_MS_BUDGET}ms budget`);
const slowest = POSE_KEYS.reduce((a, b) => (rows[a].avgMs > rows[b].avgMs ? a : b));
console.log(`slowest pose: ${slowest} at ${rows[slowest].avgMs.toFixed(0)}ms average — the shake covers it,`);
console.log('and the idle prefill means the common case is a pool hit costing nothing at all.');

// ===========================================================================
console.log(`\n${'='.repeat(78)}`);
console.log(`M1 gate: ${failures === 0 ? 'PASS' : `FAIL (${failures} problem${failures === 1 ? '' : 's'})`}` +
  `  — all six poses searchable on both halves, oinker reachable, cache warm`);
console.log('='.repeat(78));
if (process.env.JSON_OUT) {
  const out = { failures, poses: {}, oinker: { avgSims: mean(oink.sims), avgMs: mean(oink.ms) } };
  for (const pose of POSE_KEYS) {
    out.poses[pose] = { avgSims: rows[pose].avgSims, avgMs: rows[pose].avgMs, maxSims: Math.max(...rows[pose].sims) };
  }
  console.log('JSON ' + JSON.stringify(out));
}
process.exit(failures === 0 ? 0 : 1);
