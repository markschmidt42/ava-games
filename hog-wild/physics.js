// physics.js — cannon-es world, pig compound collider, headless sim, pose
// classification, trajectory recording/search/cache.
//
// See SPEC.md (module contracts) and PRD.md §6.
//
// COORDINATE / AXIS CONTRACT (pig.js must match exactly):
//   +Y  = up when the pig is trotting (standing on all fours)
//   +Z  = snout direction (the pig faces +Z)
//   +X  = the BLANK flank: the jowler ear's side, and the side the legs lean
//         toward (SPEC "Geometry realism" — that lean is the side-bias mechanism)
//   the painted DOT belongs on the -X flank (see POSE_UP notes below)
//   origin = the collider's center of mass
//
// Import style: relative path so the same module loads in the browser (via the
// index.html importmap for "three") and in node dev scripts with no build step.
import * as CANNON from './vendor/cannon-es.js';

// ---------------------------------------------------------------------------
// Board (SPEC.md "Board design") — a putting green, NOT a walled pen.
// ---------------------------------------------------------------------------
// Walls were the problem: a pig that stops leaning on one is resting in none of
// the six named poses, so it had to be re-tossed (they were more than half of
// all ambiguous rests). A no-walls board with concentric deadening zones cannot
// produce that rest at all, and it is what the owner's `_watch/arena.html`
// prototype settled on. Floor plane at y = 0, board centred on the origin.
//
//   green  r <= greenR   hard and lively — the pig-floor material, untouched
//   rough  r <= roughR   "frog fur": velocity * roughDamp each grounded step,
//                        upward rebound squashed to roughBounce
//   fringe r <= stopR    motion just dies: stopDamp / stopBounce
//   beyond              a radial position clamp, so nothing can ever escape;
//                       it sits well outside stopR and should never fire
export const BOARD = {
  greenR: 2.7, roughR: 3.9, stopR: 4.6,
  roughDamp: 0.965, stopDamp: 0.85,     // velocity multiplier per grounded step
  roughBounce: 0.45, stopBounce: 0.15,  // upward-velocity multiplier on rebound
  spinDamp: 0.98,                       // extra factor on angular velocity
  groundedY: 0.6,                       // above this the pig is airborne: zones let go
  backstop: 0.8,                        // hard clamp radius = stopR + this
};

export const GRAVITY = -9.82 * 2.2; // toy-scale objects read better heavy
export const FIXED_DT = 1 / 120;

export const POSE_KEYS = ['side-blank', 'side-dot', 'razorback', 'trotter', 'snouter', 'jowler'];

// ---------------------------------------------------------------------------
// Collider geometry
// ---------------------------------------------------------------------------
// Compound of boxes + one cylinder (the snout). Deliberately NOT a convex hull:
// hulling a pig fills the space between the legs and under the snout and kills
// Snouter / Leaning Jowler (PRD §6.4).
//
// Coordinates below are the BUILD frame: y = 0 is the floor when the pig
// trots, z = 0 is mid-body. buildPigBody() re-centers everything on the
// computed center of mass, so the finished body's origin IS the COM.
//
// `density` is a per-shape density multiplier — this is how mass distribution
// is tuned (cannon-es has no per-shape mass; it assumes COM == body origin, so
// the COM is expressed by *where the origin sits*, and the inertia tensor is
// computed analytically below and written straight onto the body).
//
// What each pose actually rests on, as measured by dev/collider-test.mjs —
// this is also exactly what poseFromContacts() keys off (percentages are the
// emergent rate over uniform tosses after the realism pass; the real game's
// numbers are in brackets, and we are close on every one of them):
//   side-blank   -X flank + that ear + a hind foot    36.9%  [34.9]  commonest
//   side-dot     +X flank + that ear + a fore foot    28.5%  [30.2]
//   razorback    the narrow spine ridge on the back   23.7%  [22.4]  common
//   trotter      all four splayed feet                 8.3%  [ 8.8]  uncommon
//   snouter      snout rim + the two front feet        2.5%  [ 3.0]  rare
//   jowler       snout rim + ear tip + one fore foot   0.16% [ 0.7]  rarest
// side-dot is the rarer Sider because it is the rest ON the blank flank, and the
// legs lean that way — see legLeanX in PIG_TUNING.
const D2R = Math.PI / 180;

// How these numbers were arrived at, and how to change them safely:
//   1. dev/support-analysis.mjs enumerates the collider's resting equilibria
//      exactly, so it says instantly whether a pose is even possible.
//   2. dev/collider-test.mjs measures what thousands of real tosses actually do.
//      That is the number that matters; the static basin estimate flatters tall
//      leaning rests badly.
//   3. after ANY edit here, re-run `node dev/derive-poseup.mjs` and paste the
//      POSE_UP block back in — the settled attitudes move with the geometry.
export const PIG_TUNING = {
  // torso (flat flanks -> the two Side poses)
  torsoHX: 0.17, torsoHY: 0.2, torsoHZ: 0.28, torsoY: 0.376, torsoZ: -0.13, torsoD: 1,
  // spine ridge (razorback rests on this narrow strip)
  ridgeHX: 0.0428, ridgeHY: 0.0276, ridgeHZ: 0.235, ridgeZ: -0.15, ridgeD: 0.75,
  // The head is deliberately narrower than the torso by ~0.03: in the jowler
  // rest the head must clear the floor by more than CONTACT_TOL, otherwise the
  // pig is technically resting on its cheek and the contact test (correctly)
  // calls it a Sider instead. dev/collider-test.mjs reports that clearance.
  headHX: 0.131, headHY: 0.1534, headHZ: 0.115, headY: 0.36, headZ: 0.245, headD: 1.25,
  // snout (its lower front rim is the snouter/jowler contact)
  snoutR: 0.115, snoutH: 0.15, snoutY: 0.33, snoutZ: 0.415, snoutTilt: 16, snoutD: 1.5,
  // The ear on +X — a paddle set FORWARD on the cheek (earZ sits in the front
  // half of the head's z span) that flares outward and DROOPS (earRoll < 0),
  // like the reference photos. It is the kickstand that makes jowler exist, and
  // where its tip sits is what sets the jowler's ATTITUDE: the jowler support
  // plane runs through the snout rim, the +X front foot and this ear's outer
  // tip, so the rest's roll — asin(|up.x|) — is asin(d / R), where d is the ear
  // tip's height above the SNOUTER support plane and R its distance from the
  // snout-to-front-foot pivot line. The old ear (earY .463, earZ .10, swept back
  // 45°) sat almost directly above the front foot: d/R ≈ .91, a 66° roll, i.e.
  // the pig lying on its side. Dropping the tip onto the cheek — d small, R
  // about the same — is what turns the jowler into the Snouter-with-a-lean the
  // scoring card shows (SPEC "Jowler attitude": 25–40°, asserted <= 45 in
  // dev/collider-test.mjs). MEASURED: roll 37.0°, support margin .043.
  earHX: 0.138, earHY: 0.04, earHZ: 0.073, earX: 0.193, earY: 0.397, earZ: 0.258,
  earSweep: 1, earRoll: -42.7, earD: 0.6,
  // The OTHER ear (-X) is the same paddle at the same place, at the same droop,
  // so it props that flank by the same amount and the two Side rests stay
  // comparably likely — the sides are split by the LEGS, not by the ears. Only
  // its SWEEP differs (~27° further forward), which lifts its tip off the
  // mirror-image jowler support plane and so leaves the pig with exactly one
  // jowler equilibrium; a mirrored jowler would be a seventh resting pose the
  // classifier could not name. MEASURED: no -X lean equilibrium exists for
  // ear2Sweep in [-40, -25] (checked by enumerating the mirror pig's support
  // faces), and the -X lean is a tiny .004 even at the edge of that window.
  ear2HX: 0.138, ear2X: 0.193, ear2Y: 0.397, ear2Z: 0.258, ear2Sweep: -25.6,
  legHX: 0.052, legHY: 0.0943, legHZ: 0.058, legX: 0.16, legZF: 0.115, legZB: -0.29,
  legSplay: 13, legD: 0.6925,
  // LEG ASYMMETRY (SPEC "Geometry realism") — the real side-bias mechanism, and
  // the only thing in here that is deliberately NOT mirror-symmetric about x=0.
  // On the real pig the legs sit toward, and lean toward, the BLANK flank (+X:
  // the dot is painted on -X). Resting on the blank flank therefore lands on
  // legs that stick out further, which props the body up off its own flank and
  // makes that rest tippy — so "dot up" (which IS the blank-flank rest) is the
  // rarer Sider, 30.2% vs 34.9% in the real game. legLeanX shifts all four legs
  // toward +X; legLeanSplay adds the same extra lean angle to all four, so the
  // +X pair splays wider and the -X pair tucks under. Set both to 0 and the
  // emergent side split collapses toward even — that is the check SPEC asks
  // for, and it is what proves the ears are no longer the bias source.
  legLeanX: 0.019, legLeanSplay: 5,
  // low curly tail: a tail up at spine height gives the pig a stable "sitting
  // on its rump" rest, which is none of the six poses
  tailHX: 0.032, tailHY: 0.032, tailHZ: 0.05, tailY: 0.3, tailZ: -0.47, tailD: 0.225,
};

