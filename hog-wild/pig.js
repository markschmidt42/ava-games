/* =========================================================================
 * pig.js — Hog Wild 3D: the visual pig, the felt pen, and the scene rig.
 *
 * SPEC.md contract:
 *   buildPig({dot})   → THREE.Group, 1 unit = 1 pen-metre, body length ≈ 1.0,
 *                       ORIGIN AT THE COLLIDER COM, +Z = snout, +Y = up when
 *                       trotting. Recording quaternions from physics.js apply
 *                       directly to this group.
 *   buildPen()        → floor + felt + walls group
 *   buildScene(canvas)→ { renderer, scene, camera, lights, ... } handles
 *
 * Geometry policy (SPEC.md "Geometry realism"): every placement below is
 * DERIVED from physics.js `makeParts(PIG_TUNING)` — part positions, rotations
 * and half-extents are read by name, and the whole pig is shifted by the
 * collider's centre of mass. If the physics agent retunes a leg lean or an ear
 * sweep, the visual pig follows it without an edit here.
 *
 * Look policy: stylised chunky rubber toy (Monument Valley / Nintendo bar).
 * Everything smooth: the pig is built from swept superellipse surfaces with
 * welded seams and computed smooth normals — there is not a single hard-edged
 * primitive in it. Painted details (sleepy eye, flank dot, blush, belly
 * lightening) live in one procedural CanvasTexture; the snout dimples, hooves
 * and ear tips are vertex-coloured, so the whole pig is ONE mesh, ONE material.
 * ==================================================================== */

import * as THREE from 'three';
import { PIG_TUNING, makeParts, pigMassProperties, PEN } from './physics.js';

const D2R = Math.PI / 180;
const HAS_DOM = typeof document !== 'undefined';

/* ---------------------------------------------------------------- palette */

export const PALETTE = {
  skin: '#f0a3b5',
  skinLight: '#fbd0d9',
  skinDeep: '#d97e97',
  skinShade: '#c56b85',
  snout: '#f0899f',
  snoutDeep: '#d76c88',
  hoof: '#ad3a63',
  nostril: '#7d2846',
  eye: '#2a1d24',
  dot: '#2b2026',
  blush: '#ef7f9c',
  felt1: '#2f6b52',
  felt2: '#245240',
  feltEdge: '#173a2c',
  bg1: '#14231c',
  bg2: '#0d1712',
};

/* ------------------------------------------------------------ math helpers */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
/** cheap deterministic hash noise, used for the hand-sculpted wobble */
function hash3(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Non-uniform Catmull-Rom (Hermite with finite-difference tangents) over a
 * list of keys sorted by `.z`. Used for the body's radius / centre profiles so
 * the silhouette is C1 smooth instead of a chain of straight tapers.
 */
function splineAt(keys, field, z) {
  const n = keys.length;
  if (z <= keys[0].z) return keys[0][field];
  if (z >= keys[n - 1].z) return keys[n - 1][field];
  let i = 0;
  while (i < n - 2 && keys[i + 1].z < z) i++;
  const k1 = keys[i], k2 = keys[i + 1];
  const h = k2.z - k1.z;
  const t = (z - k1.z) / h;
  const k0 = keys[i - 1] || k1, k3 = keys[i + 2] || k2;
  const m1 = (k2[field] - k0[field]) / Math.max(1e-6, k2.z - k0.z);
  const m2 = (k3[field] - k1[field]) / Math.max(1e-6, k3.z - k1.z);
  const t2 = t * t, t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * k1[field] +
    (t3 - 2 * t2 + t) * h * m1 +
    (-2 * t3 + 3 * t2) * k2[field] +
    (t3 - t2) * h * m2
  );
}

/** Point on a superellipse |x/rx|^n + |y/ry|^n = 1 at ring angle `theta`.
 *  theta = 0 is straight DOWN (−ey), sweeping toward +ex. */
function sePoint(theta, rx, ry, n) {
  if (rx <= 1e-7 || ry <= 1e-7) return [0, 0];
  const dx = Math.sin(theta), dy = -Math.cos(theta);
  if (n > 1.999 && n < 2.001) {
    const k = 1 / Math.hypot(dx / rx, dy / ry);
    return [k * dx, k * dy];
  }
  const k = Math.pow(
    Math.pow(Math.abs(dx) / rx, n) + Math.pow(Math.abs(dy) / ry, n),
    -1 / n,
  );
  return [k * dx, k * dy];
}

/** Ramanujan ellipse perimeter — used to keep painted details circular. */
function ellipsePerimeter(a, b) {
  const h = 3 * ((a - b) * (a - b)) / ((a + b) * (a + b));
  return Math.PI * (a + b) * (1 + h / (10 + Math.sqrt(4 - h)));
}

/* -------------------------------------------------- generic swept surface */

/**
 * Sweep a superellipse cross-section along a list of samples.
 *
 * sample = { c:[x,y,z] centre, ex:[..] cross-section +X, ey:[..] cross-section
 *            +Y, rx, ry, n }
 * INVARIANT: the sweep direction (c[i+1] − c[i]) must equal ex × ey, otherwise
 * the triangles wind inside-out.
 *
 * Returns flat arrays plus `weld`: groups of vertex indices that occupy the
 * same point (the u seam column and any collapsed pole ring). Averaging their
 * normals after computeVertexNormals is what keeps the shading seamless.
 */
function sweep(samples, radial) {
  const rings = samples.length, cols = radial + 1;
  const count = rings * cols;
  const position = new Float32Array(count * 3);
  const st = new Float32Array(count * 2);
  const index = [];
  const weld = [];
  for (let i = 0; i < rings; i++) {
    const s = samples[i];
    const c = s.c, ex = s.ex, ey = s.ey;
    const n = s.n === undefined ? 2 : s.n;
    const collapsed = s.rx <= 1e-7 || s.ry <= 1e-7;
    const group = collapsed ? [] : null;
    for (let j = 0; j < cols; j++) {
      const th = (2 * Math.PI * j) / radial;
      const p = sePoint(th, s.rx, s.ry, n);
      const o = i * cols + j;
      position[o * 3] = c[0] + p[0] * ex[0] + p[1] * ey[0];
      position[o * 3 + 1] = c[1] + p[0] * ex[1] + p[1] * ey[1];
      position[o * 3 + 2] = c[2] + p[0] * ex[2] + p[1] * ey[2];
      st[o * 2] = j / radial;
      st[o * 2 + 1] = rings > 1 ? i / (rings - 1) : 0;
      if (group) group.push(o);
    }
    if (group) weld.push(group);
    else weld.push([i * cols, i * cols + radial]);
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      index.push(a, d, c, a, b, d);
    }
  }
  return { position, st, index, weld };
}

