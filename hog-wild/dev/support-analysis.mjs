// Static support-plane analysis of the pig collider.
//
// A rigid body at rest on a flat floor is touching a SUPPORTING PLANE of its
// convex hull. So the complete set of resting configurations can be enumerated
// exactly: brute-force every vertex triple of the collider (~110 verts), keep
// the planes with every other vertex on one side, then ask whether the center
// of mass projects inside the polygon of vertices lying on that plane. No
// sampling, no simulation, no luck — if a pose has no supporting plane here, no
// amount of trajectory search will ever find it (PRD §6.3's hard prerequisite).
//
// Faces are labelled by WHAT TOUCHES rather than by the orientation classifier,
// so the labelling is independent of POSE_UP and can be used to derive it.
//
// Also reports a basin proxy: the solid angle subtended at the COM by the
// contact polygon. That is the standard first-order estimate for how likely a
// tumbling body is to end up on a given face (the die-fairness trick).
//
// Usage: node dev/support-analysis.mjs [-v]
import {
  colliderPointCloud, pigMassProperties, makeParts, PIG_TUNING, POSE_KEYS, POSE_UP,
  classifyUp, poseFromContacts, hull2, originMargin,
} from '../physics.js';

const TOL = 0.004;

function solidAngle(dirs) {
  let total = 0;
  for (let i = 1; i < dirs.length - 1; i++) {
    const a = dirs[0], b = dirs[i], c = dirs[i + 1];
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    const la = Math.hypot(...a), lb = Math.hypot(...b), lc = Math.hypot(...c);
    const ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const ac = a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
    const bc = b[0] * c[0] + b[1] * c[1] + b[2] * c[2];
    total += 2 * Math.abs(Math.atan2(Math.abs(det), la * lb * lc + ab * lc + ac * lb + bc * la));
  }
  return total;
}

/** Physical pose label for a support face — same rules the runtime classifier uses. */
export function labelFace(contacts, up) {
  return poseFromContacts(new Set(contacts), up);
}