/** Compound part list from a flat tuning vector. Build frame: y=0 = floor when trotting. */
export function makeParts(t = PIG_TUNING) {
  // legLeanX / legLeanSplay are applied with the SAME sign to all four legs, so
  // they shift and tilt the whole undercarriage toward the blank (+X) flank
  // instead of splaying it symmetrically. See the note in PIG_TUNING.
  const leg = (name, sx, z) => ({
    name, kind: 'box', he: [t.legHX, t.legHY, t.legHZ],
    pos: [sx * t.legX + (t.legLeanX ?? 0), t.legHY, z],
    rot: [0, 0, sx * t.legSplay + (t.legLeanSplay ?? 0)], density: t.legD,
  });
  return [
    { name: 'torso', kind: 'box', he: [t.torsoHX, t.torsoHY, t.torsoHZ], pos: [0, t.torsoY, t.torsoZ], rot: [0, 0, 0], density: t.torsoD },
    { name: 'ridge', kind: 'box', he: [t.ridgeHX, t.ridgeHY, t.ridgeHZ], pos: [0, t.torsoY + t.torsoHY + t.ridgeHY, t.ridgeZ], rot: [0, 0, 0], density: t.ridgeD },
    { name: 'head', kind: 'box', he: [t.headHX, t.headHY, t.headHZ], pos: [0, t.headY, t.headZ], rot: [0, 0, 0], density: t.headD },
    { name: 'snout', kind: 'cyl', r: t.snoutR, h: t.snoutH, seg: 10, pos: [0, t.snoutY, t.snoutZ], rot: [90 - t.snoutTilt, 0, 0], density: t.snoutD },
    { name: 'ear', kind: 'box', he: [t.earHX, t.earHY, t.earHZ], pos: [t.earX, t.earY, t.earZ], rot: [0, t.earSweep, t.earRoll], density: t.earD },
    { name: 'ear2', kind: 'box', he: [t.ear2HX, t.earHY, t.earHZ], pos: [-t.ear2X, t.ear2Y, t.ear2Z], rot: [0, -t.ear2Sweep, -t.earRoll], density: t.earD },
    leg('legFL', 1, t.legZF), leg('legFR', -1, t.legZF), leg('legBL', 1, t.legZB), leg('legBR', -1, t.legZB),
    { name: 'tail', kind: 'box', he: [t.tailHX, t.tailHY, t.tailHZ], pos: [0, t.tailY, t.tailZ], rot: [0, 0, 0], density: t.tailD },
  ];
}

export const PIG_PARTS = makeParts(PIG_TUNING);

export const PIG_MASS = 1.0;

// --- tiny linear algebra helpers (3x3, row-major arrays of 9) ---------------
function quatFromEulerDeg([rx, ry, rz]) {
  const q = new CANNON.Quaternion();
  q.setFromEuler(rx * D2R, ry * D2R, rz * D2R, 'XYZ');
  return q;
}
function mat3FromQuat(q) {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  ];
}
function m3mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o;
}
function m3transpose(a) {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

function partVolume(p) {
  if (p.kind === 'box') return 8 * p.he[0] * p.he[1] * p.he[2];
  // regular n-gon prism (cannon Cylinder is an n-gon prism, axis = local Y)
  const n = p.seg;
  const area = 0.5 * n * p.r * p.r * Math.sin((2 * Math.PI) / n);
  return area * p.h;
}
// diagonal local inertia (per unit mass) in the part's own axes
function partInertiaPerMass(p) {
  if (p.kind === 'box') {
    const [a, b, c] = p.he.map((v) => 2 * v);
    return [(b * b + c * c) / 12, (a * a + c * c) / 12, (a * a + b * b) / 12];
  }
  // n-gon prism approximated as a cylinder of equal area radius; axis = Y
  const n = p.seg;
  const area = 0.5 * n * p.r * p.r * Math.sin((2 * Math.PI) / n);
  const re = Math.sqrt(area / Math.PI);
  const iy = (re * re) / 2;
  const ix = (3 * re * re + p.h * p.h) / 12;
  return [ix, iy, ix];
}

/** Mass properties of the compound, in the BUILD frame. */
export function pigMassProperties(parts = PIG_PARTS, totalMass = PIG_MASS) {
  const w = parts.map((p) => partVolume(p) * p.density);
  const wSum = w.reduce((a, b) => a + b, 0);
  const masses = w.map((v) => (v / wSum) * totalMass);
  const com = [0, 0, 0];
  parts.forEach((p, i) => { for (let k = 0; k < 3; k++) com[k] += masses[i] * p.pos[k]; });
  for (let k = 0; k < 3; k++) com[k] /= totalMass;

  // full inertia tensor about the COM, then keep the diagonal (cannon-es only
  // supports a diagonal inertia vector)
  const I = new Array(9).fill(0);
  parts.forEach((p, i) => {
    const m = masses[i];
    const d = partInertiaPerMass(p).map((v) => v * m);
    const R = mat3FromQuat(quatFromEulerDeg(p.rot));
    const Il = [d[0], 0, 0, 0, d[1], 0, 0, 0, d[2]];
    const Iw = m3mul(m3mul(R, Il), m3transpose(R));
    const r = [p.pos[0] - com[0], p.pos[1] - com[1], p.pos[2] - com[2]];
    const rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      I[a * 3 + b] += Iw[a * 3 + b] + m * ((a === b ? rr : 0) - r[a] * r[b]);
    }
  });
  return { masses, com, inertiaDiag: [I[0], I[4], I[8]], tensor: I };
}

/** Local vertices of one part, expressed in COM-centered pig space. */
function partVertices(p, com) {
  const R = mat3FromQuat(quatFromEulerDeg(p.rot));
  let local;
  if (p.kind === 'box') {
    local = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      local.push([sx * p.he[0], sy * p.he[1], sz * p.he[2]]);
    }
  } else {
    local = [];
    for (let i = 0; i < p.seg; i++) {
      const t = (2 * Math.PI * i) / p.seg;
      const x = -p.r * Math.sin(t), z = p.r * Math.cos(t);
      local.push([x, -p.h / 2, z], [x, p.h / 2, z]);
    }
  }
  return local.map((v) => [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2] + p.pos[0] - com[0],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2] + p.pos[1] - com[1],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2] + p.pos[2] - com[2],
  ]);
}

/**
 * Every collider vertex in COM-centered pig space, tagged with the part it
 * came from. Used by classification-independent tooling: drop heights,
 * support-polygon / static-equilibrium analysis, and the dev collider lab.
 */
export function colliderPointCloud(parts = PIG_PARTS, totalMass = PIG_MASS) {
  const { com } = pigMassProperties(parts, totalMass);
  const pts = [];
  for (const p of parts) for (const v of partVertices(p, com)) pts.push({ part: p.name, v });
  return pts;
}

/** Lowest collider point (and which part owns it) for a given orientation. */
export function lowestPoint(q, cloud = CLOUD) {
  const m = mat3FromQuat(q);
  let best = Infinity, part = null;
  for (const { v, part: pn } of cloud) {
    const y = m[3] * v[0] + m[4] * v[1] + m[5] * v[2];
    if (y < best) { best = y; part = pn; }
  }
  return { y: best, part };
}

// ---------------------------------------------------------------------------
// Pose classification (PRD §6.5)
// ---------------------------------------------------------------------------
// POSE_UP[pose] is the pig-local direction that points at world-up when the pig
// is settled in that pose. Classification takes world-up into the body frame
// and picks the nearest of these by dot product.
//
// side-blank rests on the -X flank, so the +X (big-ear) flank faces up;
// side-dot rests on the +X flank. PIG.JS: paint the dot on the -X flank.
// Both side rests lean a little because an ear is trapped underneath — that is
// deliberate, and it is why neither Side vector is exactly +/-X.
//
// These are the MEASURED settled attitudes of this collider, read off the
// support-plane analysis (dev/support-analysis.mjs): the snouter pitches ~36°
// nose-down, and the jowler is that same nose-down prop rolled 37° onto one ear
// — a Snouter with a lean, exactly like the photo on the real scoring card.
// dev/collider-test.mjs asserts that simulated rests agree with these, and that
// the jowler's roll stays under 45°, so neither can silently drift.
// Regenerate with: node dev/derive-poseup.mjs  (required after any
// PIG_TUNING change — a stale table places poses off their own equilibrium).
export const POSE_UP = {
  'side-blank': norm3([0.97, -0.035, 0.239]),
  'side-dot': norm3([-0.972, -0.132, 0.192]),
  // razorback and trotter keep their exact axes: both have a symmetric family
  // of leaning variants either side, so the middle is the right reference
  razorback: norm3([0, -1, 0]),
  trotter: norm3([0, 1, 0]),
  snouter: norm3([0.016, 0.812, -0.583]),
  jowler: norm3([-0.601, 0.454, -0.658]),
};

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Widest off-axis tilt still accepted as a pose; beyond this, re-toss. */
export const MAX_OFF_AXIS_DEG = 45;
/** How close to the lowest point a vertex counts as touching the floor. */
export const CONTACT_TOL = 0.012;
/** Support-polygon margin that counts as a fully settled, unambiguous rest. */
export const FULL_SUPPORT_MARGIN = 0.02;

/**
 * classifyUp(u) — u is world-up expressed in the pig's body frame.
 * confidence is 0..1: it is both a margin over the runner-up pose AND a
 * penalty for being far off the pose's nominal axis, so a pig balanced on an
 * edge or leaning on a wall scores near 0 and the game can re-toss (PRD §6.5).
 */
export function classifyUp(u) {
  const l = Math.hypot(u[0], u[1], u[2]) || 1;
  const ux = u[0] / l, uy = u[1] / l, uz = u[2] / l;
  let bestPose = null, bestAng = Infinity, secondAng = Infinity;
  for (const key of POSE_KEYS) {
    const r = POSE_UP[key];
    const ang = Math.acos(Math.max(-1, Math.min(1, ux * r[0] + uy * r[1] + uz * r[2])));
    if (ang < bestAng) { secondAng = bestAng; bestAng = ang; bestPose = key; }
    else if (ang < secondAng) secondAng = ang;
  }
  const margin = (secondAng - bestAng) / (secondAng + bestAng);
  const align = 1 - (bestAng / D2R) / MAX_OFF_AXIS_DEG;
  return {
    pose: bestPose, up: [ux, uy, uz], offAxisDeg: bestAng / D2R,
    confidence: Math.max(0, Math.min(margin, align)),
  };
}