/** Accumulates swept pieces into one interleaved, welded BufferGeometry. */
class Builder {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.weld = [];
    this._v = new THREE.Vector3();
  }

  /**
   * @param piece  output of sweep()
   * @param o.matrix  THREE.Matrix4 applied after `warp`
   * @param o.warp    (p:[x,y,z], u, v) => void — mutate in the piece's own frame
   * @param o.uv      [u,v] constant override (limbs point at a blank texel)
   * @param o.color   (u, v, p) => [r,g,b] in the working (linear) space
   * @param o.mirrorX mirror across x=0 (winding is flipped to compensate), so
   *                  a mirrored part is an EXACT reflection of its twin
   */
  add(piece, o = {}) {
    const base = this.pos.length / 3;
    const { position, st, index, weld } = piece;
    const n = position.length / 3;
    const p = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      p[0] = position[i * 3]; p[1] = position[i * 3 + 1]; p[2] = position[i * 3 + 2];
      const u = st[i * 2], v = st[i * 2 + 1];
      if (o.warp) o.warp(p, u, v);
      if (o.matrix) {
        this._v.set(p[0], p[1], p[2]).applyMatrix4(o.matrix);
        p[0] = this._v.x; p[1] = this._v.y; p[2] = this._v.z;
      }
      if (o.mirrorX) p[0] = -p[0];
      this.pos.push(p[0], p[1], p[2]);
      if (o.uv) this.uv.push(o.uv[0], o.uv[1]);
      else this.uv.push(u, v);
      const c = o.color ? o.color(u, v, p) : WHITE;
      this.col.push(c[0], c[1], c[2]);
    }
    if (o.mirrorX) {
      for (let i = 0; i < index.length; i += 3) {
        this.idx.push(index[i] + base, index[i + 2] + base, index[i + 1] + base);
      }
    } else {
      for (let i = 0; i < index.length; i++) this.idx.push(index[i] + base);
    }
    for (const g of weld) this.weld.push(g.map((k) => k + base));
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    // weld coincident vertices' normals so the u-seam and the poles vanish
    const nm = g.getAttribute('normal');
    for (const grp of this.weld) {
      let x = 0, y = 0, z = 0;
      for (const i of grp) { x += nm.getX(i); y += nm.getY(i); z += nm.getZ(i); }
      const l = Math.hypot(x, y, z) || 1;
      x /= l; y /= l; z /= l;
      for (const i of grp) nm.setXYZ(i, x, y, z);
    }
    nm.needsUpdate = true;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const WHITE = [1, 1, 1];
