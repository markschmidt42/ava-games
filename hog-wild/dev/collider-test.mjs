// M0 GATE (PRD §12): prove the pig collider has six genuinely stable resting
// poses, and that real tosses can reach all six.
//
//   node dev/collider-test.mjs [--tosses 4000] [--seed 7] [--verbose]
//
// Three sections:
//   1. STATIC     every pose is a support-plane equilibrium of the collider
//                 (exact enumeration, see dev/support-analysis.mjs)
//   2. STABILITY  place the pig in each pose just above the floor: it must
//                 settle into that pose, be classified as that pose with a
//                 confidence margin, hold for >= 2 simulated seconds, and
//                 survive a nudge (so it is a real basin, not a knife edge)
//   3. REACHABILITY  thousands of randomized tosses; every pose must appear,
//                 and we report which initial conditions produce the rare ones
//                 so the M1 trajectory search knows where to look.
import {
  PigSim, POSE_KEYS, POSE_UP, PEN, GRAVITY, FIXED_DT, MAX_OFF_AXIS_DEG,
  classify, poseQuaternion, pigMassProperties, colliderPointCloud, CONTACT_TOL,
  randomToss, PIG_PARTS, PIG_MASS, MATERIAL_TUNING,
} from '../physics.js';
import { supportFaces, summarize } from './support-analysis.mjs';

// --- args ------------------------------------------------------------------
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const TOSSES = Number(arg('tosses', 4000));
const SEED = Number(arg('seed', 7));
const VERBOSE = process.argv.includes('--verbose');

const MIN_CONFIDENCE = 0.25;   // stability test: unambiguous classification
const HOLD_SECONDS = 2.0;      // must stay put this long
const MAX_DRIFT_DEG = 8;       // orientation drift allowed while holding
const NUDGE = 0.05;            // impulse as a fraction of m*sqrt(2*g*bodyLen)

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pct = (v) => (100 * v).toFixed(v < 0.01 && v > 0 ? 3 : 2);
const bar = (v, max, width = 22) => '#'.repeat(Math.max(v > 0 ? 1 : 0, Math.round((v / max) * width)));
function quatAngleDeg(a, b) {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}

let failures = 0;
const fail = (msg) => { failures++; console.log(`   FAIL  ${msg}`); };
const ok = (msg) => { if (VERBOSE) console.log(`   ok    ${msg}`); };

// ===========================================================================
console.log('='.repeat(78));
console.log('HOG WILD — M0 collider gate');
console.log('='.repeat(78));

const mp = pigMassProperties();
const cloud = colliderPointCloud();
let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (const { v } of cloud) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); }
const dims = hi.map((h, i) => h - lo[i]);

console.log(`\ncollider: ${PIG_PARTS.length} convex parts  (${PIG_PARTS.map((p) => p.name).join(', ')})`);
console.log(`size    : length(Z) ${dims[2].toFixed(3)}  width(X) ${dims[0].toFixed(3)}  height(Y) ${dims[1].toFixed(3)}  world units`);
console.log(`mass    : ${PIG_MASS}  COM in build frame ${mp.com.map((v) => v.toFixed(4)).join(', ')}`);
console.log(`          COM sits ${(-lo[1]).toFixed(3)} above the feet, ${mp.com[2] >= 0 ? '' : '-'}${Math.abs(mp.com[2]).toFixed(3)} ${mp.com[2] >= 0 ? 'ahead of' : 'behind'} mid-body`);
console.log(`inertia : diag ${mp.inertiaDiag.map((v) => v.toFixed(5)).join(', ')}  (analytic, written onto the body —`);
console.log(`          cannon-es would otherwise approximate it with the world AABB)`);
console.log(`world   : gravity ${GRAVITY.toFixed(2)}  dt 1/${Math.round(1 / FIXED_DT)}  pen ${PEN.w}x${PEN.d} wall ${PEN.wallH}`);
console.log(`materials: pig-floor mu=${MATERIAL_TUNING.pigFloor.friction} e=${MATERIAL_TUNING.pigFloor.restitution}` +
  `  pig-wall e=${MATERIAL_TUNING.pigWall.restitution}  pig-pig mu=${MATERIAL_TUNING.pigPig.friction}` +
  `  angDamp=${MATERIAL_TUNING.angularDamping}`);