/** world up expressed in the body frame: R^T * (0,1,0) */
export function bodyUp(q) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  return [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)];
}

// --- 2D hull helpers (shared with dev/support-analysis.mjs) -----------------
export function hull2(pts) {
  if (pts.length < 3) return pts.slice();
  const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of s) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 1e-12) lower.pop(); lower.push(p); }
  for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 1e-12) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}
/** Signed distance from the origin to the polygon boundary (positive = inside). */
export function originMargin(poly) {
  if (poly.length < 3) return -1;
  let minD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const d = (ex * (0 - a[1]) - ey * (0 - a[0])) / (Math.hypot(ex, ey) || 1e-9);
    if (d < minD) minD = d;
  }
  return minD;
}

/**
 * What the pig is standing on at a given attitude: the collider vertices at
 * (or within CONTACT_TOL of) the lowest point, plus how far inside their
 * support polygon the center of mass projects.
 */
export function contactSet(q, tol = CONTACT_TOL, cloud = CLOUD) {
  const m = mat3FromQuat(q);
  const ys = new Array(cloud.length);
  let ymin = Infinity;
  for (let i = 0; i < cloud.length; i++) {
    const v = cloud[i].v;
    const y = m[3] * v[0] + m[4] * v[1] + m[5] * v[2];
    ys[i] = y;
    if (y < ymin) ymin = y;
  }
  const parts = new Set(), pts = [];
  for (let i = 0; i < cloud.length; i++) {
    if (ys[i] > ymin + tol) continue;
    const v = cloud[i].v;
    parts.add(cloud[i].part);
    pts.push([
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ]);
  }
  return { parts, margin: originMargin(hull2(pts)), comHeight: -ymin };
}

const FRONT_LEGS = ['legFL', 'legFR'];
const ALL_LEGS = ['legFL', 'legFR', 'legBL', 'legBR'];

/**
 * The physical pose test: which pose is the pig in, judged by WHAT IS TOUCHING
 * the floor rather than by attitude alone. This is what separates a Leaning
 * Jowler (propped on snout + ear, torso in the air) from a pig lying flat on
 * its side with its nose tipped down — two rests barely 25° apart in attitude
 * but completely different scores.
 */
export function poseFromContacts(parts, up) {
  const has = (n) => parts.has(n);
  const legs = ALL_LEGS.filter(has).length;
  const front = FRONT_LEGS.filter(has).length;
  const side = () => (up[0] > 0 ? 'side-blank' : 'side-dot');
  if (has('snout') && !has('torso') && !has('ridge')) {
    // nose is on the floor and the body is not. If a cheek is down too, the pig
    // is really lying on its side with its nose tipped down — a Sider, not a
    // Jowler. A Jowler is propped: snout + ear tip (+ a front foot), head clear.
    if (has('head')) return Math.abs(up[0]) > 0.5 ? side() : null;
    if (has('ear')) return 'jowler';
    if (has('ear2')) return null;   // mirror-image lean: not one of the six
    if (front >= 1) return 'snouter';
    return null;
  }
  if (Math.abs(up[0]) > 0.6) return side();
  if (legs >= 3 && front >= 1 && !has('tail') && !has('torso') && up[1] > 0.7) return 'trotter';
  if (has('ridge') && legs === 0 && up[1] < -0.5) return 'razorback';
  return null;
}

/**
 * classify(quaternion) -> { pose, confidence, up, offAxisDeg, contacts, support }
 *
 * Primary signal is the contact set; POSE_UP supplies the left/right split and
 * the confidence margin. confidence 0 means "this is not cleanly any of the six"
 * — a pig on an edge, leaning on a wall, or sitting on its rump — which the game
 * turns into a re-toss (PRD §6.5) and the trajectory search discards.
 */
export function classify(q, opts = {}) {
  const { tol = CONTACT_TOL, cloud = CLOUD } = opts;
  const up = bodyUp(q);
  const l = Math.hypot(up[0], up[1], up[2]) || 1;
  const u = [up[0] / l, up[1] / l, up[2] / l];
  const cs = contactSet(q, tol, cloud);
  const physical = poseFromContacts(cs.parts, u);
  const pose = physical || classifyUp(u).pose;

  // how far the attitude is from this pose's nominal one, for reporting and as
  // a sanity brake — the contact set is the decisive signal, so we do NOT also
  // require the attitude to be nearer this pose's axis than every other's
  const ref = POSE_UP[pose];
  const own = Math.acos(Math.max(-1, Math.min(1, u[0] * ref[0] + u[1] * ref[1] + u[2] * ref[2]))) / D2R;
  const align = 1 - own / (2 * MAX_OFF_AXIS_DEG);
  const support = Math.min(1, Math.max(0, cs.margin) / FULL_SUPPORT_MARGIN);
  const confidence = physical ? Math.max(0, Math.min(align, support)) : 0;
  return {
    pose, confidence, up: u, offAxisDeg: own,
    contacts: [...cs.parts].sort(), support: cs.margin, comHeight: cs.comHeight,
    physical: physical !== null,
  };
}

// ---------------------------------------------------------------------------
// Materials (PRD §6.2)
// ---------------------------------------------------------------------------
export const MATERIAL_TUNING = {
  pigFloor: { friction: 0.7, restitution: 0.4 },
  pigWall: { friction: 0.5, restitution: 0.25 },
  pigPig: { friction: 1.0, restitution: 0.2 },
  // PRD §6.2 wants "moderate" damping so pigs deaden fast instead of pinging
  // around. Swept in dev/collider-test.mjs: damping barely moves the settle time
  // (median stays ~1.95s — that is dominated by the pig sliding to a stop, not by
  // spin) but this pair measurably cut ambiguous rests, 6.5% -> 5.2%, and made
  // snouters more reliable.
  angularDamping: 0.42,
  linearDamping: 0.08,
  // extra damping applied to both pigs while they are touching each other
  grabDamping: 0.35,
};

/** Builds the compound pig body. The body origin is the collider's COM. */
export function buildPigBody(opts = {}) {
  const {
    material = null, parts = PIG_PARTS, mass = PIG_MASS,
    angularDamping = MATERIAL_TUNING.angularDamping,
    linearDamping = MATERIAL_TUNING.linearDamping,
    dot = false,
  } = opts;
  const mp = pigMassProperties(parts, mass);
  const body = new CANNON.Body({ mass, material, allowSleep: false });
  for (const p of parts) {
    let shape;
    if (p.kind === 'box') shape = new CANNON.Box(new CANNON.Vec3(p.he[0], p.he[1], p.he[2]));
    else shape = new CANNON.Cylinder(p.r, p.r, p.h, p.seg);
    const off = new CANNON.Vec3(p.pos[0] - mp.com[0], p.pos[1] - mp.com[1], p.pos[2] - mp.com[2]);
    body.addShape(shape, off, quatFromEulerDeg(p.rot));
  }
  // cannon-es approximates inertia with the body's world AABB and always puts
  // the COM at the origin. The origin already IS the COM (offsets above), and
  // here we replace the AABB guess with the analytic tensor's diagonal.
  body.updateMassProperties();
  const [ix, iy, iz] = mp.inertiaDiag;
  body.inertia.set(ix, iy, iz);
  body.invInertia.set(1 / ix, 1 / iy, 1 / iz);
  body.updateInertiaWorld(true);
  body.angularDamping = angularDamping;
  body.linearDamping = linearDamping;
  body.pig = { dot, com: mp.com.slice(), inertiaDiag: mp.inertiaDiag.slice() };
  return body;
}

const CLOUD = colliderPointCloud();
export { CLOUD as PIG_CLOUD };

/** Height that puts the collider's lowest vertex `gap` above the floor. */
export function restHeight(q, gap = 0.003, cloud = CLOUD) {
  return -lowestPoint(q, cloud).y + gap;
}

/**
 * The settled attitude for a pose: the shortest rotation that takes the pose's
 * body-frame up vector to world up. A resting attitude is fully determined by
 * which body direction points up plus a free yaw, so this is exact — no table
 * of hand-picked Euler angles to drift out of sync with POSE_UP.
 */
export function poseQuaternion(pose, yaw = 0) {
  const a = POSE_UP[pose];
  if (!a) throw new Error(`unknown pose ${pose}`);
  const q = new CANNON.Quaternion();
  const dot = a[1]; // a . (0,1,0)
  if (dot > 0.999999) q.set(0, 0, 0, 1);
  else if (dot < -0.999999) q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI);
  else {
    // shortest arc from a to +Y: axis = a x (0,1,0) = (-az, 0, ax)
    const ax = [-a[2], 0, a[0]];
    const s = Math.sqrt((1 + dot) * 2);
    q.set(ax[0] / s, ax[1] / s, ax[2] / s, s / 2);
    q.normalize();
  }
  if (yaw) {
    const qy = new CANNON.Quaternion();
    qy.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
    qy.mult(q, q);
  }
  return q;
}

/**
 * A placement (position + quaternion) that rests the pig in `pose`, hovering
 * `gap` above the floor, yawed by `yaw` radians about world Y.
 */
export function posePlacement(pose, { yaw = 0, gap = 0.004, at = [0, 0], cloud = CLOUD } = {}) {
  const q = poseQuaternion(pose, yaw);
  return { position: [at[0], restHeight(q, gap, cloud), at[1]], quaternion: q };
}