const linear = (hex) => new THREE.Color(hex).toArray(); // Color() already sRGB→linear
function mixLin(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/* ================================================================= the pig
 * All numbers below live in the collider BUILD frame (y = 0 is the floor when
 * the pig trots, +Z is the snout). The finished geometry is translated by
 * −COM at the very end so the group origin matches the physics body.
 * ==================================================================== */

const T = PIG_TUNING;
const PARTS = makeParts(T);
const P = Object.fromEntries(PARTS.map((p) => [p.name, p]));
const COM = pigMassProperties(PARTS).com;

const BODY_RADIAL = 48;
const LIMB_RADIAL = 18;
const BLANK_UV = [0.5, 0.982];   // the texture's reserved pure-white strip
const BODY_V_MAX = 0.94;         // body owns v ∈ [0, 0.94]

// anchors read off the collider so the silhouettes can't drift apart
const zTorsoBack = P.torso.pos[2] - P.torso.he[2];
const zTorsoFront = P.torso.pos[2] + P.torso.he[2];
const zHeadFront = P.head.pos[2] + P.head.he[2];
const yTorso = P.torso.pos[1];
const yHead = P.head.pos[1];
const yRidgeTop = P.ridge.pos[1] + P.ridge.he[1];   // razorback contact height
const zRidge0 = P.ridge.pos[2] - P.ridge.he[2];
const zRidge1 = P.ridge.pos[2] + P.ridge.he[2];

/** rump → torso → shoulder → head → muzzle root, one continuous profile */
const BODY_KEYS = [
  { z: zTorsoBack - 0.115, rx: 0.000, ry: 0.000, yc: yTorso + 0.014, n: 2.00 },
  { z: zTorsoBack - 0.096, rx: 0.056, ry: 0.062, yc: yTorso + 0.012, n: 2.00 },
  { z: zTorsoBack - 0.066, rx: 0.118, ry: 0.134, yc: yTorso + 0.008, n: 2.12 },
  { z: zTorsoBack - 0.030, rx: 0.153, ry: 0.177, yc: yTorso + 0.004, n: 2.32 },
  { z: zTorsoBack + 0.016, rx: 0.163, ry: 0.192, yc: yTorso + 0.001, n: 2.55 },
  { z: zTorsoBack + 0.100, rx: 0.170, ry: 0.200, yc: yTorso - 0.001, n: 2.72 },
  { z: P.torso.pos[2],     rx: 0.170, ry: 0.201, yc: yTorso - 0.001, n: 2.78 },
  { z: zTorsoFront - 0.13, rx: 0.167, ry: 0.198, yc: yTorso + 0.000, n: 2.72 },
  { z: zTorsoFront - 0.055, rx: 0.156, ry: 0.186, yc: yTorso - 0.002, n: 2.55 },
  { z: zTorsoFront + 0.000, rx: 0.148, ry: 0.176, yc: yTorso - 0.006, n: 2.42 },
  { z: 0.190,              rx: 0.126, ry: 0.151, yc: yHead + 0.008, n: 2.26 },
  { z: P.head.pos[2],      rx: 0.131, ry: 0.154, yc: yHead + 0.000, n: 2.20 },
  { z: 0.296,              rx: 0.124, ry: 0.144, yc: yHead - 0.007, n: 2.12 },
  { z: zHeadFront - 0.015, rx: 0.107, ry: 0.121, yc: yHead - 0.014, n: 2.05 },
  { z: zHeadFront + 0.015, rx: 0.084, ry: 0.094, yc: yHead - 0.020, n: 2.00 },
  { z: zHeadFront + 0.035, rx: 0.050, ry: 0.056, yc: yHead - 0.024, n: 2.00 },
  { z: zHeadFront + 0.046, rx: 0.000, ry: 0.000, yc: yHead - 0.026, n: 2.00 },
];

/** ring z values: ~13 mm apart, denser where the profile turns hard */
function bodyRingZs() {
  const zs = [];
  for (let i = 0; i < BODY_KEYS.length - 1; i++) {
    const a = BODY_KEYS[i].z, b = BODY_KEYS[i + 1].z;
    const steps = Math.max(2, Math.round((b - a) / 0.0135));
    for (let k = 0; k < steps; k++) zs.push(lerp(a, b, k / steps));
  }
  zs.push(BODY_KEYS[BODY_KEYS.length - 1].z);
  return zs;
}
const BODY_ZS = bodyRingZs();

const EX = [1, 0, 0], EY = [0, 1, 0];
function bodySamples() {
  return BODY_ZS.map((z) => ({
    c: [0, splineAt(BODY_KEYS, 'yc', z), z],
    ex: EX, ey: EY,
    rx: Math.max(0, splineAt(BODY_KEYS, 'rx', z)),
    ry: Math.max(0, splineAt(BODY_KEYS, 'ry', z)),
    n: splineAt(BODY_KEYS, 'n', z),
  }));
}

/** v (texture) ↔ z (body) — the painter needs both directions. */
function vOfZ(z) {
  const n = BODY_ZS.length;
  if (z <= BODY_ZS[0]) return 0;
  if (z >= BODY_ZS[n - 1]) return BODY_V_MAX;
  let i = 0;
  while (i < n - 2 && BODY_ZS[i + 1] < z) i++;
  const t = (z - BODY_ZS[i]) / (BODY_ZS[i + 1] - BODY_ZS[i]);
  return ((i + t) / (n - 1)) * BODY_V_MAX;
}
function dvdz(z) {
  const h = 0.01;
  return (vOfZ(z + h) - vOfZ(z - h)) / (2 * h);
}

/** The razorback crest. The collider's ridge tops out `yRidgeTop` above the
 *  floor, well above the rounded back, so the visual needs a real spine ridge
 *  or the pig would hover in the razorback rest. */
const CREST_H = yRidgeTop - (yTorso + 0.201);
function crest(p, u) {
  const z = p[2];
  const zf = smoothstep(zRidge0 - 0.055, zRidge0 + 0.045, z) *
             (1 - smoothstep(zRidge1 - 0.03, zRidge1 + 0.10, z));
  if (zf <= 0) return 0;
  const th = u * Math.PI * 2;
  const off = Math.abs(th - Math.PI);
  const af = 1 - smoothstep(0.13, 0.44, off);
  return CREST_H * zf * af;
}

/** tiny low-frequency irregularity — hand-sculpted-toy feel, not noise */
function wobble(p, u, v) {
  const a = Math.sin(u * Math.PI * 6 + 1.7) * Math.sin(v * Math.PI * 3.4);
  const b = Math.sin(u * Math.PI * 2 - 0.4) * Math.sin(v * Math.PI * 7.1 + 2.1);
  return 0.0022 * a + 0.0014 * b;
}

/* ------------------------------------------------------------------ snout */

const snoutTiltRad = (90 - T.snoutTilt) * D2R;
const SN_AXIS = [0, Math.cos(snoutTiltRad), Math.sin(snoutTiltRad)];
const SN_EX = [1, 0, 0];
// ex × ey must equal the sweep direction ⇒ ey = (0, sin, −cos)
const SN_EY = [0, SN_AXIS[2], -SN_AXIS[1]];
const SN_C = P.snout.pos;
const SN_TIP = P.snout.h / 2;

function snoutSamples() {
  const prof = [
    [-0.140, 0.048], [-0.118, 0.066], [-0.096, 0.080], [-0.070, 0.092],
    [-0.040, 0.1035], [-0.008, 0.1105], [0.020, 0.1145], [0.042, 0.1168],
  ];
  // rounded rim: quarter arc from the barrel onto the face
  const rimR = 0.0110, cs = SN_TIP - rimR, cr = 0.1168 - rimR;
  for (let k = 1; k <= 6; k++) {
    const a = (k * Math.PI) / 12;
    prof.push([cs + rimR * Math.sin(a), cr + rimR * Math.cos(a)]);
  }
  // the flat face, dished very slightly so it catches a highlight
  prof.push([SN_TIP, 0.1010], [SN_TIP + 0.0008, 0.088], [SN_TIP + 0.0006, 0.068],
            [SN_TIP - 0.0006, 0.046], [SN_TIP - 0.0020, 0.025],
            [SN_TIP - 0.0032, 0.010], [SN_TIP - 0.0038, 0.000]);
  return prof.map(([s, r]) => ({
    c: [SN_C[0] + SN_AXIS[0] * s, SN_C[1] + SN_AXIS[1] * s, SN_C[2] + SN_AXIS[2] * s],
    ex: SN_EX, ey: SN_EY, rx: r * 1.03, ry: r * 0.985, n: 2.15,
  }));
}

const FACE_C = [
  SN_C[0] + SN_AXIS[0] * SN_TIP,
  SN_C[1] + SN_AXIS[1] * SN_TIP,
  SN_C[2] + SN_AXIS[2] * SN_TIP,
];
// nostrils sit a little below the face centre, mirrored across x
const NOSTRIL = [-1, 1].map((s) => [
  FACE_C[0] + SN_EX[0] * 0.042 * s - SN_EY[0] * 0.024,
  FACE_C[1] + SN_EX[1] * 0.042 * s - SN_EY[1] * 0.024,
  FACE_C[2] + SN_EX[2] * 0.042 * s - SN_EY[2] * 0.024,
]);

/** how deep inside a nostril dimple a point is, 0..1 (elliptical falloff) */
function nostrilField(p) {
  let best = 0;
  for (const c of NOSTRIL) {
    const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
    const ax = dx;
    const ay = dy * SN_EY[1] + dz * SN_EY[2];
    const d = Math.hypot(ax / 0.020, ay / 0.028);
    best = Math.max(best, 1 - smoothstep(0.55, 1.0, d));
  }
  return best;
}

/* ------------------------------------------------------------------- limbs */

const LEG_KEYS = [
  [0.2560, 0.060], [0.2320, 0.0695], [0.2050, 0.0655], [0.1740, 0.0570],
  [0.1380, 0.0512], [0.1000, 0.0482], [0.0620, 0.0478], [0.0400, 0.0500],
  [0.0230, 0.0512], [0.0130, 0.0498], [0.0060, 0.0455], [0.0020, 0.0378],
  [0.0000, 0.0250], [0.0000, 0.0000],
];
const HOOF_TOP = 0.028;   // below this the leg is painted hoof
/* the collider's legs are splayed boxes, so their outer bottom corner dips
 * below y=0; the rounded visual hoof has to be dropped to meet it. */
const LEG_DROP = 0.0072;

function legSamples() {
  // swept along +Y ⇒ ex × ey = +Y ⇒ ey = (0,0,−1)
  return LEG_KEYS.map(([y, r]) => ({
    c: [0, y - LEG_DROP, 0], ex: [1, 0, 0], ey: [0, 0, -1],
    rx: r * 1.0, ry: r * 1.1, n: 2.15,
  }));
}

/**
 * A blunt, slightly drooping paddle ear. The tip reach is deliberately tuned
 * to land on the collider ear's outer corner: the side rests are propped on
 * that corner, so a shorter visual ear would leave the pig hovering.
 */
const EAR_KEYS = [
  [-0.132, 0.044, 0.019], [-0.104, 0.061, 0.0250], [-0.070, 0.072, 0.0280],
  [-0.030, 0.0765, 0.0285], [0.009, 0.0760, 0.0265], [0.044, 0.0705, 0.0222],
  [0.077, 0.0615, 0.0178], [0.103, 0.0500, 0.0136], [0.122, 0.0375, 0.0100],
  [0.135, 0.0225, 0.0066], [0.142, 0.0000, 0.0000],
];
function earSamples() {
  // swept along +X ⇒ ex × ey = +X ⇒ ex = (0,0,1), ey = (0,−1,0)
  return EAR_KEYS.map(([x, w, t]) => {
    const s = clamp((x + 0.05) / 0.20, 0, 1);
    return {
      c: [x, -0.0085 * s * s, -0.010 * s * s],
      ex: [0, 0, 1], ey: [0, -1, 0],
      rx: w, ry: t, n: 2.35,
    };
  });
}

/** part transform: collider pos/rot, with the piece's local origin moved to
 *  the part's local `originOffset` (legs are modelled hoof-at-origin). */
function partMatrix(part, originOffset = [0, 0, 0]) {
  const m = new THREE.Matrix4().makeTranslation(part.pos[0], part.pos[1], part.pos[2]);
  const e = new THREE.Euler(part.rot[0] * D2R, part.rot[1] * D2R, part.rot[2] * D2R, 'XYZ');
  m.multiply(new THREE.Matrix4().makeRotationFromEuler(e));
  m.multiply(new THREE.Matrix4().makeTranslation(-originOffset[0], -originOffset[1], -originOffset[2]));
  return m;
}

/* -------------------------------------------------------------------- tail */

function tailGeometry() {
  const y0 = P.tail.pos[1], z0 = P.tail.pos[2];
  const pts = [
    [0.000, y0 + 0.000, z0 - 0.006],
    [0.004, y0 + 0.010, z0 - 0.036],
    [0.030, y0 + 0.032, z0 - 0.055],
    [0.053, y0 + 0.064, z0 - 0.044],
    [0.044, y0 + 0.088, z0 - 0.014],
    [0.008, y0 + 0.092, z0 + 0.003],
    [-0.021, y0 + 0.076, z0 - 0.014],
    [-0.024, y0 + 0.054, z0 - 0.036],
  ].map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
  const tub = 46, rad = 8;
  const geo = new THREE.TubeGeometry(curve, tub, 0.0245, rad, false);
  // taper: pull each ring toward the spine (TubeGeometry is constant radius)
  const pos = geo.getAttribute('position');
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= tub; i++) {
    const t = i / tub;
    const k = lerp(1.0, 0.36, Math.pow(t, 0.85));
    curve.getPointAt(t, c);
    for (let j = 0; j <= rad; j++) {
      const o = i * (rad + 1) + j;
      v.fromBufferAttribute(pos, o).sub(c).multiplyScalar(k).add(c);
      pos.setXYZ(o, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return { geo, tub, rad };
}

/* ------------------------------------------------- the painted skin texture */

let TEX_CACHE = null;
function skinTexture(dot) {
  if (!HAS_DOM) return null;
  TEX_CACHE = TEX_CACHE || {};
  const key = dot ? 'dot' : 'blank';
  if (TEX_CACHE[key]) return TEX_CACHE[key];

  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // reserved strip (v > 0.95) stays pure white: limbs sample it and get their
  // colour from vertex colours instead
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const bodyH = BODY_V_MAX * H;

  // 1. around-the-body tone: light belly, deeper back
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0.00, PALETTE.skinLight);
  g.addColorStop(0.13, PALETTE.skinLight);
  g.addColorStop(0.26, PALETTE.skin);
  g.addColorStop(0.42, PALETTE.skinDeep);
  g.addColorStop(0.50, PALETTE.skinDeep);
  g.addColorStop(0.58, PALETTE.skinDeep);
  g.addColorStop(0.74, PALETTE.skin);
  g.addColorStop(0.87, PALETTE.skinLight);
  g.addColorStop(1.00, PALETTE.skinLight);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, bodyH);

  // 2. along-the-body tone: warmer toward the muzzle, cooler at the rump
  const g2 = ctx.createLinearGradient(0, 0, 0, bodyH);
  g2.addColorStop(0.00, 'rgba(150,90,110,0.16)');
  g2.addColorStop(0.16, 'rgba(150,90,110,0.03)');
  g2.addColorStop(0.62, 'rgba(255,255,255,0.00)');
  g2.addColorStop(0.88, 'rgba(238,140,164,0.30)');
  g2.addColorStop(1.00, 'rgba(226,120,148,0.55)');
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, W, bodyH);

  /** draw in world units on a flank: X = forward (+z), Y = down */
  const flank = (u, z, side, draw) => {
    const rx = Math.max(0.02, splineAt(BODY_KEYS, 'rx', z));
    const ry = Math.max(0.02, splineAt(BODY_KEYS, 'ry', z));
    const su = W / ellipsePerimeter(rx, ry);
    const sv = dvdz(z) * H;
    ctx.save();
    ctx.transform(0, sv, side > 0 ? -su : su, 0, u * W, vOfZ(z) * H);
    draw(ctx);
    ctx.restore();
  };

  const soft = (c, r, a) => {
    const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    rg.addColorStop(0, c.replace('ALPHA', a));
    rg.addColorStop(0.55, c.replace('ALPHA', a * 0.55));
    rg.addColorStop(1, c.replace('ALPHA', 0));
    return rg;
  };

  // 3. cheek blush + a soft shadow where each leg meets the belly
  for (const side of [1, -1]) {
    const u = side > 0 ? 0.25 : 0.75;
    flank(u, 0.285, side, (c) => {
      c.fillStyle = soft('rgba(236,116,146,ALPHA)', 0.085, 0.5);
      c.beginPath(); c.arc(0.02, 0.03, 0.085, 0, 7); c.fill();
    });
    for (const z of [P.legFL.pos[2], P.legBL.pos[2]]) {
      flank(side > 0 ? 0.185 : 0.815, z, side, (c) => {
        c.fillStyle = soft('rgba(158,84,106,ALPHA)', 0.070, 0.22);
        c.beginPath(); c.arc(0, -0.02, 0.070, 0, 7); c.fill();
      });
    }
  }

  // 4. the mould seam, whisper faint — it is what makes it read as a toy
  ctx.strokeStyle = 'rgba(120,64,84,0.055)';
  ctx.lineWidth = 1.6;
  for (const u of [0.25, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(u * W, vOfZ(zTorsoBack - 0.07) * H);
    for (let z = zTorsoBack - 0.07; z <= zHeadFront; z += 0.02) {
      ctx.lineTo(u * W + Math.sin(z * 9) * 2.5, vOfZ(z) * H);
    }
    ctx.stroke();
  }

  // 5. the sleepy eye — a heavy upper lid, a lens of dark, one wet highlight
  for (const side of [1, -1]) {
    flank(side > 0 ? 0.315 : 0.685, 0.286, side, (c) => {
      const w = 0.088, h = 0.076;
      // socket
      c.fillStyle = soft('rgba(186,102,128,ALPHA)', 0.075, 0.42);
      c.beginPath(); c.arc(0, 0, 0.075, 0, 7); c.fill();
      // eye
      c.fillStyle = PALETTE.eye;
      c.beginPath();
      c.moveTo(-w * 0.5, 0.002);
      c.bezierCurveTo(-w * 0.28, -h * 0.62, w * 0.30, -h * 0.68, w * 0.5, -0.004);
      c.bezierCurveTo(w * 0.30, h * 0.36, -w * 0.28, h * 0.34, -w * 0.5, 0.002);
      c.closePath(); c.fill();
      // sleepy lid: a soft skin-coloured wedge over the top third
      c.fillStyle = 'rgba(226,140,163,0.94)';
      c.beginPath();
      c.moveTo(-w * 0.52, -h * 0.05);
      c.bezierCurveTo(-w * 0.30, -h * 0.72, w * 0.32, -h * 0.78, w * 0.52, -h * 0.08);
      c.bezierCurveTo(w * 0.30, -h * 0.30, -w * 0.30, -h * 0.28, -w * 0.52, -h * 0.05);
      c.closePath(); c.fill();
      // lash line
      c.strokeStyle = 'rgba(120,58,78,0.55)';
      c.lineWidth = 0.008;
      c.beginPath();
      c.moveTo(-w * 0.46, -h * 0.06);
      c.bezierCurveTo(-w * 0.24, -h * 0.42, w * 0.26, -h * 0.44, w * 0.48, -h * 0.02);
      c.stroke();
      // highlight
      c.fillStyle = 'rgba(255,255,255,0.72)';
      c.beginPath(); c.ellipse(w * 0.15, h * 0.06, 0.011, 0.008, 0, 0, 7); c.fill();
    });
  }

  // 6. the flank dot — only on one pig, on the −X flank so that POSE_UP
  //    'side-dot' (−X facing world up) really does show the dot
  if (dot) {
    flank(0.715, P.torso.pos[2] + 0.055, -1, (c) => {
      const r = 0.039;
      c.fillStyle = soft('rgba(120,60,80,ALPHA)', r * 1.5, 0.22);
      c.beginPath(); c.arc(0, 0, r * 1.5, 0, 7); c.fill();
      const rg = c.createRadialGradient(-r * 0.25, -r * 0.3, 0, 0, 0, r);
      rg.addColorStop(0, '#3b2c34');
      rg.addColorStop(0.72, PALETTE.dot);
      rg.addColorStop(0.93, '#231a1f');
      rg.addColorStop(1, 'rgba(35,26,31,0)');
      c.fillStyle = rg;
      c.beginPath(); c.arc(0, 0, r, 0, 7); c.fill();
    });
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  TEX_CACHE[key] = tex;
  return tex;
}

/* ------------------------------------------------------- pig geometry cache */

/** The whole pig: one welded, smooth-normalled geometry, COM-centred. */
function buildPigGeometry() {
  const b = new Builder();
  const skin = linear(PALETTE.skin);
  const skinLight = linear(PALETTE.skinLight);
  const skinDeep = linear(PALETTE.skinDeep);
  const snoutC = linear(PALETTE.snout);
  const snoutDeep = linear(PALETTE.snoutDeep);
  const hoofC = linear(PALETTE.hoof);
  const nostrilC = linear(PALETTE.nostril);

  // ---- body (textured)
  b.add(sweep(bodySamples(), BODY_RADIAL), {
    warp: (p, u, v) => {
      p[1] += crest(p, u);
      const w = wobble(p, u, v);
      const l = Math.hypot(p[0], p[1] - splineAt(BODY_KEYS, 'yc', p[2])) || 1;
      p[0] += (p[0] / l) * w;
      p[1] += ((p[1] - splineAt(BODY_KEYS, 'yc', p[2])) / l) * w;
    },
  });

  // ---- snout (+ nostril dimples)
  b.add(sweep(snoutSamples(), 40), {
    uv: BLANK_UV,
    warp: (p) => {
      const f = nostrilField(p);
      if (f > 0) {
        const d = 0.018 * f;
        p[0] -= SN_AXIS[0] * d; p[1] -= SN_AXIS[1] * d; p[2] -= SN_AXIS[2] * d;
      }
    },
    color: (u, v, p) => {
      const base = mixLin(snoutDeep, snoutC, smoothstep(0.30, 0.85, v));
      return mixLin(base, nostrilC, nostrilField(p) * 0.9);
    },
  });

  // ---- legs, hoof tips darkened by the sample's own height
  const legY = LEG_KEYS.map((k) => k[0]);
  for (const name of ['legFL', 'legFR', 'legBL', 'legBR']) {
    const part = P[name];
    b.add(sweep(legSamples(), LIMB_RADIAL), {
      uv: BLANK_UV,
      matrix: partMatrix(part, [0, part.he[1], 0]),
      color: (u, v) => {
        const y = legY[Math.round(v * (legY.length - 1))];
        const h = 1 - smoothstep(HOOF_TOP - 0.012, HOOF_TOP + 0.014, y);
        const up = smoothstep(0.10, 0.24, y);
        return mixLin(mixLin(skin, skinLight, up * 0.35), hoofC, h);
      },
    });
  }

  // ---- ears. SPEC.md: both ears look symmetric, only the COLLIDER sweep
  // differs, so both visual ears are built from the +X collider ear and the
  // −X one is its exact reflection.
  const earMatrix = partMatrix(P.ear);
  const earColor = (u, v) => mixLin(skin, skinDeep, smoothstep(0.30, 1.0, v) * 0.9);
  b.add(sweep(earSamples(), LIMB_RADIAL), { uv: BLANK_UV, matrix: earMatrix, color: earColor });
  b.add(sweep(earSamples(), LIMB_RADIAL), { uv: BLANK_UV, matrix: earMatrix, color: earColor, mirrorX: true });

  const geo = b.toGeometry();

  // ---- tail (TubeGeometry along a helix), merged in by hand
  const { geo: tg, tub, rad } = tailGeometry();
  const merged = mergeInto(geo, tg, {
    uv: BLANK_UV,
    color: (i) => {
      const t = Math.floor(i / (rad + 1)) / tub;
      return mixLin(skin, skinDeep, smoothstep(0.45, 1.0, t) * 0.8);
    },
  });
  tg.dispose();

  merged.translate(-COM[0], -COM[1], -COM[2]);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** append `src` (position+normal indexed) onto `dst`, filling uv/color */
function mergeInto(dst, src, o) {
  const dp = dst.getAttribute('position'), dn = dst.getAttribute('normal');
  const du = dst.getAttribute('uv'), dc = dst.getAttribute('color');
  const sp = src.getAttribute('position'), sn = src.getAttribute('normal');
  const nDst = dp.count, nSrc = sp.count;
  const pos = new Float32Array((nDst + nSrc) * 3);
  const nor = new Float32Array((nDst + nSrc) * 3);
  const uv = new Float32Array((nDst + nSrc) * 2);
  const col = new Float32Array((nDst + nSrc) * 3);
  pos.set(dp.array.subarray(0, nDst * 3));
  nor.set(dn.array.subarray(0, nDst * 3));
  uv.set(du.array.subarray(0, nDst * 2));
  col.set(dc.array.subarray(0, nDst * 3));
  pos.set(sp.array.subarray(0, nSrc * 3), nDst * 3);
  nor.set(sn.array.subarray(0, nSrc * 3), nDst * 3);
  for (let i = 0; i < nSrc; i++) {
    uv[(nDst + i) * 2] = o.uv[0];
    uv[(nDst + i) * 2 + 1] = o.uv[1];
    const c = o.color(i);
    col[(nDst + i) * 3] = c[0];
    col[(nDst + i) * 3 + 1] = c[1];
    col[(nDst + i) * 3 + 2] = c[2];
  }
  const di = dst.getIndex().array, si = src.getIndex().array;
  const idx = new Uint32Array(di.length + si.length);
  idx.set(di);
  for (let i = 0; i < si.length; i++) idx[di.length + i] = si[i] + nDst;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  dst.dispose();
  return g;
}

let GEO = null;
const MATS = {};

function pigMaterial(dot) {
  const key = dot ? 'dot' : 'blank';
  if (MATS[key]) return MATS[key];
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: skinTexture(dot),
    vertexColors: true,
    roughness: 0.50,
    metalness: 0.0,
    sheen: 0.7,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0xffd3de),
    clearcoat: 0.16,
    clearcoatRoughness: 0.62,
    envMapIntensity: 0.55,
  });
  MATS[key] = m;
  return m;
}