// ===========================================================================
// 1. STATIC
// ===========================================================================
console.log(`\n${'-'.repeat(78)}\n1. STATIC EQUILIBRIA  (exact support-plane enumeration)\n${'-'.repeat(78)}`);
const faces = supportFaces();
const stat = summarize(faces);
console.log('pose         faces  basin%   bestMargin   settled tilt   COM height');
for (const k of POSE_KEYS) {
  const p = stat.per[k];
  const f = faces.filter((x) => x.label === k).sort((a, b) => b.margin - a.margin)[0];
  console.log(
    '  ' + k.padEnd(11), String(p.faces).padStart(4), pct(p.frac).padStart(8), ' ',
    p.faces ? p.bestMargin.toFixed(4).padStart(10) : '      none', ' ',
    f ? (f.tiltDeg.toFixed(0) + '°').padStart(11) : '          -',
    f ? f.comHeight.toFixed(3).padStart(12) : '           -',
  );
  if (!p.faces) fail(`${k}: no static resting equilibrium exists — the shape cannot hold this pose`);
  else if (p.bestMargin < 0.004) fail(`${k}: support margin ${p.bestMargin.toFixed(4)} is a knife edge`);
  else ok(`${k}: equilibrium with margin ${p.bestMargin.toFixed(4)}`);
}
console.log(`\nrests that are none of the six (become re-tosses in game): ${pct(stat.unlabeledFrac)}% of static basin`);
// (the solid-angle proxy flatters these: most are tall leaning rests that a
// tumbling pig hardly ever ends in. Section 3 measures the real rate.)
if (stat.unlabeledFrac > 0.16) fail(`too much of the orientation space rests in an unscorable pose (${pct(stat.unlabeledFrac)}%)`);

// placement math: poseQuaternion(pose) must rotate the pose's body-frame up
// vector onto world up. (A sign slip here silently places every pose upside
// down, and the sim then "helpfully" settles it into a different pose.)
for (const k of POSE_KEYS) {
  const q = poseQuaternion(k, 0.9);
  const u = POSE_UP[k];
  // rotate u by q
  const t2 = [2 * (q.y * u[2] - q.z * u[1]), 2 * (q.z * u[0] - q.x * u[2]), 2 * (q.x * u[1] - q.y * u[0])];
  const r = [
    u[0] + q.w * t2[0] + (q.y * t2[2] - q.z * t2[1]),
    u[1] + q.w * t2[1] + (q.z * t2[0] - q.x * t2[2]),
    u[2] + q.w * t2[2] + (q.x * t2[1] - q.y * t2[0]),
  ];
  const err = Math.hypot(r[0], r[1] - 1, r[2]);
  if (err > 1e-6) fail(`poseQuaternion('${k}') does not put POSE_UP up: got ${r.map((v) => v.toFixed(4)).join(', ')}`);
  else ok(`poseQuaternion('${k}') aligns POSE_UP with world up`);
}