// ---------------------------------------------------------------------------
// Contact events (SPEC "Physics-driven reactions")
// ---------------------------------------------------------------------------
// Recorded during simulateOne/findOinker so fx.js can time face/sound
// reactions to REAL impacts instead of guessing from the final pose alone —
// a face-first snouter reads differently from a flat-out belly-flop that
// happens to settle the same way.
//
//   { t, impulse, region }
//   region: 'snout' | 'head' | 'back' | 'rump' | 'belly' | 'legs' | 'side'
//   impulse: normal-impulse magnitude of the hardest contact this step
//
// Only contacts above EVENT_NOISE_FLOOR are kept (a resting pig's own weight
// is well under it — that is what keeps a settled rest event-free), and
// anything within EVENT_MERGE_S of the last kept event merges into it,
// keeping whichever hit harder: the two or three solver steps of one real
// bounce must not read as a flurry of taps.
export const EVENT_NOISE_FLOOR = 0.5;
export const EVENT_MERGE_S = 0.05;
export const EVENT_REGIONS = ['snout', 'head', 'back', 'rump', 'belly', 'legs', 'side'];

const { com: PIG_COM } = pigMassProperties(PIG_PARTS, PIG_MASS);

/**
 * Which named region of the pig owns a body-frame contact point. `lx,ly,lz`
 * are COM-centered (the frame cannon-es bodies live in, and the frame a
 * contact's local point is unrotated into below); PIG_TUNING's numbers are in
 * the un-recentered BUILD frame (y=0 is the floor when the pig trots), so
 * PIG_COM converts one into the other. Checked from the most positionally
 * distinctive parts to the least: legs and snout are unambiguous by position
 * alone, so they go first; what's left is the torso's four faces (the
 * head-ward neck, the back, the belly, and everything else on the flank).
 */
function regionFromLocalPoint(lx, ly, lz) {
  const t = PIG_TUNING;
  const x = lx + PIG_COM[0], y = ly + PIG_COM[1], z = lz + PIG_COM[2];
  if (Math.abs(x) > 0.11 && y < 0.22) return 'legs';
  if (z > t.headZ + t.headHZ * 0.5) return 'snout';
  if (z > t.torsoZ + t.torsoHZ * 0.6 && y > t.torsoY) return 'head';
  if (z < t.torsoZ - t.torsoHZ * 0.75) return 'rump';
  if (y > t.torsoY + t.torsoHY * 0.7) return 'back';
  if (y < t.torsoY - t.torsoHY * 0.5) return 'belly';
  return 'side';
}

/**
 * Rotate a world-oriented vector (a cannon-es contact's `ri`/`rj` — anchored
 * at the body's center, but expressed in world axes) by the CONJUGATE of a
 * unit quaternion, i.e. take it from world axes into that body's own local
 * axes. Writes into the caller's `out` (a plain 3-array) so nothing
 * allocates: this runs from inside the physics step loop.
 */
function unrotateInto(q, vx, vy, vz, out) {
  const cx = -q.x, cy = -q.y, cz = -q.z, cw = q.w;
  const uvx = cy * vz - cz * vy, uvy = cz * vx - cx * vz, uvz = cx * vy - cy * vx;
  const uuvx = cy * uvz - cz * uvy, uuvy = cz * uvx - cx * uvz, uuvz = cx * uvy - cy * uvx;
  out[0] = vx + 2 * (cw * uvx + uuvx);
  out[1] = vy + 2 * (cw * uvy + uuvy);
  out[2] = vz + 2 * (cw * uvz + uuvz);
  return out;
}

/**
 * Per-body scratch accumulator for one sim's contact events. Fixed-capacity
 * and reused across every candidate a search tries (PigSim owns one per pig
 * slot) so the hot loop allocates nothing. `add()` does the SPEC's
 * noise-floor + 50ms-merge in place, so by the time a sim ends the buffer
 * already holds the de-duplicated event list, ready to materialize.
 */
class ContactEventTracker {
  constructor(cap = 64) {
    this.t = new Float64Array(cap);
    this.impulse = new Float64Array(cap);
    this.region = new Array(cap).fill(null);
    this.n = 0;
    this.cap = cap;
  }
  reset() { this.n = 0; }
  add(t, impulse, region) {
    if (impulse < EVENT_NOISE_FLOOR) return;
    const n = this.n;
    if (n > 0 && t - this.t[n - 1] <= EVENT_MERGE_S) {
      if (impulse > this.impulse[n - 1]) {
        this.t[n - 1] = t; this.impulse[n - 1] = impulse; this.region[n - 1] = region;
      }
      return;
    }
    if (n >= this.cap) return; // a real toss never gets close to this; drop rather than grow mid-loop
    this.t[n] = t; this.impulse[n] = impulse; this.region[n] = region;
    this.n = n + 1;
  }
  /** Materializes the SPEC event objects — called once per sim, not per step. */
  toEvents() {
    const out = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = { t: this.t[i], impulse: this.impulse[i], region: this.region[i] };
    return out;
  }
}

/** Combine two per-pig event streams (findOinker) into one list, tagged with
 * which pig (1|2, matching replay.js's pair `which` convention) and sorted by
 * time — a joint impact shows up from both pigs' point of view, at their own
 * contact point, which is correct: they can take different expressions. */