/**
 * buildPig({dot}) — SPEC.md contract.
 * Origin = collider COM, +Z = snout, +Y = up when trotting, ~1 unit long.
 */
export function buildPig({ dot = false } = {}) {
  GEO = GEO || buildPigGeometry();
  const mesh = new THREE.Mesh(GEO, pigMaterial(dot));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'pig-mesh';
  const g = new THREE.Group();
  g.name = dot ? 'pig-dot' : 'pig-blank';
  g.add(mesh);
  g.userData = {
    dot,
    triangles: GEO.getIndex().count / 3,
    vertices: GEO.getAttribute('position').count,
  };
  return g;
}

/** triangle count of the shared pig geometry (dev/HUD helper) */
export function pigTriangles() {
  GEO = GEO || buildPigGeometry();
  return GEO.getIndex().count / 3;
}

/* ================================================================= the pen */

function noiseCanvas(size, c1, c2, opts = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  let s = 987654321;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  // low-frequency blotches: felt is never flat
  for (let i = 0; i < 160; i++) {
    const x = rnd() * size, y = rnd() * size, r = size * (0.03 + rnd() * 0.09);
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = rnd() > 0.5;
    rg.addColorStop(0, dark ? 'rgba(0,20,12,0.10)' : 'rgba(150,255,205,0.06)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 7);
    ctx.fill();
  }

  // per-pixel grain
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const amp = opts.grain === undefined ? 0.19 : opts.grain;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() + rnd() + rnd()) / 3 - 0.5;
    const k = 1 + n * amp;
    d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
  }
  ctx.putImageData(img, 0, 0);

  // fibres
  ctx.lineWidth = 1;
  for (let i = 0; i < (opts.fibres || 2600); i++) {
    const x = rnd() * size, y = rnd() * size;
    const a = rnd() * Math.PI * 2, l = 2 + rnd() * 7;
    ctx.strokeStyle = rnd() > 0.5 ? 'rgba(196,255,222,0.055)' : 'rgba(0,26,16,0.075)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }

  if (opts.vignette) {
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(1, size / size);
    const rg = ctx.createRadialGradient(0, 0, size * 0.30, 0, 0, size * 0.74);
    rg.addColorStop(0, 'rgba(10,32,24,0)');
    rg.addColorStop(0.62, 'rgba(10,32,24,0.16)');
    rg.addColorStop(1, 'rgba(6,22,16,0.60)');
    ctx.fillStyle = rg;
    ctx.fillRect(-size, -size, size * 2, size * 2);
    ctx.restore();
    // a soft warm pool in the middle, so the pen has a stage
    const rg2 = ctx.createRadialGradient(size / 2, size * 0.42, 0, size / 2, size * 0.42, size * 0.5);
    rg2.addColorStop(0, 'rgba(210,255,232,0.10)');
    rg2.addColorStop(1, 'rgba(210,255,232,0)');
    ctx.fillStyle = rg2;
    ctx.fillRect(0, 0, size, size);
  }
  return cv;
}