// classifier separation: the six reference axes must be far enough apart that
// a settled quaternion is never ambiguous
let minSep = 180, minPair = '';
for (let i = 0; i < POSE_KEYS.length; i++) for (let j = i + 1; j < POSE_KEYS.length; j++) {
  const a = POSE_UP[POSE_KEYS[i]], b = POSE_UP[POSE_KEYS[j]];
  const ang = (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
  if (ang < minSep) { minSep = ang; minPair = `${POSE_KEYS[i]}/${POSE_KEYS[j]}`; }
}
console.log(`closest pair of POSE_UP axes: ${minPair} at ${minSep.toFixed(1)}° (classifier tolerance ${MAX_OFF_AXIS_DEG}°)`);
// (the contact set is the decisive signal, so these axes only need to be far
// enough apart to keep the confidence margin and the fallback path meaningful)
if (minSep < 20) fail(`POSE_UP axes ${minPair} only ${minSep.toFixed(1)}° apart — classification would be ambiguous`);

// ===========================================================================
// 2. STABILITY
// ===========================================================================
console.log(`\n${'-'.repeat(78)}\n2. STABILITY  (place in pose, settle, hold ${HOLD_SECONDS}s, then nudge)\n${'-'.repeat(78)}`);
const sim = new PigSim();

// regression guard: cannon-es replaces a body's inertia with a world-AABB box
// approximation on every addShape(). physics.js overwrites it with the analytic
// tensor afterwards; if a future cannon-es upgrade recomputed it mid-step, the
// pig would tumble wrong in a way that is very hard to spot by eye.
sim.simulateOne(randomToss(mulberry32(1), 0), { record: false, maxSeconds: 0.5 });
const liveI = [sim.pigs[0].inertia.x, sim.pigs[0].inertia.y, sim.pigs[0].inertia.z];
const iErr = Math.max(...liveI.map((v, i) => Math.abs(v - mp.inertiaDiag[i])));
if (iErr > 1e-9) {
  fail(`body inertia drifted from the analytic tensor (max error ${iErr.toExponential(2)}): ` +
    `${liveI.map((v) => v.toFixed(5)).join(', ')} vs ${mp.inertiaDiag.map((v) => v.toFixed(5)).join(', ')}`);
} else ok('analytic inertia tensor survives stepping');

const YAWS = [0, 0.7, 2.4, 4.1];
const IMPULSE = NUDGE * PIG_MASS * Math.sqrt(2 * Math.abs(GRAVITY) * 1.0);

console.log('pose         yaws  settles-as    conf   off-axis  drift/2s  support   nudge   rests on');
const stability = {};
for (const pose of POSE_KEYS) {
  let allOk = true, worstConf = 1, worstDrift = 0, worstOff = 0, worstV = 0, nudgeOk = 0;
  let settledAs = new Set(), contacts = new Set(), worstSupport = 9;
  for (const yaw of YAWS) {
    // place hovering just above the floor and let it settle
    sim.place(0, pose, { yaw, gap: 0.004, at: [0, 0] });
    sim.settleInPlace(0, 0.6);
    const qSettled = sim.pigs[0].quaternion.clone();
    const cSettled = classify(qSettled);
    settledAs.add(cSettled.pose);

    // hold: it must still be there HOLD_SECONDS later, barely moving
    const hold = sim.settleInPlace(0, HOLD_SECONDS);
    const drift = quatAngleDeg(qSettled, sim.pigs[0].quaternion);
    const cHold = classify(sim.pigs[0].quaternion);
    worstConf = Math.min(worstConf, cHold.confidence);
    worstDrift = Math.max(worstDrift, drift);
    worstOff = Math.max(worstOff, cHold.offAxisDeg);
    worstV = Math.max(worstV, hold.maxV);
    worstSupport = Math.min(worstSupport, cHold.support);
    for (const c of cHold.contacts) contacts.add(c);
    if (cHold.pose !== pose) { allOk = false; fail(`${pose} (yaw ${yaw}): settled as ${cHold.pose} on ${cHold.contacts.join('+')}`); }
    if (cHold.confidence < MIN_CONFIDENCE) { allOk = false; fail(`${pose} (yaw ${yaw}): confidence ${cHold.confidence.toFixed(2)} < ${MIN_CONFIDENCE}`); }
    if (drift > MAX_DRIFT_DEG) { allOk = false; fail(`${pose} (yaw ${yaw}): drifted ${drift.toFixed(1)}° while resting`); }
    if (hold.maxV > 0.25) { allOk = false; fail(`${pose} (yaw ${yaw}): still moving while "at rest" (peak speed ${hold.maxV.toFixed(3)})`); }

    // nudge: a real basin of attraction survives a small kick
    sim.nudge(0, [Math.cos(yaw * 2.1) * IMPULSE, 0.15 * IMPULSE, Math.sin(yaw * 2.1) * IMPULSE],
      [0.6 * Math.cos(yaw), 0.6, 0.6 * Math.sin(yaw)]);
    sim.settleInPlace(0, 1.6);
    if (classify(sim.pigs[0].quaternion).pose === pose) nudgeOk++;
  }
  stability[pose] = { allOk, worstConf, worstDrift, nudgeOk, contacts: [...contacts].sort() };
  console.log(
    '  ' + pose.padEnd(11), String(YAWS.length).padStart(4), ' ',
    [...settledAs].join('/').padEnd(12), worstConf.toFixed(2).padStart(5),
    (worstOff.toFixed(1) + '°').padStart(9), (worstDrift.toFixed(1) + '°').padStart(9),
    worstSupport.toFixed(4).padStart(8), `   ${nudgeOk}/${YAWS.length}`, ' ', [...contacts].sort().join('+'),
    VERBOSE ? `  peakV ${worstV.toFixed(3)}` : '',
  );
  if (nudgeOk === 0) fail(`${pose}: a small nudge always breaks it — the rest is a knife edge, not a basin`);
}

// ===========================================================================
// 3. REACHABILITY
// ===========================================================================
console.log(`\n${'-'.repeat(78)}\n3. REACHABILITY  (${TOSSES} randomized tosses, seed ${SEED})\n${'-'.repeat(78)}`);

// Approach B needs the search to be reproducible: the same initial conditions
// must give the same tumble even in a world that has already simulated other
// tosses, otherwise a cached recording could disagree with what was searched.
{
  const probe = randomToss(mulberry32(4242), 0);
  const a = new PigSim().simulateOne(probe, { record: false });
  const dirty = new PigSim();
  for (let i = 0; i < 12; i++) dirty.simulateOne(randomToss(mulberry32(i + 1), 0), { record: false });
  const b = dirty.simulateOne(probe, { record: false });
  const identical = a.finalQ.every((v, i) => Math.abs(v - b.finalQ[i]) < 1e-12) && a.settleSeconds === b.settleSeconds;
  console.log(`determinism: same toss in a fresh vs already-used world -> ${identical ? 'bit-identical' : 'DIVERGED'}`);
  if (!identical) fail('simulation is not reproducible across reused worlds; the trajectory cache cannot be trusted');
}

const rng = mulberry32(SEED);
const tally = {}; for (const k of POSE_KEYS) tally[k] = 0;
const icStats = {};
for (const k of POSE_KEYS) icStats[k] = [];
const allStats = [];
let lowConf = 0, unsettled = 0, settleTimes = [];
const ambiguous = new Map();
const finalQs = [];
let ambiguousOnWall = 0;
const t0 = Date.now();
for (let i = 0; i < TOSSES; i++) {
  const ic = randomToss(rng, 0);
  const rec = sim.simulateOne(ic, { record: false });
  finalQs.push(rec.finalQ);
  if (rec.confidence < 0.15) {
    const c = classify(sim.pigs[0].quaternion);
    ambiguous.set(c.contacts.join('+'), (ambiguous.get(c.contacts.join('+')) || 0) + 1);
    const p = sim.pigs[0].position;
    if (Math.abs(p.x) > PEN.w / 2 - 0.75 || Math.abs(p.z) > PEN.d / 2 - 0.75) ambiguousOnWall++;
  }
  const spin = Math.hypot(ic.w[0], ic.w[1], ic.w[2]);
  const feat = {
    spin, speed: Math.hypot(ic.v[0], ic.v[1], ic.v[2]), height: ic.p[1],
    axZ: (ic.w[2] * ic.w[2]) / (spin * spin || 1),
    axY: (ic.w[1] * ic.w[1]) / (spin * spin || 1),
    axX: (ic.w[0] * ic.w[0]) / (spin * spin || 1),
  };
  allStats.push(feat);
  if (!rec.settled) unsettled++;
  else settleTimes.push(rec.settleSeconds);
  if (rec.confidence < 0.15) { lowConf++; continue; }
  tally[rec.settledPose]++;
  icStats[rec.settledPose].push(feat);
}
const elapsed = (Date.now() - t0) / 1000;
const scored = TOSSES - lowConf;
settleTimes.sort((a, b) => a - b);

console.log(`${TOSSES} tosses in ${elapsed.toFixed(1)}s (${(1000 * elapsed / TOSSES).toFixed(1)}ms each).` +
  `  settle time median ${settleTimes[Math.floor(settleTimes.length / 2)]?.toFixed(2)}s, p95 ${settleTimes[Math.floor(settleTimes.length * 0.95)]?.toFixed(2)}s`);
console.log(`unsettled after 5s: ${pct(unsettled / TOSSES)}%   ambiguous rest (re-toss): ${pct(lowConf / TOSSES)}%\n`);

if (lowConf / TOSSES > 0.12) fail(`${pct(lowConf / TOSSES)}% of tosses end in an unscorable rest — too many re-tosses`);

const TARGET = { 'side-blank': 34.9, 'side-dot': 30.2, razorback: 22.4, trotter: 8.8, snouter: 3.0, jowler: 0.6 };
const maxFrac = Math.max(...POSE_KEYS.map((k) => tally[k] / scored));
console.log('pose            n   emergent%   real game%   distribution');
for (const k of POSE_KEYS) {
  const f = tally[k] / scored;
  console.log(
    '  ' + k.padEnd(11), String(tally[k]).padStart(5), pct(f).padStart(10),
    TARGET[k].toFixed(1).padStart(12), '  ', bar(f, maxFrac),
  );
  if (tally[k] === 0) fail(`${k}: never reached in ${TOSSES} tosses — the trajectory search would never find it`);
}
console.log('  ' + 'ambiguous'.padEnd(11), String(lowConf).padStart(5), pct(lowConf / TOSSES).padStart(10),
  '            (re-tossed in game; the trajectory search discards these)');
console.log('\nThe emergent column does NOT have to match the real game: under approach B (PRD §6.3)');
console.log('the outcome is drawn from odds.js and then a matching real trajectory is searched for.');
console.log('What matters here is that every pose is REACHABLE and that the rarity ordering is sane,');
console.log('so the search never has to work absurdly hard for one particular result.');
if (ambiguous.size) {
  console.log(`\nwhat the ambiguous rests are resting on ` +
    `(${pct(ambiguousOnWall / Math.max(1, lowConf))}% of them are propped against a pen wall):`);
  for (const [k, n] of [...ambiguous.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`  ${pct(n / TOSSES).padStart(6)}%  ${k}`);
  }
}

// robustness: the contact test needs a tolerance for "touching the floor".
// Re-score every settled attitude at 0.6x and 1.4x that tolerance — if the
// tally moved much, the classification would be a coin flip on the delicate
// poses (the jowler's head clears the floor by only ~0.015).
{
  const tols = [CONTACT_TOL * 0.6, CONTACT_TOL, CONTACT_TOL * 1.4];
  const rows = tols.map((tol) => {
    const t = {}; for (const k of POSE_KEYS) t[k] = 0;
    let amb = 0;
    for (const q of finalQs) {
      const c = classify({ x: q[0], y: q[1], z: q[2], w: q[3] }, { tol });
      if (c.confidence < 0.15) amb++; else t[c.pose]++;
    }
    return { tol, t, amb };
  });
  console.log(`\ncontact-tolerance sensitivity (${tols.map((t) => t.toFixed(4)).join(' / ')}):`);
  for (const k of POSE_KEYS) {
    const vals = rows.map((r) => (100 * r.t[k]) / TOSSES);
    const spread = Math.max(...vals) - Math.min(...vals);
    console.log('  ' + k.padEnd(11), vals.map((v) => v.toFixed(2).padStart(6)).join(' '), ` spread ${spread.toFixed(2)}pp`);
    if (Math.min(...vals) === 0 && Math.max(...vals) > 0) {
      fail(`${k} disappears at one end of the contact tolerance — classification is knife-edge`);
    }
  }
  console.log('  ' + 'ambiguous'.padEnd(11), rows.map((r) => ((100 * r.amb) / TOSSES).toFixed(2).padStart(6)).join(' '));
}

// which initial conditions produce which pose
const mean = (arr, f) => (arr.length ? arr.reduce((a, b) => a + f(b), 0) / arr.length : NaN);
const base = { spin: mean(allStats, (s) => s.spin), speed: mean(allStats, (s) => s.speed), height: mean(allStats, (s) => s.height), axZ: mean(allStats, (s) => s.axZ) };
console.log(`\ninitial conditions by outcome (population means: spin ${base.spin.toFixed(1)} rad/s,` +
  ` speed ${base.speed.toFixed(2)}, height ${base.height.toFixed(2)}, spin-about-Z ${(100 * base.axZ).toFixed(0)}%)`);
console.log('pose          spin   vs pop   speed   vs pop   height   spin axis X/Y/Z');
for (const k of POSE_KEYS) {
  const a = icStats[k];
  if (!a.length) { console.log('  ' + k.padEnd(11), '   (never reached)'); continue; }
  const sp = mean(a, (s) => s.spin), sv = mean(a, (s) => s.speed), h = mean(a, (s) => s.height);
  console.log(
    '  ' + k.padEnd(11), sp.toFixed(1).padStart(5), ((sp / base.spin - 1) * 100).toFixed(0).padStart(7) + '%',
    sv.toFixed(2).padStart(7), ((sv / base.speed - 1) * 100).toFixed(0).padStart(7) + '%', h.toFixed(2).padStart(8), '  ',
    [mean(a, (s) => s.axX), mean(a, (s) => s.axY), mean(a, (s) => s.axZ)].map((v) => (100 * v).toFixed(0).padStart(3)).join('/'),
  );
}

// What the M1 trajectory search will actually cost per pose. randomToss(bias)
// exists so the search can hint at a target, but see the note in physics.js:
// measurement says the launch conditions barely predict the outcome, so this is
// brute force and the cost is simply 1/rate sims.
console.log('\nsearch cost per pose (targeted tosses, so this is the M1 budget):');
console.log('pose          hits        rate    sims per hit   ms per hit');
const hitRates = {};
const msPerSim = (1000 * elapsed) / TOSSES;
for (const k of POSE_KEYS) {
  const r2 = mulberry32(SEED + 101);
  let hits = 0; const n = Math.min(1200, Math.max(500, Math.round(TOSSES / 4)));
  for (let i = 0; i < n; i++) {
    const rec = sim.simulateOne(randomToss(r2, 0, k), { record: false });
    if (rec.settledPose === k && rec.confidence >= 0.15) hits++;
  }
  const rate = hits / n;
  hitRates[k] = rate;
  console.log('  ' + k.padEnd(11), `${hits}/${n}`.padStart(9), pct(rate).padStart(9) + '%',
    (rate > 0 ? `~${Math.ceil(1 / rate)}` : '     never').padStart(14),
    (rate > 0 ? `~${Math.round(msPerSim / rate)}ms` : '  -').padStart(12));
  if (hits === 0) fail(`targeted tosses never produced ${k}; the trajectory search has no viable strategy`);
}
console.log('(PRD §10 budgets the search across the shake, which lasts >=250ms and usually ~1s,');
console.log(' plus the idle prefill — so a pose costing a few hundred ms of search is still hidden.)');

// ===========================================================================
console.log(`\n${'='.repeat(78)}`);
const allSix = POSE_KEYS.every((k) => stability[k].allOk && tally[k] > 0);
console.log(`M0 gate: ${failures === 0 ? 'PASS' : `FAIL (${failures} problem${failures === 1 ? '' : 's'})`}` +
  `  — six stable poses: ${allSix ? 'yes' : 'no'}`);
console.log('='.repeat(78));
if (process.env.JSON_OUT) {
  const out = { emergent: {}, stability: {}, hitRates, failures };
  for (const k of POSE_KEYS) {
    out.emergent[k] = Number(pct(tally[k] / scored));
    out.stability[k] = stability[k];
  }
  console.log('JSON ' + JSON.stringify(out));
}
process.exit(failures === 0 ? 0 : 1);