export function supportFaces(parts = makeParts(PIG_TUNING), tol = TOL) {
  const cloud = colliderPointCloud(parts);
  const P = cloud.map((c) => c.v);
  const names = cloud.map((c) => c.part);
  const n = P.length;
  const planes = new Map();
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const ax = P[j][0] - P[i][0], ay = P[j][1] - P[i][1], az = P[j][2] - P[i][2];
    const bx = P[k][0] - P[i][0], by = P[k][1] - P[i][1], bz = P[k][2] - P[i][2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-6) continue;
    nx /= l; ny /= l; nz /= l;
    const d = nx * P[i][0] + ny * P[i][1] + nz * P[i][2];
    let mx = -Infinity, mn = Infinity;
    for (let t = 0; t < n; t++) {
      const s = nx * P[t][0] + ny * P[t][1] + nz * P[t][2] - d;
      if (s > mx) mx = s;
      if (s < mn) mn = s;
      if (mx > tol && mn < -tol) break;
    }
    let N, D;
    if (mx <= tol) { N = [nx, ny, nz]; D = d; }
    else if (mn >= -tol) { N = [-nx, -ny, -nz]; D = -d; }
    else continue;
    // cluster near-identical normals (~1.5 deg) so one physical rest counts once
    const key = N.map((v) => Math.round(v * 38)).join(',');
    if (!planes.has(key) || planes.get(key).D < D) planes.set(key, { N, D });
  }

  const out = [];
  for (const { N, D } of planes.values()) {
    const ref = Math.abs(N[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [ref[1] * N[2] - ref[2] * N[1], ref[2] * N[0] - ref[0] * N[2], ref[0] * N[1] - ref[1] * N[0]];
    const ul = Math.hypot(...u); u = u.map((v) => v / ul);
    const v = [N[1] * u[2] - N[2] * u[1], N[2] * u[0] - N[0] * u[2], N[0] * u[1] - N[1] * u[0]];
    const F = [N[0] * D, N[1] * D, N[2] * D];
    const pts = [], cset = new Set();
    for (let t = 0; t < n; t++) {
      if (Math.abs(N[0] * P[t][0] + N[1] * P[t][1] + N[2] * P[t][2] - D) > tol) continue;
      const r = [P[t][0] - F[0], P[t][1] - F[1], P[t][2] - F[2]];
      pts.push([r[0] * u[0] + r[1] * u[1] + r[2] * u[2], r[0] * v[0] + r[1] * v[1] + r[2] * v[2]]);
      cset.add(names[t]);
    }
    const poly = hull2(pts);
    const margin = originMargin(poly);
    if (margin <= 1e-4) continue;
    const dirs = poly.map((p) => [
      F[0] + p[0] * u[0] + p[1] * v[0], F[1] + p[0] * u[1] + p[1] * v[1], F[2] + p[0] * u[2] + p[1] * v[2],
    ]);
    const upBody = [-N[0], -N[1], -N[2]];
    const contacts = [...cset].sort();
    out.push({
      label: labelFace(contacts, upBody), up: upBody, comHeight: D, margin,
      contacts, omega: solidAngle(dirs), tiltDeg: (Math.acos(Math.max(-1, Math.min(1, upBody[1]))) * 180) / Math.PI,
    });
  }
  out.sort((a, b) => b.omega - a.omega);
  return out;
}

/** Aggregate per-pose basin fractions + the basin-weighted mean up vector. */
export function summarize(faces) {
  const tot = faces.reduce((a, f) => a + f.omega, 0) || 1;
  const per = {};
  for (const k of POSE_KEYS) per[k] = { basin: 0, faces: 0, up: [0, 0, 0], bestMargin: 0, maxOmega: 0 };
  let unlabeled = 0, unlabeledFaces = [];
  for (const f of faces) {
    if (!f.label) { unlabeled += f.omega; unlabeledFaces.push(f); continue; }
    const p = per[f.label];
    p.basin += f.omega; p.faces++;
    for (let i = 0; i < 3; i++) p.up[i] += f.up[i] * f.omega;
    p.bestMargin = Math.max(p.bestMargin, f.margin);
    p.maxOmega = Math.max(p.maxOmega, f.omega);
  }
  for (const k of POSE_KEYS) {
    const p = per[k];
    const l = Math.hypot(...p.up) || 1;
    p.up = p.up.map((v) => v / l);
    p.frac = p.basin / tot;
  }
  return { per, tot, unlabeledFrac: unlabeled / tot, unlabeledFaces };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mp = pigMassProperties();
  const faces = supportFaces();
  const { per, tot, unlabeledFrac, unlabeledFaces } = summarize(faces);
  console.log('COM (build frame):', mp.com.map((v) => v.toFixed(4)).join(', '));
  console.log('inertia diagonal :', mp.inertiaDiag.map((v) => v.toFixed(5)).join(', '));
  console.log(`\n${faces.length} static resting equilibria; unlabelled basin ${(100 * unlabeledFrac).toFixed(2)}%\n`);
  console.log('pose         faces  basin%   bestMargin  tilt  mean-up (body frame)          POSE_UP delta');
  for (const k of POSE_KEYS) {
    const p = per[k];
    const dot = p.up[0] * POSE_UP[k][0] + p.up[1] * POSE_UP[k][1] + p.up[2] * POSE_UP[k][2];
    const delta = p.faces ? ((Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI).toFixed(1) + '°' : '--';
    console.log(
      k.padEnd(12), String(p.faces).padStart(5), (100 * p.frac).toFixed(2).padStart(7),
      p.bestMargin.toFixed(4).padStart(12), ' ',
      p.faces ? ((Math.acos(Math.max(-1, Math.min(1, p.up[1]))) * 180 / Math.PI).toFixed(0) + '°').padStart(4) : '  --',
      ' ', p.faces ? p.up.map((v) => v.toFixed(3).padStart(6)).join(',') : '        NONE            ',
      '  ', delta,
    );
  }
  console.log('\nper-face detail:');
  for (const f of faces) {
    const c = classifyUp(f.up);
    console.log(
      ' ', (f.label || '(none)').padEnd(11), 'basin', ((100 * f.omega) / tot).toFixed(2).padStart(6),
      'margin', f.margin.toFixed(4).padStart(7), 'up', f.up.map((v) => v.toFixed(3).padStart(6)).join(','),
      ' classify->', c.pose.padEnd(11), 'conf', c.confidence.toFixed(2), ' ', f.contacts.join('+'),
    );
  }
  if (unlabeledFaces.length) {
    console.log('\nunlabelled rests (these become re-tosses in game):');
    for (const f of unlabeledFaces) console.log('  basin', ((100 * f.omega) / tot).toFixed(2).padStart(6), f.contacts.join('+'), 'up', f.up.map((v) => v.toFixed(2)).join(','));
  }
}