let FELT = null;
function feltTextures() {
  if (FELT || !HAS_DOM) return FELT;
  const floor = new THREE.CanvasTexture(
    noiseCanvas(1024, PALETTE.felt1, PALETTE.felt2, { vignette: true, fibres: 5200 }),
  );
  floor.colorSpace = THREE.SRGBColorSpace;
  floor.anisotropy = 8;

  const wall = new THREE.CanvasTexture(
    noiseCanvas(512, PALETTE.felt2, PALETTE.feltEdge, { fibres: 1800, grain: 0.16 }),
  );
  wall.colorSpace = THREE.SRGBColorSpace;
  wall.wrapS = wall.wrapT = THREE.RepeatWrapping;
  wall.repeat.set(9, 1.4);
  wall.anisotropy = 8;

  FELT = { floor, wall };
  return FELT;
}

/** rounded-rect centreline in XZ with outward normals, CCW seen from +Y */
function roundRectPath(hx, hz, r, cornerSegs, straightSegs) {
  const corners = [
    [hx - r, hz - r, 0], [-hx + r, hz - r, 90],
    [-hx + r, -hz + r, 180], [hx - r, -hz + r, 270],
  ];
  const pts = [];
  for (let k = 0; k < 4; k++) {
    const [cx, cz, a0] = corners[k];
    for (let i = 0; i <= cornerSegs; i++) {
      const a = (a0 + (90 * i) / cornerSegs) * D2R;
      const nx = Math.cos(a), nz = Math.sin(a);
      pts.push({ x: cx + r * nx, z: cz + r * nz, nx, nz });
    }
    const next = corners[(k + 1) % 4];
    const a1 = (a0 + 90) * D2R;
    const nx = Math.cos(a1), nz = Math.sin(a1);
    const ax = cx + r * nx, az = cz + r * nz;
    const bx = next[0] + r * nx, bz = next[1] + r * nz;
    for (let i = 1; i < straightSegs; i++) {
      const t = i / straightSegs;
      pts.push({ x: lerp(ax, bx, t), z: lerp(az, bz, t), nx, nz });
    }
  }
  return pts;
}