function combineEvents(evA, evB) {
  const out = [];
  for (const e of evA) out.push({ t: e.t, impulse: e.impulse, region: e.region, pig: 1 });
  for (const e of evB) out.push({ t: e.t, impulse: e.impulse, region: e.region, pig: 2 });
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ---------------------------------------------------------------------------
// PigSim — the headless world
// ---------------------------------------------------------------------------
export class PigSim {
  constructor(opts = {}) {
    const { pigs = 2, solverIterations = 14, parts = PIG_PARTS } = opts;
    this.parts = parts;
    // classification is geometry-aware, so a sim built on a candidate collider
    // must classify against THAT collider, not the module default
    this.cloud = parts === PIG_PARTS ? CLOUD : colliderPointCloud(parts);
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
    world.broadphase = new CANNON.NaiveBroadphase();
    world.allowSleep = false;
    world.solver.iterations = solverIterations;
    world.solver.tolerance = 1e-4;
    world.defaultContactMaterial.contactEquationStiffness = 5e7;
    world.defaultContactMaterial.contactEquationRelaxation = 3;

    this.matPig = new CANNON.Material('pig');
    this.matFloor = new CANNON.Material('floor');
    const t = MATERIAL_TUNING;
    world.addContactMaterial(new CANNON.ContactMaterial(this.matPig, this.matFloor, {
      friction: t.pigFloor.friction, restitution: t.pigFloor.restitution,
      contactEquationStiffness: 5e7, contactEquationRelaxation: 3,
      frictionEquationStiffness: 5e7, frictionEquationRelaxation: 3,
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(this.matPig, this.matPig, {
      friction: t.pigPig.friction, restitution: t.pigPig.restitution,
    }));

    // ONE infinite plane and nothing else — no walls, no geometry seams. The
    // board's zones are applied as post-step damping (zoneDamp), exactly as in
    // the `_watch/arena.html` reference.
    const floor = new CANNON.Body({ mass: 0, material: this.matFloor, shape: new CANNON.Plane() });
    floor.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    world.addBody(floor);
    this.floor = floor;

    this.world = world;
    this.pigs = [];
    for (let i = 0; i < pigs; i++) {
      const b = buildPigBody({ material: this.matPig, dot: i === 1, parts });
      b.position.set(i === 0 ? -1 : 1, 1.4, 0);
      world.addBody(b);
      this.pigs.push(b);
    }
    // one contact-event tracker per pig slot, reused for every candidate a
    // search tries — see "Contact events" above
    this._evTrackers = this.pigs.map(() => new ContactEventTracker());
    this._evScratch = [0, 0, 0];
    this.dt = FIXED_DT;
  }

  /**
   * The board's zones, applied to one pig AFTER a world step (SPEC "Board
   * design"). Deliberately not a material or a mesh: a single infinite plane
   * plus a velocity multiplier has no seams for a pig to catch on, and it can
   * kill a bounce, which friction alone cannot.
   *
   * Airborne pigs are never touched — a pig sailing over the rough should not
   * be slowed by it — so the zone only bites below BOARD.groundedY.
   *
   * Every sim in the game goes through here, so this must stay deterministic:
   * it reads only the body's own position/velocity, which is what keeps
   * re-running a stored initial condition bit-identical.
   */
  zoneDamp(body) {
    const b = BOARD;
    const r = Math.hypot(body.position.x, body.position.z);
    if (body.position.y <= b.groundedY && r > b.greenR) {
      const rough = r <= b.roughR;
      const k = rough ? b.roughDamp : b.stopDamp;
      body.velocity.scale(k, body.velocity);
      body.angularVelocity.scale(k * b.spinDamp, body.angularVelocity);
      if (body.velocity.y > 0) body.velocity.y *= rough ? b.roughBounce : b.stopBounce;
    }
    // Absolute backstop. Nothing should ever reach it (the throw sampler is
    // tuned so ~99% of settles land on the green or the rough), but a board
    // with no walls needs *something* that makes escape impossible.
    const limit = b.stopR + b.backstop;
    if (r > limit) {
      const s = limit / r;
      body.position.x *= s;
      body.position.z *= s;
      body.velocity.scale(0.1, body.velocity);
    }
  }

  /**
   * Finds the hardest contact this step involving `body` and, if it clears
   * the noise floor, files it into `tracker`. A pig-pig contact (Oinker)
   * shows up from both bodies' point of view when this is called once per
   * body — which is correct, since each pig has its own contact point and
   * can take its own expression. Reads only `this.world.contacts`, which
   * cannon-es freshly populates and solves every `world.step()` call, so
   * this must run right after that step and before the next one.
   */
  _captureEvents(body, tracker, t) {
    const contacts = this.world.contacts;
    let bestImpulse = -1, bestR = null;
    for (let i = 0; i < contacts.length; i++) {
      const eq = contacts[i];
      let r;
      if (eq.bi === body) r = eq.ri;
      else if (eq.bj === body) r = eq.rj;
      else continue;
      const impulse = eq.multiplier * this.dt;
      if (impulse > bestImpulse) { bestImpulse = impulse; bestR = r; }
    }
    if (bestR && bestImpulse >= EVENT_NOISE_FLOOR) {
      const s = this._evScratch;
      unrotateInto(body.quaternion, bestR.x, bestR.y, bestR.z, s);
      tracker.add(t, bestImpulse, regionFromLocalPoint(s[0], s[1], s[2]));
    }
  }

  reset(body, ic) {
    body.position.set(ic.p[0], ic.p[1], ic.p[2]);
    body.quaternion.set(ic.q[0], ic.q[1], ic.q[2], ic.q[3]);
    body.velocity.set(ic.v[0], ic.v[1], ic.v[2]);
    body.angularVelocity.set(ic.w[0], ic.w[1], ic.w[2]);
    body.force.setZero();
    body.torque.setZero();
    body.interpolatedPosition.copy(body.position);
    body.interpolatedQuaternion.copy(body.quaternion);
    body.previousPosition.copy(body.position);
    body.previousQuaternion.copy(body.quaternion);
    body.updateInertiaWorld(true);
    body.wakeUp();
  }

  /**
   * Takes a pig out of a single-pig sim entirely, and unpark() puts it back.
   *
   * Parking it somewhere far away instead does NOT work cleanly, because the
   * floor is an infinite plane: a body moved below it is inside a half-space and
   * either gets fired out at hundreds of m/s or (with collision response off)
   * sits inside the plane's AABB forever, so the narrowphase keeps testing all
   * eleven of its shapes on every step of every sim. MEASURED over 700 sims,
   * outcomes bit-identical in every variant:
   *
   *   parked below the floor, response on    2.58 ms/sim  (fires itself out)
   *   parked below the floor, response off   5.32 ms/sim  (worst: never leaves)
   *   parked 600m up                         2.23 ms/sim
   *   removed from the world                 1.83 ms/sim  <-
   *
   * A search runs thousands of these, so 29% is worth the two lines.
   */
  park(body) {
    if (body.world) this.world.removeBody(body);
  }

  unpark(body) {
    if (!body.world) this.world.addBody(body);
  }

  // Frame capture goes into preallocated Float64Arrays, never into fresh
  // objects: the search runs thousands of sims of ~230 steps each, and one
  // {p:[],q:[]} pair per step is ~700k short-lived arrays per search. The
  // buffer is written every step and only turned into a Recording's frame
  // objects for the ONE candidate that gets accepted (_frames below).
  _buffers(maxSteps) {
    if (this._pBuf && this._bufCap >= maxSteps) return;
    this._bufCap = maxSteps;
    this._pBuf = new Float64Array(maxSteps * 3);
    this._qBuf = new Float64Array(maxSteps * 4);
    this._pBuf2 = new Float64Array(maxSteps * 3);   // second pig, Oinker only
    this._qBuf2 = new Float64Array(maxSteps * 4);
  }

  /** Turn n buffered steps into the SPEC Recording frame list. */
  _frames(n) {
    const p = this._pBuf, q = this._qBuf, out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = {
        p: [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]],
        q: [q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]],
      };
    }
    return out;
  }

  _pairFrames(n) {
    const p = this._pBuf, q = this._qBuf, p2 = this._pBuf2, q2 = this._qBuf2;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = {
        p1: [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]],
        q1: [q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]],
        p2: [p2[i * 3], p2[i * 3 + 1], p2[i * 3 + 2]],
        q2: [q2[i * 4], q2[i * 4 + 1], q2[i * 4 + 2], q2[i * 4 + 3]],
      };
    }
    return out;
  }

  /**
   * simulateOne(ic) — one pig, fixed dt, headless. Returns a Recording:
   * { dt, frames:[{p,q}], settledPose, confidence, ... }
   *
   * Search-oriented options (all optional, all skippable for a plain sim):
   *   side       -1|1  confine the pig to that half of the pen; the moment it
   *                    crosses the midline the sim is abandoned (rejected:'lane')
   *   target     pose  abandon the sim as soon as the pig has stopped tumbling
   *                    facing nowhere near this pose (rejected:'attitude')
   *   record     true  materialize frames; 'buffer' keeps them in the scratch
   *                    buffer only (frameCount is set, frames stays null) so a
   *                    rejected candidate costs no garbage
   */
  simulateOne(ic, opts = {}) {
    const {
      pig = 0, maxSeconds = 5, record = true, settleFrames = 15,
      vEps = 0.055, wEps = 0.25, side = 0, target = null,
      abortW2 = ABORT_W2, abortCos = ABORT_COS,
    } = opts;
    const body = this.pigs[pig];
    for (let i = 0; i < this.pigs.length; i++) if (i !== pig) this.park(this.pigs[i]);
    this.reset(body, ic);
    const tracker = this._evTrackers[pig];
    tracker.reset();

    const maxSteps = Math.ceil(maxSeconds / this.dt);
    if (record) this._buffers(maxSteps);
    const pBuf = this._pBuf, qBuf = this._qBuf;
    const ref = target ? POSE_UP[target] : null;
    const inner = side === 0 ? 0 : LANE.inner;
    const edge2 = BOARD.stopR * BOARD.stopR;

    let calm = 0, settledAt = -1, n = 0, rejected = null;
    for (let s = 0; s < maxSteps; s++) {
      this.world.step(this.dt);
      this.zoneDamp(body);
      const px = body.position.x, py = body.position.y, pz = body.position.z;
      if (record) {
        const i3 = n * 3, i4 = n * 4;
        pBuf[i3] = px; pBuf[i3 + 1] = py; pBuf[i3 + 2] = pz;
        qBuf[i4] = body.quaternion.x; qBuf[i4 + 1] = body.quaternion.y;
        qBuf[i4 + 2] = body.quaternion.z; qBuf[i4 + 3] = body.quaternion.w;
        this._captureEvents(body, tracker, s * this.dt);
      }
      n++;
      // containment: past the fringe the throw was simply too hard to keep, and
      // below the floor the solver let it tunnel. Neither is a usable recording.
      if (px * px + pz * pz > edge2 || py < -0.02) { rejected = 'board'; break; }
      // half-board confinement (SPEC): two independently found recordings are
      // replayed together, so neither pig may ever enter the other's half
      if (inner && (side > 0 ? px < inner : px > -inner)) { rejected = 'lane'; break; }
      const w2 = body.angularVelocity.lengthSquared();
      // cheap early-out: once the tumble is spent the attitude is committed, so
      // a pig lying nowhere near the target's up axis will never become it. A
      // false reject only costs one candidate — accepted sims always run to a
      // full settle — so this is safe to be a little aggressive with.
      if (ref && w2 < abortW2 && (s & 7) === 7) {
        const q = body.quaternion;
        const ux = 2 * (q.x * q.y + q.z * q.w);
        const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
        const uz = 2 * (q.y * q.z - q.x * q.w);
        if (ux * ref[0] + uy * ref[1] + uz * ref[2] < abortCos) { rejected = 'attitude'; break; }
      }
      if (body.velocity.lengthSquared() < vEps * vEps && w2 < wEps * wEps) {
        calm++;
        if (calm >= settleFrames) { settledAt = s; break; }
      } else calm = 0;
    }
    if (rejected) {
      // still report where it ended up: callers that are not searching (dev
      // tools, the collider harness) should degrade rather than see undefined
      return {
        dt: this.dt, frames: null, frameCount: n, rejected,
        settledPose: null, confidence: 0, settled: false, steps: n, events: null,
        finalQ: [body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w],
        finalP: [body.position.x, body.position.y, body.position.z],
      };
    }
    const c = classify(body.quaternion, { cloud: this.cloud });
    return {
      dt: this.dt,
      frames: record === true ? this._frames(n) : null,
      frameCount: n, steps: n, rejected: null,
      settledPose: c.pose, confidence: c.confidence, offAxisDeg: c.offAxisDeg,
      contacts: c.contacts, support: c.support,
      settled: settledAt >= 0, settleSeconds: (settledAt + 1) * this.dt,
      events: record ? tracker.toEvents() : null,
      finalQ: [body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w],
      finalP: [body.position.x, body.position.y, body.position.z],
    };
  }

  /** Steps an already-placed pig for `seconds` without resetting it. */
  settleInPlace(pig = 0, seconds = 2, record = false) {
    const body = this.pigs[pig];
    const steps = Math.ceil(seconds / this.dt);
    const frames = [];
    let maxV = 0, maxW = 0;
    for (let s = 0; s < steps; s++) {
      this.world.step(this.dt);
      this.zoneDamp(body);
      maxV = Math.max(maxV, body.velocity.length());
      maxW = Math.max(maxW, body.angularVelocity.length());
      if (record) frames.push({
        p: [body.position.x, body.position.y, body.position.z],
        q: [body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w],
      });
    }
    return { frames, maxV, maxW, ...classify(body.quaternion, { cloud: this.cloud }) };
  }

  /** SPEC contract: classify(quaternion) against THIS sim's collider. */
  classify(quaternion) {
    return classify(quaternion, { cloud: this.cloud });
  }

  /** Kicks a resting pig: linear impulse at the COM plus a spin. */
  nudge(pig, impulse, spin) {
    const b = this.pigs[pig];
    b.applyImpulse(new CANNON.Vec3(impulse[0], impulse[1], impulse[2]), b.position);
    b.angularVelocity.set(spin[0], spin[1], spin[2]);
    b.wakeUp();
  }

  /** Places a pig in a canonical resting pose, hovering just above the floor. */
  place(pig, pose, opts = {}) {
    const pl = posePlacement(pose, { cloud: this.cloud, ...opts });
    for (let i = 0; i < this.pigs.length; i++) if (i !== pig) this.park(this.pigs[i]);
    this.reset(this.pigs[pig], { p: pl.position, q: [pl.quaternion.x, pl.quaternion.y, pl.quaternion.z, pl.quaternion.w], v: [0, 0, 0], w: [0, 0, 0] });
    return pl;
  }

  /** true when the two pigs are touching (Oinker precondition, PRD §6.5) */
  pigsTouching() {
    const [a, b] = this.pigs;
    for (const eq of this.world.contacts) {
      if ((eq.bi === a && eq.bj === b) || (eq.bi === b && eq.bj === a)) return true;
    }
    return false;
  }

  /**
   * findRecording(targetPose, { maxSims, side, rng }) — Approach B (PRD §6.3):
   * the outcome has already been drawn from odds.js, so here we hunt for a REAL
   * throw that lands on it. Nothing about the tumble is faked: the frames we
   * return are the frames the accepted simulation actually produced.
   *
   * `side` (-1 left, +1 right) is the half of the pen this pig owns. Candidates
   * that stray into the other half are abandoned mid-flight, so two recordings
   * found for opposite sides can be replayed together and never intersect.
   *
   * Returns a Recording (+ search telemetry: sims, rejects, searchMs) or null.
   */
  findRecording(targetPose, opts = {}) {
    const {
      // 800 is the budget dev/search-test.mjs gates on: even the jowler
      // (~105 sims on average) misses it about once in 2000 searches
      maxSims = 800, rng = Math.random, side = -1, minConfidence = 0.12, pig = 0,
      allowFallback = false, maxSeconds = 5,
      abortW2 = ABORT_W2, abortCos = ABORT_COS,
    } = opts;
    if (!POSE_UP[targetPose]) throw new Error(`findRecording: unknown pose ${targetPose}`);
    const t0 = now();
    const rejects = { lane: 0, pen: 0, attitude: 0, pose: 0, unsettled: 0, weak: 0 };
    let bestIc = null, bestConf = -1, sims = 0;
    for (let i = 0; i < maxSims; i++) {
      sims++;
      const ic = randomToss(rng, side, targetPose);
      const rec = this.simulateOne(ic, {
        pig, maxSeconds, record: 'buffer', side, target: targetPose, abortW2, abortCos,
      });
      if (rec.rejected) { rejects[rec.rejected]++; continue; }
      if (!rec.settled) { rejects.unsettled++; continue; }
      if (rec.settledPose !== targetPose) { rejects.pose++; }
      else if (rec.confidence < minConfidence) { rejects.weak++; }
      else {
        // the buffer still holds exactly this trajectory — materialize it
        rec.frames = this._frames(rec.frameCount);
        rec.side = side;
        rec.ic = ic;
        rec.sims = sims;
        rec.rejects = rejects;
        rec.searchMs = now() - t0;
        return rec;
      }
      // remember the cleanest wrong rest, for the §6.3 fallback
      if (rec.confidence > bestConf) { bestConf = rec.confidence; bestIc = ic; }
    }
    if (allowFallback && bestIc) {
      // PRD §6.3: never stall the game. Replay a real trajectory of the nearest
      // achievable pose and log it — the drawn outcome still governs scoring.
      // Re-running the stored initial conditions reproduces it bit-for-bit
      // (dev/collider-test.mjs and dev/search-test.mjs both assert determinism).
      const rec = this.simulateOne(bestIc, { pig, maxSeconds, record: true, side });
      if (rec.settledPose) {
        rec.side = side;
        rec.ic = bestIc;
        rec.fallbackFrom = targetPose;
        rec.sims = sims;
        rec.rejects = rejects;
        rec.searchMs = now() - t0;
        return rec;
      }
    }
    return null;
  }

  /**
   * findOinker({ maxSims }) — the joint search. An Oinker is the two pigs
   * coming to rest touching each other, so this is the one case that cannot be
   * assembled from two independent recordings: both pigs share one simulation
   * and the result is a PairRecording.
   *
   * PRD §6.2 "the grab": rubber pigs catch on each other and stop dead rather
   * than glancing off. That is modelled as raised pig-pig friction plus a
   * damping boost applied to BOTH bodies for as long as they are in contact —
   * which is what makes an Oinker physically plausible instead of a coin flip
   * bolted on. Accept only if they are still touching once everything is at
   * rest (a graze that ends apart is not an Oinker).
   */
  findOinker(opts = {}) {
    const {
      maxSims = 1200, rng = Math.random, maxSeconds = 5, settleFrames = 15,
      vEps = 0.055, wEps = 0.25,
    } = opts;
    const [a, b] = this.pigs;
    this.unpark(a); this.unpark(b);
    const t0 = now();
    const maxSteps = Math.ceil(maxSeconds / this.dt);
    this._buffers(maxSteps);
    const pA = this._pBuf, qA = this._qBuf, pB = this._pBuf2, qB = this._qBuf2;
    const edge2 = BOARD.stopR * BOARD.stopR;
    const t = MATERIAL_TUNING;
    const [trackerA, trackerB] = this._evTrackers;
    let sims = 0, contacts = 0;
    for (let i = 0; i < maxSims; i++) {
      sims++;
      const ia = randomToss(rng, -1), ib = randomToss(rng, 1);
      // aim them across the board at each other: an Oinker needs a collision,
      // and the halves rule does not apply to a pair recording (one sim)
      ia.v[0] = 0.5 + 1.9 * rng(); ib.v[0] = -(0.5 + 1.9 * rng());
      ia.p[2] = 1.2 + 1.4 * rng(); ib.p[2] = ia.p[2] + 0.5 * (rng() - 0.5);
      this.reset(a, ia); this.reset(b, ib);
      trackerA.reset(); trackerB.reset();
      let calm = 0, ok = false, grabbing = false, touched = false, n = 0, escaped = false;
      for (let s = 0; s < maxSteps; s++) {
        this.world.step(this.dt);
        this.zoneDamp(a); this.zoneDamp(b);
        const touching = this.pigsTouching();
        if (touching) touched = true;
        if (touching !== grabbing) {
          grabbing = touching;
          const ad = touching ? t.angularDamping + t.grabDamping : t.angularDamping;
          const ld = touching ? t.linearDamping + t.grabDamping : t.linearDamping;
          a.angularDamping = b.angularDamping = ad;
          a.linearDamping = b.linearDamping = ld;
        }
        const i3 = n * 3, i4 = n * 4;
        pA[i3] = a.position.x; pA[i3 + 1] = a.position.y; pA[i3 + 2] = a.position.z;
        qA[i4] = a.quaternion.x; qA[i4 + 1] = a.quaternion.y; qA[i4 + 2] = a.quaternion.z; qA[i4 + 3] = a.quaternion.w;
        pB[i3] = b.position.x; pB[i3 + 1] = b.position.y; pB[i3 + 2] = b.position.z;
        qB[i4] = b.quaternion.x; qB[i4 + 1] = b.quaternion.y; qB[i4 + 2] = b.quaternion.z; qB[i4 + 3] = b.quaternion.w;
        const evT = s * this.dt;
        this._captureEvents(a, trackerA, evT);
        this._captureEvents(b, trackerB, evT);
        n++;
        if (a.position.x * a.position.x + a.position.z * a.position.z > edge2
          || b.position.x * b.position.x + b.position.z * b.position.z > edge2
          || a.position.y < -0.02 || b.position.y < -0.02) { escaped = true; break; }
        // once both have deadened, decide: still touching -> Oinker
        if (a.velocity.lengthSquared() < vEps * vEps && a.angularVelocity.lengthSquared() < wEps * wEps
          && b.velocity.lengthSquared() < vEps * vEps && b.angularVelocity.lengthSquared() < wEps * wEps) {
          calm++;
          if (calm >= settleFrames) { ok = this.pigsTouching(); break; }
        } else calm = 0;
        // they met, bounced apart and are drifting to opposite corners: no point
        // simulating the rest of the slide
        if (touched && !touching && Math.abs(a.position.x - b.position.x) > 2.2) break;
      }
      a.angularDamping = b.angularDamping = t.angularDamping;
      a.linearDamping = b.linearDamping = t.linearDamping;
      if (touched) contacts++;
      if (ok && !escaped) {
        return {
          dt: this.dt, frames: this._pairFrames(n), oinker: true, pair: true,
          touching: true, settled: true, sims, contacts, searchMs: now() - t0,
          settledPose: classify(a.quaternion, { cloud: this.cloud }).pose,
          settledPoseB: classify(b.quaternion, { cloud: this.cloud }).pose,
          events: combineEvents(trackerA.toEvents(), trackerB.toEvents()),
          finalP: [a.position.x, a.position.y, a.position.z],
          finalP2: [b.position.x, b.position.y, b.position.z],
        };
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Half-board confinement (SPEC)
// ---------------------------------------------------------------------------
// A normal toss is TWO independent single-pig recordings replayed together, so
// nothing in the physics stops them from occupying the same space. The rule that
// makes it safe: pig A owns the left SEMICIRCLE of the board, pig B the right,
// and neither COM may ever come closer to the midline than the pig's own
// bounding radius. Two spheres of radius PIG_RADIUS centred at x <= -inner and
// x >= inner cannot intersect, so the replayed pigs provably never touch.
//
// `side`: -1 = left half, +1 = right half, 0 = no confinement (single-pig dev
// work and the Oinker pair sim, which is one simulation and needs the collision).

/** Radius of the collider's bounding sphere about the COM. */
export const PIG_RADIUS = (() => {
  let r = 0;
  for (const { v } of CLOUD) r = Math.max(r, Math.hypot(v[0], v[1], v[2]));
  return r;
})();

export const LANE = {
  inner: PIG_RADIUS + 0.03,   // closest a COM may come to the board's midline
  // Measured spawn window (dev/search-test.mjs prints the lane-reject rate):
  // launching from further out with a slight outward drift keeps ~88% of tosses
  // inside their half. Spawning nearer the midline threw away a third of them.
  spawnLo: 1.05, spawnHi: 2.10,
  vxLo: -0.05, vxHi: 0.45,    // signed OUTWARD (away from the midline)
};

/** Is this COM position on the board at all? (catches solver tunnelling) */
export function withinBoard(p) {
  return p[0] * p[0] + p[2] * p[2] <= BOARD.stopR * BOARD.stopR && p[1] >= -0.02;
}

/** Is this COM position on the board AND on `side`'s semicircle of it? */
export function withinHalf(p, side) {
  if (!withinBoard(p)) return false;
  if (side === 0) return true;
  return side > 0 ? p[0] >= LANE.inner : p[0] <= -LANE.inner;
}

/** Which zone a COM position is over: 'green' | 'rough' | 'fringe' | 'off'. */
export function boardZone(p) {
  const r = Math.hypot(p[0], p[2]);
  if (r <= BOARD.greenR) return 'green';
  if (r <= BOARD.roughR) return 'rough';
  if (r <= BOARD.stopR) return 'fringe';
  return 'off';
}

// How aggressively the search abandons a candidate that has stopped tumbling
// while pointing nowhere near the target pose. Deliberately loose: the jowler and
// side-dot up-axes are only 24° apart, so a tight cone throws away real jowler
// candidates. MEASURED over 30 searches per setting (2200 sims), same rng stream
// so a lost candidate shows up as a changed sim count:
//
//   gate          jowler sims / ms    snouter sims / ms
//   off              74.2 / 195          41.8 / 111
//   w1.6 cone 70°    74.2 / 121          41.8 /  70   <- free 40%
//   w1.6 cone 55°    85.3 / 134          50.5 /  79   <- starts losing hits
//   w2.5 cone 70°   115.3 / 164          41.8 /  64   <- fires mid-tumble
//
// i.e. at 1.6 rad/s and 70° the early-out has never once cost a candidate; it
// only skips the long slide-to-a-stop of a pig that has already lost.
const ABORT_W2 = 1.6 * 1.6;                          // (rad/s)^2
const ABORT_COS = Math.cos(70 * D2R);

const now = typeof performance !== 'undefined' && performance.now
  ? () => performance.now() : () => Date.now();

// ---------------------------------------------------------------------------
// Random tosses — pose-conditioned initial sampling
// ---------------------------------------------------------------------------
function rand(rng, a, b) { return a + (b - a) * rng(); }

// The launch *scalars* barely predict the outcome for this collider —
// dev/collider-test.mjs prints spin/speed/height means by pose and they all sit
// within a few percent of the population, which is why the earlier attempts to
// bias speed and spin ranges measured WORSE than brute force. What actually
// moves the rare poses is the release ATTITUDE: start the pig at the target
// pose's resting attitude (random yaw), knock it `pre` radians off that attitude
// about a random axis, and give it enough spin to tumble back.
//
// MEASURED, 9000 lane-confined sims per cell, ±1 s.e. shown. Small-N sweeps
// here are worse than useless: a 1600-sim grid "found" a jowler setting that
// 9000 sims showed was noise, and a 2500-sim pass ranked the arms below in a
// completely different order. Nothing goes in this table under 9000 sims.
//
//   arm                          trotter        snouter        jowler
//   uniform                    5.89 ±0.26     1.42 ±0.13    0.82 ±0.10
//   soft   pre1.1 spin 2-8    12.92 ±0.38     2.57 ±0.17    0.89 ±0.10
//   spun   pre1.0 spin10-22    7.97 ±0.30     2.07 ±0.15    1.03 ±0.11
//   mid    pre1.8 spin 6-16    5.90 ±0.26     1.80 ±0.14    0.74 ±0.09
//
// A slow lob released near the pose (soft) is a decisive win for trotter (2.2x)
// and snouter (1.8x, reproduced on a second 9000-sim run at 1.66 -> 2.97).
//
// The jowler is the honest disappointment: pooled over 18000 sims per arm it is
// 0.90 ±0.07 uniform against 1.03 ±0.08 for spun — 1.3 sigma, consistently
// positive but not a real finding. `spun` is kept because it is never worse and
// it is the only arm that beat uniform on both runs, not because the mechanism is
// proven. For a pose that is one part in a hundred of a chaotic map, brute force
// with a nudge is the correct answer.
//
// The sides and the razorback are common enough (25–40%) that conditioning them
// buys nothing, so they stay uniform brute force.
//
// `mix` keeps unconditioned tosses in the stream on purpose: a conditioned throw
// is visually a bit tamer, and a rare pose that ALWAYS arrived from the same lazy
// lob would be a tell the player could read. PRD §6.3 wants the search invisible,
// and that includes not being guessable from the arc.
export const POSE_SAMPLING = {
  trotter: { mix: 0.7, spinLo: 2, spinHi: 8, hLo: 0.9, hHi: 1.5, spdLo: 1.2, spdHi: 2.4, pre: 1.1 },
  snouter: { mix: 0.85, spinLo: 2, spinHi: 8, hLo: 0.9, hHi: 1.5, spdLo: 1.2, spdHi: 2.4, pre: 1.1 },
  // The realism pass moved the jowler from a 66°-rolled side-lean to a 37°
  // Snouter-with-a-lean, and that flipped which release arm finds it. The old
  // rest was reachable by flinging the pig hard (`spun`, spin 10-22) because it
  // sat right next to the Side rests; the new one is a precarious three-point
  // prop next to the snouter, and a hard fling always rolls straight through it.
  // MEASURED on the new collider, 2500 lane-confined targeted sims each, same
  // rng stream; "frames" is the median length of an accepted recording, i.e.
  // how long the toss takes on screen (the other five poses run ~250):
  //   arm                             hit rate   miss in 800   frames
  //   spun    pre 1.0  spin 10-22        0.24%        15%        216
  //   soft    pre 1.1  spin  2-8         0.68%       0.4%        145
  //   lob     pre 0.35 spin 0.8-4        2.28%       1e-6%       136   <- this
  //   placed  pre 0.18 spin 0.5-3        9.56%      1e-33%       111
  // `lob` is a real throw — released a body-height up at walking pace with a
  // lazy tumble — and 2.3% leaves the 800-sim budget a factor of a million of
  // headroom. `placed` is cheaper still, but its arc reads as a drop rather
  // than a throw and it would make the rarest, most exciting result on the
  // board the one with the most boring flight.
  jowler: { mix: 0.92, spinLo: 0.8, spinHi: 4, hLo: 0.8, hHi: 1.3, spdLo: 0.9, spdHi: 1.8, pre: 0.35 },
};

const UNIFORM_TOSS = { spinLo: 2, spinHi: 30, hLo: 1.0, hHi: 1.9, spdLo: 1.7, spdHi: 4.0 };

/**
 * A plausible throw: pigs are lobbed in from the near edge of the pen (+Z,
 * toward the player) and tumble away from the camera. `targetPose` opts into the
 * pose-conditioned sampling described above; it only changes how the pig is
 * RELEASED, never what happens after — the physics is untouched, which is what
 * keeps Approach B honest.
 */
export function randomToss(rng = Math.random, side = 0, targetPose = null) {
  const cond = targetPose ? POSE_SAMPLING[targetPose] : null;
  const useAttitude = cond ? rng() < cond.mix : false;
  const t = useAttitude ? cond : UNIFORM_TOSS;

  let q;
  if (useAttitude) {
    // release near the target's resting attitude (random yaw), then knock it
    // `pre` radians off that attitude so it has to tumble back into it
    const base = poseQuaternion(targetPose, rand(rng, 0, Math.PI * 2));
    const ax = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
    const al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    q = new CANNON.Quaternion();
    q.setFromAxisAngle(new CANNON.Vec3(ax[0] / al, ax[1] / al, ax[2] / al), rand(rng, -cond.pre, cond.pre));
    q.mult(base, q);
  } else {
    q = new CANNON.Quaternion();
    q.setFromEuler(rand(rng, 0, Math.PI * 2), rand(rng, 0, Math.PI * 2), rand(rng, 0, Math.PI * 2), 'XYZ');
  }

  const spin = rand(rng, t.spinLo, t.spinHi);
  const ax = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
  const al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const speed = rand(rng, t.spdLo, t.spdHi);
  // inside a lane the sideways drift points outward, away from the midline;
  // unconfined (side 0) it is symmetric
  const x = side === 0 ? rand(rng, -1.6, 1.6) : side * rand(rng, LANE.spawnLo, LANE.spawnHi);
  const vx = side === 0 ? rand(rng, -0.45, 0.45) : side * rand(rng, LANE.vxLo, LANE.vxHi);
  return {
    p: [x, rand(rng, t.hLo, t.hHi), rand(rng, 1.5, 2.7)],
    q: [q.x, q.y, q.z, q.w],
    v: [vx, rand(rng, -0.9, 0.7), -speed],
    w: [(ax[0] / al) * spin, (ax[1] / al) * spin, (ax[2] / al) * spin],
  };
}

// ---------------------------------------------------------------------------
// Mirror augmentation (SPEC)
// ---------------------------------------------------------------------------
// The board is a disc, so reflecting a recording through the plane x = 0 gives
// another trajectory that obeys the same zones, the same gravity and the same
// floor — and it lands in the OTHER half, which is exactly what a pool of
// two-lane recordings needs.
//
// The catch: the pig is not symmetric. It has one swept-back ear and a leg lean,
// so a reflected trajectory is a valid motion of the pig's MIRROR IMAGE. For the
// poses whose contact set is chirally paired that is still a real rest of the
// real pig with the sides swapped (a mirrored side-blank rest is a side-dot
// rest); for a pose that only exists on one side — the jowler, propped on the
// one swept-back ear — the mirror is not a rest of this pig at all.
//
// So mirroring is never trusted blind: mirrorRecording() produces the candidate
// and verifyRecording() re-runs the real classifier and the real floor-contact
// test on it, and the mirror is only used if it passes. That keeps the "every
// frame is real physics" promise intact.
export const MIRROR_POSE = {
  'side-blank': 'side-dot', 'side-dot': 'side-blank',
  razorback: 'razorback', trotter: 'trotter', snouter: 'snouter', jowler: 'jowler',
};

/**
 * Reflect a single recording through the pen's long axis (x -> -x).
 * Positions mirror componentwise; the orientation transforms as R' = M R M with
 * M = diag(-1,1,1), which in quaternion terms is (x, y, z, w) -> (x, -y, -z, w)
 * — a proper rotation, so the replay still just sets a quaternion.
 */
export function mirrorRecording(rec) {
  const frames = new Array(rec.frames.length);
  for (let i = 0; i < rec.frames.length; i++) {
    const f = rec.frames[i];
    frames[i] = {
      p: [-f.p[0], f.p[1], f.p[2]],
      q: [f.q[0], -f.q[1], -f.q[2], f.q[3]],
    };
  }
  const last = frames[frames.length - 1];
  return {
    dt: rec.dt, frames,
    settledPose: MIRROR_POSE[rec.settledPose] ?? null,
    side: -(rec.side || 0),
    mirrored: !rec.mirrored,
    settled: rec.settled,
    // events are unaffected by the x -> -x reflection: none of the SPEC
    // region names encode left/right, and t/impulse are properties of the
    // original real contact, not of the mirrored geometry
    events: rec.events ? rec.events.map((e) => ({ ...e })) : null,
    finalP: last.p.slice(), finalQ: last.q.slice(),
    settleSeconds: rec.settleSeconds,
  };
}

/**
 * Is this recording actually usable? Checks the things a replay depends on:
 * the last frame really is the claimed pose, it is a clean rest (confident, and
 * sitting ON the floor rather than floating or sunk), and every frame stayed
 * inside the pen and inside its own half. Used to police mirrored recordings and
 * as a self-check in dev.
 */
export function verifyRecording(rec, opts = {}) {
  const {
    pose = rec.settledPose, side = rec.side ?? 0, minConfidence = 0.12,
    cloud = CLOUD, floorTol = 0.02,
  } = opts;
  if (!rec || !rec.frames || !rec.frames.length) return { ok: false, why: 'no frames' };
  const last = rec.frames[rec.frames.length - 1];
  const q = { x: last.q[0], y: last.q[1], z: last.q[2], w: last.q[3] };
  const c = classify(q, { cloud });
  if (c.pose !== pose) return { ok: false, why: `ends as ${c.pose}, not ${pose}`, classify: c };
  if (c.confidence < minConfidence) return { ok: false, why: `confidence ${c.confidence.toFixed(3)}`, classify: c };
  const gap = last.p[1] + lowestPoint(q, cloud).y;   // signed distance to the floor
  if (Math.abs(gap) > floorTol) return { ok: false, why: `rest floats/sinks by ${gap.toFixed(4)}`, classify: c };
  for (let i = 0; i < rec.frames.length; i++) {
    const p = rec.frames[i].p;
    if (!withinBoard(p)) return { ok: false, why: `frame ${i} left the board`, classify: c };
    if (side && !withinHalf(p, side)) return { ok: false, why: `frame ${i} left its half`, classify: c };
  }
  return { ok: true, classify: c, floorGap: gap };
}

// ---------------------------------------------------------------------------
// TrajectoryCache — prefilled pools of recordings per pose (SPEC contract)
// ---------------------------------------------------------------------------
// PRD §10 budgets the search across the shake (>=250ms, usually ~1s) plus the
// idle time between turns. This is the thing that spends that budget: it keeps a
// small pool per pose per lane, tops up the thinnest pool whenever the game
// hands it a slice of idle time, and hands out a ready-made recording the
// instant the toss is released.
export class TrajectoryCache {
  constructor(sim = new PigSim(), opts = {}) {
    this.sim = sim;
    this.perPose = opts.perPose ?? 2;      // per pose PER LANE (SPEC: >=2 each)
    this.oinkerPool = opts.oinkerPool ?? 1;
    this.rng = opts.rng ?? Math.random;
    this.minConfidence = opts.minConfidence ?? 0.12;
    // sims per prefill attempt, so one idle slice can never overrun its budget
    // by more than one short search
    this.chunkSims = opts.chunkSims ?? 24;
    // a cache miss searches the full gated budget rather than settling for the
    // §6.3 fallback early — it runs during the shake, which covers ~1s of it
    this.takeSims = opts.takeSims ?? 800;
    this.oinkerSims = opts.oinkerSims ?? 3000;
    this.pools = {};
    for (const k of POSE_KEYS) this.pools[k] = { '-1': [], 1: [] };
    this.oinkers = [];
    this.onRefill = opts.onRefill ?? null;
    this.needsRefill = true;
    this.stats = { searched: 0, mirrored: 0, hits: 0, misses: 0, fallbacks: 0, sims: 0 };
  }

  count(pose, side) { return this.pools[pose][side < 0 ? '-1' : 1].length; }

  /**
   * The (pose, lane) pool that most needs a recording, or 'oinker' once every
   * pose pool is full, or null when there is nothing left to do. Poses come
   * first: an Oinker is drawn at P=.0038 and its joint search is cheap (tens of
   * sims), so it is the lowest-priority thing to hold in reserve.
   */
  neediest() {
    let worst = null, n = Infinity;
    for (const k of POSE_KEYS) for (const side of [-1, 1]) {
      const c = this.count(k, side);
      if (c < n) { n = c; worst = { pose: k, side }; }
    }
    if (n < this.perPose) return worst;
    if (this.oinkers.length < this.oinkerPool) return { oinker: true };
    return null;
  }

  /**
   * take() pops from a pool, which leaves it thin — so it asks for a refill.
   * The cache never searches on a timer of its own: the game owns the clock and
   * calls prefill(budgetMs) from idle time / the next shake (PRD §10), so wire
   * `onRefill` to a requestIdleCallback and the pools stay topped up without
   * ever competing with a frame.
   */
  _requestRefill() {
    this.needsRefill = this.neediest() !== null;
    if (this.needsRefill && this.onRefill) this.onRefill(this);
  }

  /** File a recording, plus its mirror if the mirror survives verification. */
  add(rec) {
    if (!rec || !rec.settledPose) return 0;
    if (rec.side !== -1 && rec.side !== 1) {
      // a recording with no half would be replayed against a pig that does have
      // one, and the two could end up occupying the same space on screen
      throw new Error('TrajectoryCache.add: recording has no half (side must be -1 or 1)');
    }
    this.pools[rec.settledPose][rec.side < 0 ? '-1' : 1].push(rec);
    let n = 1;
    const m = mirrorRecording(rec);
    if (m.settledPose && verifyRecording(m, { cloud: this.sim.cloud, minConfidence: this.minConfidence }).ok) {
      this.pools[m.settledPose][m.side < 0 ? '-1' : 1].push(m);
      this.stats.mirrored++;
      n++;
    }
    return n;
  }

  /** Spend up to budgetMs of idle/shake time filling the thinnest pools. */
  prefill(budgetMs = 40) {
    const t0 = now();
    let found = 0;
    while (now() - t0 < budgetMs) {
      const want = this.neediest();
      if (!want) break;
      this.stats.searched++;
      if (want.oinker) {
        const pair = this.sim.findOinker({ maxSims: this.chunkSims, rng: this.rng });
        if (pair) { this.stats.sims += pair.sims; this.oinkers.push(pair); found++; }
        continue;
      }
      const rec = this.sim.findRecording(want.pose, {
        maxSims: this.chunkSims, rng: this.rng, side: want.side,
        minConfidence: this.minConfidence,
      });
      if (rec) { this.stats.sims += rec.sims; found += this.add(rec); }
    }
    this.needsRefill = this.neediest() !== null;
    return found;
  }

  /**
   * take(targetPose, side) — the game's hot path. Never returns null and never
   * blocks for long: pool hit, else a mirror of the other lane, else a bounded
   * search, else (PRD §6.3) the nearest achievable pose with a dev warning.
   */
  take(targetPose, side = -1) {
    const key = side < 0 ? '-1' : 1;
    const pool = this.pools[targetPose][key];
    if (pool.length) {
      const hit = pool.pop();
      this.stats.hits++;
      this._requestRefill();
      return hit;
    }
    // the other lane's pool can often be reflected into this one for free
    const other = this.pools[MIRROR_POSE[targetPose]][side < 0 ? 1 : '-1'];
    for (let i = other.length - 1; i >= 0; i--) {
      const m = mirrorRecording(other[i]);
      if (m.settledPose === targetPose
        && verifyRecording(m, { cloud: this.sim.cloud, minConfidence: this.minConfidence }).ok) {
        other.splice(i, 1);
        this.stats.hits++; this.stats.mirrored++;
        this._requestRefill();
        return m;
      }
    }
    this.stats.misses++;
    const rec = this.sim.findRecording(targetPose, {
      maxSims: this.takeSims, rng: this.rng, side, minConfidence: this.minConfidence,
      allowFallback: true,
    });
    if (rec) this.stats.sims += rec.sims;
    if (rec?.fallbackFrom) {
      this.stats.fallbacks++;
      console.warn(`[hogwild] trajectory search missed ${targetPose}; replaying a real ${rec.settledPose} instead`);
    }
    this._requestRefill();
    return rec;
  }

  takeOinker() {
    if (this.oinkers.length) {
      const hit = this.oinkers.pop();
      this.stats.hits++;
      this._requestRefill();
      return hit;
    }
    this.stats.misses++;
    const pair = this.sim.findOinker({ maxSims: this.oinkerSims, rng: this.rng });
    this._requestRefill();
    return pair;
  }

  /** Total recordings held, for dev readouts. */
  size() {
    let n = this.oinkers.length;
    for (const k of POSE_KEYS) n += this.count(k, -1) + this.count(k, 1);
    return n;
  }
}

export default {
  PigSim, TrajectoryCache, BOARD, POSE_UP, classify, buildPigBody,
  randomToss, mirrorRecording, verifyRecording, withinHalf, withinBoard, boardZone,
};