/** wall ring: rounded top cap, felt UVs, baked contact darkening */
function wallGeometry() {
  const t = 0.15;                        // half thickness (matches physics)
  const h = PEN.wallH;
  const capR = t;
  const prof = [
    [-t, 0], [-t, h * 0.22], [-t, h * 0.46], [-t, h - capR],
  ];
  for (let k = 1; k <= 8; k++) {
    const a = (k * Math.PI) / 8;
    prof.push([-capR * Math.cos(a), h - capR + capR * Math.sin(a)]);
  }
  prof.push([t, h * 0.46], [t, h * 0.20], [t, 0]);

  const path = roundRectPath(PEN.w / 2 + t, PEN.d / 2 + t, 0.30, 6, 9);
  const np = path.length, nk = prof.length;

  // arc lengths for UVs
  const pl = [0];
  for (let i = 1; i <= np; i++) {
    const a = path[i - 1], b = path[i % np];
    pl.push(pl[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const kl = [0];
  for (let k = 1; k < nk; k++) {
    kl.push(kl[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]));
  }
  const totalP = pl[np], totalK = kl[nk - 1];

  const cols = np + 1;
  const pos = new Float32Array(cols * nk * 3);
  const uv = new Float32Array(cols * nk * 2);
  const col = new Float32Array(cols * nk * 3);
  const idx = [];
  const base = linear(PALETTE.felt2);
  const dark = linear('#0d251c');
  const top = linear('#3a7d60');
  for (let i = 0; i < cols; i++) {
    const p = path[i % np];
    for (let k = 0; k < nk; k++) {
      const [o, y] = prof[k];
      const q = (i * nk + k);
      pos[q * 3] = p.x + o * p.nx;
      pos[q * 3 + 1] = y;
      pos[q * 3 + 2] = p.z + o * p.nz;
      uv[q * 2] = pl[i] / totalP;
      uv[q * 2 + 1] = kl[k] / totalK;
      // contact darkening at the felt/floor join, gentle lift on the cap
      const ao = 1 - 0.55 * (1 - smoothstep(0.0, 0.26, y));
      let c = mixLin(dark, base, ao);
      c = mixLin(c, top, smoothstep(h - capR * 1.4, h, y) * 0.55);
      col[q * 3] = c[0]; col[q * 3 + 1] = c[1]; col[q * 3 + 2] = c[2];
    }
  }
  for (let i = 0; i < np; i++) {
    for (let k = 0; k < nk - 1; k++) {
      const a = i * nk + k, b = a + 1, c = a + nk, d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // weld the u seam
  const nm = g.getAttribute('normal');
  for (let k = 0; k < nk; k++) {
    const a = k, b = np * nk + k;
    const x = (nm.getX(a) + nm.getX(b)) / 2;
    const y = (nm.getY(a) + nm.getY(b)) / 2;
    const z = (nm.getZ(a) + nm.getZ(b)) / 2;
    const l = Math.hypot(x, y, z) || 1;
    nm.setXYZ(a, x / l, y / l, z / l);
    nm.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/** buildPen() — SPEC.md contract: floor + felt + walls group. */
export function buildPen() {
  const felt = feltTextures();
  const g = new THREE.Group();
  g.name = 'pen';

  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 46),
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(PALETTE.bg1),
      roughness: 0.92,
      metalness: 0,
      sheen: 0.12,
      sheenRoughness: 0.95,
      sheenColor: new THREE.Color(0x2b5f49),
      envMapIntensity: 0.14,
    }),
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.035;
  table.receiveShadow = true;
  table.name = 'table';
  g.add(table);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(PEN.w + 0.6, PEN.d + 0.6),
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: felt ? felt.floor : null,
      roughness: 0.95,
      metalness: 0,
      sheen: 0.24,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color(0x6fbf99),
      envMapIntensity: 0.26,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'felt';
  g.add(floor);

  const walls = new THREE.Mesh(
    wallGeometry(),
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: felt ? felt.wall : null,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      sheen: 0.3,
      sheenRoughness: 0.85,
      sheenColor: new THREE.Color(0x6fbf99),
      envMapIntensity: 0.26,
    }),
  );
  walls.castShadow = true;
  walls.receiveShadow = true;
  walls.name = 'walls';
  g.add(walls);

  return g;
}

/* =============================================================== the scene */

/**
 * A hand-built RoomEnvironment stand-in: a dark green box with a few emissive
 * panels, run through PMREMGenerator. Nothing is fetched — this is what gives
 * the rubber pig its soft wrap-around highlights.
 */
function roomEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const box = new THREE.BoxGeometry();
  box.deleteAttribute('uv');
  const env = new THREE.Scene();

  const room = new THREE.Mesh(
    box,
    new THREE.MeshStandardMaterial({ side: THREE.BackSide, color: 0x1d3b30, roughness: 1, metalness: 0 }),
  );
  room.scale.set(16, 9, 16);
  room.position.y = 2.6;
  env.add(room);

  const panel = (sx, sy, sz, x, y, z, r, g, b) => {
    const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial());
    m.material.color.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    env.add(m);
    return m;
  };
  panel(9, 0.1, 9, 0, 6.6, 0.5, 3.0, 3.1, 3.4);          // soft sky
  panel(0.1, 4.5, 7, 7.4, 3.4, 1.2, 5.0, 3.5, 2.4);      // warm key wall
  panel(0.1, 4.5, 7, -7.4, 2.9, -1.4, 1.1, 2.1, 3.4);    // cool fill wall
  panel(7, 3.2, 0.1, 0, 2.6, 7.4, 1.3, 1.7, 1.5);        // front bounce
  panel(7, 2.4, 0.1, 0, 3.4, -7.4, 1.6, 2.1, 2.3);       // back rim

  const pt = new THREE.PointLight(0xffffff, 6, 34, 2);
  pt.position.set(0, 4.4, 0);
  env.add(pt);

  const rt = pmrem.fromScene(env, 0.02, 0.1, 60);
  pmrem.dispose();
  box.dispose();
  room.material.dispose();
  return rt;
}

/** Tightest ortho shadow frustum that still contains `box`. */
function fitShadowCamera(light, box, pad = 0.12) {
  const zAxis = new THREE.Vector3().subVectors(light.position, light.target.position).normalize();
  const upRef = Math.abs(zAxis.y) > 0.98 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3().crossVectors(upRef, zAxis).normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
  const dir = zAxis.clone().negate();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minD = Infinity, maxD = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).sub(light.position);
    const x = v.dot(xAxis), y = v.dot(yAxis), d = v.dot(dir);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minD = Math.min(minD, d); maxD = Math.max(maxD, d);
  }
  const c = light.shadow.camera;
  c.left = minX - pad; c.right = maxX + pad;
  c.bottom = minY - pad; c.top = maxY + pad;
  c.near = Math.max(0.05, minD - pad);
  c.far = maxD + pad;
  c.updateProjectionMatrix();
}

const PEN_BOX = new THREE.Box3(
  new THREE.Vector3(-(PEN.w / 2 + 0.32), -0.05, -(PEN.d / 2 + 0.32)),
  new THREE.Vector3(PEN.w / 2 + 0.32, PEN.wallH + 0.05, PEN.d / 2 + 0.32),
);

/**
 * Distance-fit the camera so `box` fills the frame with `margin` to spare.
 * Called on every resize, which is what keeps the portrait framing honest on
 * phones as different as a SE and a Max.
 */
function frameBox(camera, box, { pitchDeg = 52, margin = 0.94, target } = {}) {
  const pitch = pitchDeg * D2R;
  const dir = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch));
  const tgt = target || new THREE.Vector3(0, PEN.wallH * 0.28, -0.1);
  const corners = [];
  for (let i = 0; i < 8; i++) {
    corners.push(new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ));
  }
  let dist = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 1.6;
  const v = new THREE.Vector3();
  for (let it = 0; it < 14; it++) {
    camera.position.copy(tgt).addScaledVector(dir, dist);
    camera.lookAt(tgt);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    let m = 0;
    for (const c of corners) {
      v.copy(c).project(camera);
      m = Math.max(m, Math.abs(v.x), Math.abs(v.y));
    }
    const s = m / margin;
    if (Math.abs(s - 1) < 0.0015) break;
    dist *= 1 + (s - 1) * 0.9;
  }
  camera.position.copy(tgt).addScaledVector(dir, dist);
  camera.lookAt(tgt);
  camera.updateMatrixWorld();
  return dist;
}

/**
 * buildScene(canvas) — SPEC.md contract.
 * @returns {{renderer, scene, camera, lights, env, resize, render, frame,
 *            setFocus, dispose, pitchDeg}}
 */
export function buildScene(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const envRT = roomEnvironment(renderer);
  scene.environment = envRT.texture;
  if ('environmentIntensity' in scene) scene.environmentIntensity = 0.40;

  const camera = new THREE.PerspectiveCamera(34, 1, 0.08, 80);

  const hemi = new THREE.HemisphereLight(0xcfe8f5, 0x24513f, 0.30);
  hemi.position.set(0, 6, 0);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff1de, 2.3);
  key.position.set(2.9, 6.4, 3.9);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 2.4;
  scene.add(key, key.target);
  fitShadowCamera(key, PEN_BOX);

  const rim = new THREE.DirectionalLight(0x8ccfff, 0.62);
  rim.position.set(-3.6, 3.0, -5.0);
  scene.add(rim);

  const bounce = new THREE.DirectionalLight(0xffd9e6, 0.16);
  bounce.position.set(-1.2, 1.0, 6.2);
  scene.add(bounce);

  const lights = { hemi, key, rim, bounce };

  let focus = PEN_BOX;
  let pitchDeg = 52;

  function resize(w, h) {
    const cw = w || canvas.clientWidth || canvas.width || 1;
    const ch = h || canvas.clientHeight || canvas.height || 1;
    renderer.setSize(cw, ch, false);
    camera.aspect = cw / ch;
    frameBox(camera, focus, { pitchDeg });
  }
  function frame(box, opts = {}) {
    if (box) focus = box;
    if (opts.pitchDeg !== undefined) pitchDeg = opts.pitchDeg;
    frameBox(camera, focus, { pitchDeg, ...opts });
  }
  function setFocus(box) { frame(box); }
  function render() { renderer.render(scene, camera); }

  const onResize = () => resize();
  if (typeof window !== 'undefined') window.addEventListener('resize', onResize);
  resize();

  function dispose() {
    if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
    envRT.dispose();
    renderer.dispose();
  }

  return {
    renderer, scene, camera, lights, env: envRT.texture,
    penBox: PEN_BOX, resize, render, frame, setFocus, dispose,
    get pitchDeg() { return pitchDeg; },
  };
}

/** Soft blob shadow, for when the real shadow map is too coarse under a pig.
 *  World-aligned: parent it to the scene, not to the pig group. */
export function buildContactShadow(radius = 0.42) {
  if (!HAS_DOM) return null;
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const rg = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  rg.addColorStop(0, 'rgba(0,0,0,0.5)');
  rg.addColorStop(0.5, 'rgba(0,0,0,0.24)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.85 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.004;
  m.name = 'contact-shadow';
  return m;
}

export default { buildPig, buildPen, buildScene, buildContactShadow, PALETTE, pigTriangles };
