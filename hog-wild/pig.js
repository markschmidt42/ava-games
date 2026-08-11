/* =========================================================================
 * pig.js — Hog Wild 3D: the visual pig, the felt pen, and the scene rig.
 *
 * SPEC.md contract:
 *   buildPig()        → THREE.Group, 1 unit = 1 board-metre, body length ≈ 1.0,
 *                       ORIGIN AT THE COLLIDER COM, +Z = snout, +Y = up when
 *                       trotting. Recording quaternions from physics.js apply
 *                       directly to this group. The two pigs are IDENTICAL and
 *                       both carry the black flank dot on their -X flank.
 *   buildBoard()      → the table + the three concentric felt zones (no walls)
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
 * primitive in it. Painted details (eyes, mouth, flank dot, blush, belly
 * lightening) live in one procedural CanvasTexture; the snout dimples, hooves
 * and ear tips are vertex-coloured, so the whole pig is ONE mesh, ONE material,
 * ONE draw call. The eight expressions from SPEC "Character & expressions" are
 * pre-rendered into a face atlas in that same texture and swapped by moving the
 * cheek patch's UVs — see "the expression atlas" below and setExpression().
 * ==================================================================== */

import * as THREE from 'three';
import { PIG_TUNING, makeParts, pigMassProperties, BOARD } from './physics.js';

const D2R = Math.PI / 180;
const HAS_DOM = typeof document !== 'undefined';

/* ---------------------------------------------------------------- palette */

export const PALETTE = {
  skin: '#f0a3b5',
  skinLight: '#fbd0d9',
  skinDeep: '#d97e97',
  // SPEC "Leg/hoof color": nothing on the pig may read brown. skinShade is the
  // deepest tone the body is allowed to reach and is kept firmly magenta so the
  // leg root (skin → skinShade → hoof) never lands in the tan/ochre corner.
  // MEASURED (round-1 review, readPixels on the shaded leg): the old #cd6f93
  // mixed at 45% into an unlit undercarriage rendered #ad757a / #37181a — a
  // dusty mauve that reads BROWN on screen. The fix is threefold and all three
  // parts matter: a lighter, more saturated shade here, a much gentler mix in
  // buildPigGeometry's leg ramp, and real fill light under the pig (buildScene's
  // `under` light + the brighter hemisphere ground).
  skinShade: '#e07fa4',
  snout: '#f78ba6',
  snoutDeep: '#e0708f',
  // The reference photos' trotters are a VIVID saturated pink that pops against
  // the pale body. ACES + the warm key desaturate and darken whatever goes in
  // here, so the source has to be pushed well past where it looks right in a
  // colour picker: #ad3a63 read brown, #e05a97 read dusty plum, and these two
  // are the first pair that render as unmistakable pink in scene light.
  hoof: '#ff62ac',
  hoofTip: '#f53d97',
  nostril: '#c2417a',
  eye: '#181016',       // the eye ink; INK.eye is this
  dot: '#0b0709',       // SPEC: the painted flank dot is BLACK
  blush: '#ff7ba0',
  felt1: '#2f6b52',
  felt2: '#245240',
  feltEdge: '#173a2c',
  bg1: '#14231c',
  bg2: '#0d1712',
  // The surface the board sits ON. It must NOT be bg1 — that is the page token
  // behind the canvas, and painting the table in it is what made the board float
  // in a void with no floor (round-1 review, "there is no world").
  //
  // ROUND-2 REVIEW, and this is the important half: the round-1 fix was made in
  // THIS OBJECT and never verified in pixels. readPixels on the shipped table
  // returned #1c2823 — luminance 36 against a page background of 31, i.e. still
  // a void — even though the hex here has luminance 72. The bug was not the
  // colour: every felt material set BOTH `color` and a `map` whose texture was
  // painted in that same colour, so the albedo was the tone SQUARED. Fixing the
  // double-multiply is what actually lit the table (see feltTextures/zoneDisc:
  // every disc now uses color 0xffffff and lets its own sheet carry the tone),
  // and these two are a shade lighter again so the surround reads as a lit table
  // in a room rather than as the darkest thing in frame.
  // MEASURED after the double-multiply fix, with readPixels on the shipped frame:
  // the cloth came out at luminance 132 against a green of 123, i.e. the surround
  // was BRIGHTER than the playing surface, which puts the eye in the wrong place.
  // These two are pulled back so the cloth lands around 100 — clearly a lit
  // surface (the page background behind the canvas is 31), clearly not the subject.
  // ROUND-3 REVIEW: "the cloth OUTSIDE the board is brighter than every part of
  // the board except its very centre, so the eye is pulled to the empty table …
  // the single brightest region in frame is empty tablecloth (L155) while the
  // board's own outer felt is L55." MEASURED before this change, radially along +X
  // at the shipped overview: cloth 113–127 against a rough of 84–99. The cloth is
  // the SURROUND: it has to sit below every zone of the board, which after the
  // zone re-tone below means landing near 90. (The page background behind the
  // canvas is 31, so 90 is still unmistakably a lit surface in a room.)
  table: '#264a3c',
  tableDeep: '#1e3a32',
  // The backdrop dome: a lit horizon at the bottom fading to night at the top,
  // so the reveal camera always has a wall behind the felt instead of a black band.
  sky: '#16302a',
  horizon: '#4d8471',
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

// anchors read off the collider so the silhouettes can't drift apart
const zTorsoBack = P.torso.pos[2] - P.torso.he[2];
const zTorsoFront = P.torso.pos[2] + P.torso.he[2];
const zHeadFront = P.head.pos[2] + P.head.he[2];
const yTorso = P.torso.pos[1];
const yHead = P.head.pos[1];
const yRidgeTop = P.ridge.pos[1] + P.ridge.he[1];   // razorback contact height
const zRidge0 = P.ridge.pos[2] - P.ridge.he[2];
const zRidge1 = P.ridge.pos[2] + P.ridge.he[2];

/**
 * The visual barrel is DEEPER than the collider's torso box, by BELLY_DROP.
 *
 * Two problems, one number. The belly is not a contact surface in ANY of the six
 * poses (razorback rests on the spine ridge, the Siders on a flank, the rest on
 * feet/snout/ear), so dropping it is geometrically free — and it fixes both of
 * the round-1 silhouette notes at once. It rounds the barrel into the fat
 * sausage the reference photos show instead of a loaf, and it swallows the top
 * third of every leg, which is what turns four long tapered tubes into the short
 * conical nubs the real pigs stand on (pigs-01, pigs-04). The BACK is pinned
 * exactly where it was — ry grows by half the drop and yc falls by the other
 * half — so the razorback crest still clears the rounded back by CREST_H.
 */
const BELLY_DROP = 0.040;
const TORSO_RY = 0.201 + BELLY_DROP / 2;
const yBarrel = yTorso - BELLY_DROP / 2;

/**
 * The dorsal ridge, and why it is 16 mm and not 54.
 *
 * ROUND-3 REVIEW: "The body is still a moulded slab with a bevel crease … the
 * torso is a flat-topped rounded BOX with a continuous specular crease line
 * running its full length along the top-side transition … capping the superellipse
 * n at 2.04 and broadening crest() did not remove the plateau or the shoulder."
 *
 * Correct, and round 2 was fixing the wrong term. `crest()` had to carry the
 * whole 54 mm between the barrel's round top and the collider's ridge — a 54 mm
 * step raised over a fixed angular window IS a plateau with a shoulder, and
 * broadening the window only widens the plateau and moves the shoulder to exactly
 * the top-side transition, which is where the review measured the crease. Height,
 * not width, was the problem.
 *
 * So the arc moved into the profile itself: `BACK_KEYS` below is the pig's back
 * line, a single convex curve that peaks at `yRidgeTop − CREST_H`, and the crest
 * is what is left over — a 16 mm spine hint. The razorback still lands on
 * `yRidgeTop` exactly (the grounding harness measures it), but now it lands on the
 * crown of a rounded back instead of on a mesa.
 */
const CREST_H = 0.016;
/* The crown sits a whisker PROUD of the collider's ridge, for the same reason
 * every other pose does (SPEC "Grounding must be measured": "errs toward
 * touching — a hoof pressed a few mm into felt is invisible, a gap of light under
 * it is not"). MEASURED with the grounding harness: at 0 the razorback floated
 * 2.4 mm; at 1.5 mm it lands at +0.9, which is exactly where the old mesa put it. */
const CREST_BITE = 0.0015;

/**
 * rump → torso → shoulder → head → muzzle root, one continuous profile.
 *
 * Written as a BACK line and a BELLY line rather than as centre+radius, because
 * every silhouette note the reviews have raised is about one of those two curves
 * and neither is legible as `yc ± ry`. `bodyKeys()` converts.
 *
 * `n` is the superellipse exponent of the ring: 2 is a true ellipse, and the
 * higher it goes the more the ring squares off. The round-1 review called the
 * back "a flat plateau with a crisp bevel crease running the full length down
 * each side" — that crease WAS this exponent, which used to reach 2.78 through
 * the torso. It is now essentially an ellipse everywhere (≤ 2.04), which is safe
 * because the Side rest's tangency is at theta = 90°, where the ring passes
 * through rx EXACTLY whatever n is: softening the corner rounds the barrel
 * without ever lifting the pig off its own flank.
 *
 * ROUND-3, the other two clauses of the silhouette note, both of them spacing:
 *
 *  - "a flat rear wall at the rump". The old rump held 96% of full width until
 *    30 mm from its very end and then collapsed — a cylinder with a cap. The taper
 *    now starts at the hip (z −0.29) and runs the whole way, so the ham is round.
 *  - "the head is still glued on … a separate smaller cylinder in front of that
 *    wall with a visible circular seam and no neck taper". There were two steps
 *    doing that: rx pinching 36 mm in 140 mm at the neck, and the BACK dropping
 *    41 mm over the same span, i.e. a shoulder wall. The waist is gentler (23 mm)
 *    and the back descends continuously from the crown through the neck onto the
 *    skull, so the head is the front of one egg rather than a bolted-on drum.
 *
 * MEASURED after, with the grounding harness (dev note in SPEC): all six poses
 * stay inside −5.4…+0.9 mm, and the razorback still touches at 0.0 mm.
 */
const BACK_TOP = yRidgeTop + CREST_BITE - CREST_H;   // the crown of the back
const BODY_PROFILE = [
  // z,      rx,     back,          belly
  [-0.500, 0.000, 0.400,         0.400],   // rump tip
  [-0.482, 0.052, 0.452,         0.352],
  [-0.458, 0.093, 0.492,         0.300],
  [-0.428, 0.126, 0.530,         0.250],
  [-0.392, 0.148, 0.564,         0.202],
  [-0.350, 0.161, 0.590,         0.166],
  [-0.290, 0.168, BACK_TOP - 0.011, 0.145],
  [-0.210, 0.1700, BACK_TOP - 0.0017, 0.136],
  [-0.130, 0.1700, BACK_TOP,      0.1345],  // crown, and the widest station
  [-0.040, 0.1700, BACK_TOP - 0.0037, 0.1345],
  [0.030, 0.1685, BACK_TOP - 0.0127, 0.136],
  [0.090, 0.1620, BACK_TOP - 0.0272, 0.140],
  // NECK. A waist behind the head — but a waist, not a step (see above).
  [0.150, 0.1470, BACK_TOP - 0.0472, 0.152],
  [0.200, 0.1420, BACK_TOP - 0.0692, 0.172],
  // CHEEK MASS / JOWL. The head flares WIDER than the neck and wider than it is
  // tall, which is what makes a pig's head read as a head. It stays inside the
  // foot corner the Side rests are propped on, and the jowler's roll comes off
  // the ear tip, not the cheek, so the flare is free there too.
  [P.head.pos[2], 0.1520, 0.5260, 0.1900],
  [0.300, 0.1520, 0.5010, 0.1930],
  [zHeadFront - 0.015, 0.1330, 0.4690, 0.2050],
  [zHeadFront + 0.015, 0.1020, 0.4330, 0.2310],
  [zHeadFront + 0.035, 0.0580, 0.3860, 0.2700],
  [zHeadFront + 0.046, 0.0000, 0.3260, 0.3260],
];
/** superellipse exponent by z — flat 2.0 through the barrel, a touch of square
 *  through the cheek where a real moulded head has a fuller corner */
const BODY_N = [
  { z: -0.5, n: 2.00 }, { z: -0.13, n: 2.02 }, { z: 0.09, n: 2.03 },
  { z: 0.20, n: 2.04 }, { z: P.head.pos[2], n: 2.10 }, { z: 0.300, n: 2.08 },
  { z: zHeadFront, n: 2.02 }, { z: zHeadFront + 0.046, n: 2.00 },
];
const BODY_KEYS = BODY_PROFILE.map(([z, rx, back, belly]) => ({
  z, rx,
  ry: (back - belly) / 2,
  yc: (back + belly) / 2,
  n: splineAt(BODY_N, 'n', z),
}));

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

/* ==================================================== the expression atlas
 * SPEC "Character & expressions": the pig needs real eyes on BOTH sides and a
 * set of states that can be swapped every frame without touching a canvas.
 *
 * How it works, in one paragraph. One patch of the body — the cheek, from just
 * behind the eye to the root of the snout — is CARVED out of the body sweep:
 * its vertices are duplicated, the triangles inside the patch are re-pointed at
 * the copies, and the copies are given UVs that land in a face ATLAS instead of
 * on the body sheet. Every expression is rendered into that atlas ONCE at
 * startup (both flanks, so a wink can close a single eye), so `setExpression`
 * is nothing but a rewrite of ~350 floats — no canvas, no new texture, no new
 * material. The patch is welded to its originals, so it shares their normals
 * and there is no seam; each cell carries a copy of the body sheet underneath
 * the ink, so there is no colour step at the patch border either.
 * ==================================================================== */

/** SPEC list, in the order the dev viewer cycles them (q w e r t y u i). */
export const EXPRESSIONS = [
  'neutral', 'squint', 'ouch', 'dazed', 'smug', 'wink', 'sad', 'panic',
];

/**
 * Face placement, in collider build-frame units. `u` is the fraction of the way
 * around a body ring (0 = belly, 0.25 = +X flank, 0.5 = spine).
 *
 * ROUND-1 REVIEW, three notes, all of them geometry rather than draughtsmanship:
 * the face had no readable feature at any scale the game shows; the ear paddle
 * sat directly over the eye and occluded it; and the eight expressions were
 * indistinguishable because every difference was inside a 10-pixel almond.
 *
 * The single most important number here is `eyeR`. It went from 0.030 to 0.052 —
 * the eye is now a sixth of the whole pig's length, Nintendo-scale, which is what
 * it takes to survive the in-game pig being a ~100 CSS-pixel bounding box. Every
 * other number below follows from wanting that much room:
 *
 *  - `eyeZ` moved FORWARD onto the cheek proper. The collider's ear is a paddle
 *    whose visual tip sweeps z ∈ [0.236, 0.280]; putting the eye at 0.318 clears
 *    the whole footprint with 38 mm to spare, so an expression can never fire
 *    behind the ear again.
 *  - `eyeU` moved UP to the flank line, where the cheek is broadest and least
 *    foreshortened in the two Sider rests (65% of tosses) — and where the
 *    drooping ear shades least.
 *  - the mouth and the blush are no longer separate anchors. They are drawn in
 *    the eye's own local frame at `mouthAt` / `blushAt` (x forward, y down, in
 *    board-metres), which is what lets the carved window below be sized from one
 *    known ink bounding box instead of the union of three guesses.
 */
/*
 * ROUND-2 REVIEW: "the ear bisects the eye at normal viewing angles … since the
 * ear placement is load-bearing for the 37° jowler roll, the eye is the thing
 * that has to move (further forward and lower onto the cheek), not the ear."
 *
 * MEASURED before the change, in the COM frame: the ear paddle's widest station
 * sits at y −0.005 spanning z 0.185…0.313, and the lens spanned z 0.266…0.370 —
 * so the ear covered the eye's rear 47%. Three moves close it, and the budget for
 * each one is set by hard geometry, which is why none of them is larger:
 *
 *  - FORWARD: eyeZ 0.318 → 0.328 (0.326 today). It cannot go much past this. The
 *    forward ink reach is `inkReach × eyeR` = 73 mm, the last usable body ring is
 *    at z 0.406, and beyond z ≈ 0.395 the rings are the nose tip (rx 0.058 → 0),
 *    where a carved window pinches to nothing.
 *  - LOWER: eyeU 0.202 → 0.183 — SUPERSEDED by the owner's 2026-08-11 layout
 *    direction below, which puts the eye UP at 0.352. Round 2 moved it down onto
 *    the cheek to escape the ear and that did work, but it also parked the eye on
 *    the jawline facing the felt, which is the fault round 3 measured. The ear is
 *    escaped by HEIGHT now: its paddle lives at z ≤ 0.268 and the eye at 0.326, so
 *    the two no longer share any z at all.
 *  - and the ear's own LEADING EDGE is trimmed back to z 0.268 in earSamples —
 *    visual-only, tip position untouched, so the jowler's 37° roll cannot move.
 */
/*
 * ROUND-3 REVIEW, and it is the same fault twice: "the mouth and the blush never
 * render … FACE.mouthAt is 0.082 board-metres BELOW an eye that already sits on
 * the jawline, so the mouth lands under the chin or off the head", and "the
 * neutral eye sits at the very bottom of the head on the jawline … giving the
 * default pig a permanent hippo-ish scowl."
 *
 * The owner's answer (SPEC "Face layout", 2026-08-11) is a LAYOUT change, not a
 * nudge: eyes HIGH on the head — upper half of the head mass, level with the
 * snout's top edge — and a smaller snout (above), whose freed area is where the
 * mouth and the blush then live.
 *
 * MEASURED in the build frame. `u` is the fraction around a body ring (0 belly,
 * 0.25 the +X flank, 0.5 the spine) and the head's ring at the eye's z has
 * yc 0.341, ry 0.141, so u converts to a height directly:
 *
 *   before: eyeU 0.183 → y 0.284 — BELOW the head's own centre (0.360) and 77 mm
 *           up from its lowest point. The jawline, exactly as reported.
 *   after:  eyeU 0.352 → y 0.425, level with the shrunk snout's top rim (0.443)
 *           and in the upper quarter of the head mass (0.207…0.513).
 *
 * And the height is what makes the eye VISIBLE AT ALL, which is the real bug
 * behind "no eye is visible from the front". The reveal camera stands at
 * heightRatio 0.34, i.e. ~19° ABOVE the pig; the old eye's surface normal
 * (0.91, −0.41, 0) pointed DOWNWARD, so its dot with the direction to the camera
 * was NEGATIVE — the game's own hero shot was looking at the back of the eye's
 * hemisphere. The new normal is (0.80, 0.60, 0): it faces up and out, into the
 * camera the reveal actually uses.
 *
 * The mouth and blush keep their eye-local frame (+x forward, +y down) — the ink
 * is one anchored drawing so the carved window can be sized from one bounding box
 * — but 84 mm below an eye at y 0.425 now lands at y 0.346, z 0.338: on the cheek
 * just behind the snout's root, where a pig's mouth line actually is. The blush
 * sits between the two.
 */
const FACE = {
  u0: 0.204, u1: 0.450,     // the carved window on the +X flank
  z0: 0.244, z1: 0.396,
  eyeU: 0.352, eyeZ: 0.326,
  eyeR: 0.052,              // eye radius in board-metres (the head is ~0.33 tall)
  mouthAt: [0.012, 0.084],  // mouth centre, in the eye's local frame
  mouthK: 0.048,            // mouth scale (independent of eyeR now)
  blushAt: [-0.030, 0.052], // cheek blush centre, likewise
  blushR: 0.042,
  // Nothing in the ink may reach further than this from the eye centre, or it
  // falls outside the carved window and is simply lost. The window above is
  // sized from exactly these numbers — change one, re-check the other.
  inkReach: 1.40,           // × eyeR, in every direction from the eye centre
};

const TEX_W = 1024;
const BODY_TEX_H = 480;     // scanlines the body sheet owns
const BLANK_TEX_H = 24;     // pure-white strip the vertex-coloured parts sample
// Atlas cells are drawn at a higher texel density than the body sheet, most of
// all along the body where the sheet is coarsest (~450 px/metre vs ~1300 across).
// These two are free until the cells stop tiling into 1024 px — TEX_H grows to
// fit whatever they ask for, so they are safe to turn up. They came DOWN with
// the big-eye rewrite: the ink is now ~3x larger in world units, so the same
// texel density buys three times the sharpness where it counts, and the atlas
// stays close to its old size even though every cell covers twice the cheek.
const FACE_SX = 1.05;
const FACE_SY = 1.75;
const FACE_PAD = 5;         // gutter of matching skin around each cell

/** ring/column index window of the carved patch (snapped to real vertices) */
const FACE_I = (() => {
  let i0 = 0;
  while (i0 < BODY_ZS.length - 1 && BODY_ZS[i0] < FACE.z0) i0++;
  let i1 = i0;
  while (i1 < BODY_ZS.length - 1 && BODY_ZS[i1 + 1] <= FACE.z1) i1++;
  return [i0, i1];
})();
const FACE_J = [Math.round(FACE.u0 * BODY_RADIAL), Math.round(FACE.u1 * BODY_RADIAL)];

const FACE_SRC_W = ((FACE_J[1] - FACE_J[0]) / BODY_RADIAL) * TEX_W;
const FACE_SRC_H = ((FACE_I[1] - FACE_I[0]) / (BODY_ZS.length - 1)) * BODY_TEX_H;
const FACE_CELL_W = Math.round(FACE_SRC_W * FACE_SX) + 2 * FACE_PAD;
const FACE_CELL_H = Math.round(FACE_SRC_H * FACE_SY) + 2 * FACE_PAD;
const FACE_CELLS = EXPRESSIONS.length * 2;
const FACE_ATLAS_COLS = Math.max(1, Math.floor(TEX_W / FACE_CELL_W));
const FACE_ATLAS_ROWS = Math.ceil(FACE_CELLS / FACE_ATLAS_COLS);
const FACE_ATLAS_Y = BODY_TEX_H + BLANK_TEX_H;

const TEX_H = FACE_ATLAS_Y + FACE_ATLAS_ROWS * FACE_CELL_H;
const BODY_V_MAX = BODY_TEX_H / TEX_H;                 // body owns v ∈ [0, ~0.5]
const BLANK_UV = [0.5, (BODY_TEX_H + BLANK_TEX_H * 0.5) / TEX_H];

/** cell index for (expression, flank). side +1 = +X flank, −1 = the dot flank */
const faceCellIndex = (expr, side) => expr * 2 + (side > 0 ? 0 : 1);
function faceCell(idx) {
  return {
    x: (idx % FACE_ATLAS_COLS) * FACE_CELL_W,
    y: FACE_ATLAS_Y + Math.floor(idx / FACE_ATLAS_COLS) * FACE_CELL_H,
  };
}
/** the rectangle of the BODY sheet that one flank's patch samples today */
function faceSrcRect(side) {
  const j0 = side > 0 ? FACE_J[0] : BODY_RADIAL - FACE_J[1];
  const j1 = side > 0 ? FACE_J[1] : BODY_RADIAL - FACE_J[0];
  return {
    j0, j1,
    x: (j0 / BODY_RADIAL) * TEX_W,
    y: (FACE_I[0] / (BODY_ZS.length - 1)) * BODY_TEX_H,
    w: FACE_SRC_W,
    h: FACE_SRC_H,
  };
}

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

/**
 * The razorback crest — now a 16 mm spine hint on top of an already-arched back
 * (see CREST_H). The back line carries the height; this carries the character.
 *
 * ROUND-3: the shoulder this leaves is a quarter of the old one's, and the
 * cross-section it sits on is convex rather than flat, which is the difference
 * between a spine and the specular crease line the review measured "running its
 * full length along the top-side transition". Its z window is also tied to the
 * COLLIDER's ridge, so the razorback contact — only ever the apex, at u = 0.5 —
 * still reaches yRidgeTop exactly, which the grounding harness checks.
 */
function crest(p, u) {
  const z = p[2];
  const zf = smoothstep(zRidge0 - 0.130, zRidge0 + 0.150, z) *
             (1 - smoothstep(zRidge1 - 0.110, zRidge1 + 0.200, z));
  if (zf <= 0) return 0;
  const th = u * Math.PI * 2;
  const off = Math.abs(th - Math.PI);
  const af = 1 - smoothstep(0.02, 0.52, off);
  return CREST_H * zf * af;
}

/* ------------------------------------------------------------- vertex AO
 * ROUND-3 REVIEW: "Zero ambient occlusion anywhere on the pig — grep confirms no
 * aoMap in pig.js. Leg/belly junctions, the ear/head crease, under the jaw,
 * between the front legs: none have any contact darkening, so every part is
 * separately lit and reads as glued on. This is the single biggest reason a
 * 12,224-triangle model looks like assembled primitives rather than one moulded
 * toy … Cheap fix relative to its impact: a baked AO map, or vertex AO, or even a
 * darkened cavity term in the skin texture at the known joint locations."
 *
 * VERTEX AO, for the reason the review lists it second: an aoMap needs a second uv
 * channel and a bake, and the parts that read worst (legs, ears, tail) do not even
 * sample the sheet — they point at one white texel and carry their colour per
 * vertex. A cavity term evaluated in the BUILD frame reaches all of them with one
 * function, is free at runtime, and — because `Builder.add` hands the colour
 * callback the FINAL build-frame position — the two sides of every join darken by
 * the same amount, which is what actually welds them visually.
 *
 * Every site is a real junction of the collider's own parts, derived from
 * PIG_TUNING rather than eyeballed, so a retuned pig keeps its creases.
 */
const AO_SITES = [
  // the four leg/belly junctions, at the belly line rather than the box top
  ...['legFL', 'legFR', 'legBL', 'legBR'].map((n) => (
    { c: [P[n].pos[0], 0.150, P[n].pos[2]], r: 0.105, k: 0.46 }
  )),
  // between the front legs, and between the back ones: the chest and the groin
  { c: [0, 0.150, P.legFL.pos[2]], r: 0.115, k: 0.24 },
  { c: [0, 0.150, P.legBL.pos[2]], r: 0.115, k: 0.20 },
  /* The ear/head crease, both sides (the visual ears are mirror images). Kept
   * DELIBERATELY light: round-3 also reports "the ear reads as a hole punched in
   * the head", and a strong cavity term right at the root is the fastest way to
   * make that worse. It is a seam, not a socket. */
  { c: [0.086, P.ear.pos[1] - 0.012, P.ear.pos[2] - 0.004], r: 0.072, k: 0.24 },
  { c: [-0.086, P.ear.pos[1] - 0.012, P.ear.pos[2] - 0.004], r: 0.072, k: 0.24 },
  // under the jaw, where the head sits on the neck
  { c: [0, 0.250, 0.170], r: 0.140, k: 0.30 },
  // the muzzle root — a shallow crease, and kept clear of the eye ink
  { c: [0, 0.312, 0.344], r: 0.078, k: 0.20 },
  // the tail root
  { c: [0, P.tail.pos[1] + 0.012, P.tail.pos[2] + 0.018], r: 0.062, k: 0.32 },
];

/** Cavity darkening at a build-frame point: 1 = open surface, <1 in a crease. */
function ao(p) {
  let a = 1;
  for (const s of AO_SITES) {
    const d = Math.hypot(p[0] - s.c[0], p[1] - s.c[1], p[2] - s.c[2]);
    if (d >= s.r) continue;
    const t = 1 - d / s.r;
    a *= 1 - s.k * t * t;      // quadratic: hard in the corner, gone by the rim
  }
  // a floor, because AO is contact shading and not a hole: the deepest crease on
  // the model (the ear root over a leg root, which cannot happen) would otherwise
  // multiply down past anything the key light can recover
  return a < 0.46 ? 0.46 : a;
}
const AO_WHITE = (u, v, p) => { const a = ao(p); return [a, a, a]; };
/** multiply a linear colour by the cavity term at `p` */
const aoMul = (c, p) => { const a = ao(p); return [c[0] * a, c[1] * a, c[2] * a]; };

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

/**
 * The snout is a disc on a short barrel. Round 1 asked for it BIGGER (pigs-01:
 * the disc is nearly as wide as the head) and `SNOUT_FLARE` is what is left of
 * that — it is baked into the radius profile below. Round 3's owner direction then
 * asked for it SMALLER again, which is not a reversal: the disc had grown until it
 * owned the whole face. See SNOUT_SHRINK.
 *
 * The one hard constraint either way: the lower front rim of the collider's snout
 * cylinder is the snouter and jowler contact, so the visual rim may not leave it —
 * neither by dropping through the felt nor by lifting off it. dev/grounding.mjs is
 * what checks that, and it is not optional after touching anything here.
 */
const SNOUT_FLARE = 0.0125;

/**
 * …and then the owner cut it back again, which is a different requirement from
 * the round-1 one and not a reversal of it.
 *
 * OWNER ART DIRECTION 2026-08-11 (SPEC "Face layout"): "The snout must get
 * SMALLER. The current disc dominates the face and crowds out eyes and mouth;
 * shrink its diameter noticeably so the face reads eyes-first, snout-second. The
 * only physics coupling: the visual snout's LOWER rim must still reach the
 * collider's snouter/jowler contact plane — shrink upward (keep the bottom edge,
 * pull the top profile down)."
 *
 * MEASURED before: the disc spanned y 0.220…0.478, i.e. 258 mm of a 306 mm head —
 * 84% of the head's whole height, and 265 mm wide against a 304 mm head. It was
 * the biggest single shape on the pig.
 *
 * `SNOUT_SHRINK` scales every ring, and `SNOUT_DROP` is DERIVED from it rather
 * than tuned. Shrinking a disc about its own centre RAISES its bottom edge by the
 * radius it lost (`ry = 0.985 r`, down the ring's own −SN_EY axis), so holding the
 * contact rim still means moving the whole sweep DOWN by exactly that much — which
 * is also precisely the owner's "keep the bottom edge, pull the top profile down":
 * the top rim then falls by twice the radius lost, 35 mm. MEASURED without the
 * drop, dev/grounding.mjs: the snouter floated 8.3 mm and the jowler 11.6 mm, and
 * the lowest visual vertex had become a HOOF — i.e. the rim had left the felt.
 * The drop is UNIFORM over the sweep: the old `grown` ramp was harmless at 3.5 mm
 * but at 18 mm it would have tilted the flat face into a shallow cone, because the
 * face's centre rings (r → 0) would have moved less than its rim.
 * MEASURED after (dev/grounding.mjs): snouter 0.0 mm, jowler −5.4 mm, both
 * exactly as before; the disc now spans y 0.220…0.443 and 226 mm wide.
 */
const SNOUT_SHRINK = 0.855;
const SNOUT_R_MAX = 0.1285;
const SNOUT_DROP = SNOUT_R_MAX * 0.985 * (1 - SNOUT_SHRINK);

function snoutSamples() {
  const prof = [
    [-0.140, 0.048], [-0.118, 0.068], [-0.096, 0.084], [-0.070, 0.098],
    [-0.040, 0.1115], [-0.008, 0.1205], [0.020, 0.1258], [0.042, 0.1285],
  ];
  // rounded rim: quarter arc from the barrel onto the face
  const rimR = 0.0122, cs = SN_TIP - rimR, cr = 0.1285 - rimR;
  for (let k = 1; k <= 6; k++) {
    const a = (k * Math.PI) / 12;
    prof.push([cs + rimR * Math.sin(a), cr + rimR * Math.cos(a)]);
  }
  // the flat face, dished very slightly so it catches a highlight
  prof.push([SN_TIP, 0.1105], [SN_TIP + 0.0010, 0.096], [SN_TIP + 0.0008, 0.074],
            [SN_TIP - 0.0006, 0.050], [SN_TIP - 0.0020, 0.027],
            [SN_TIP - 0.0032, 0.011], [SN_TIP - 0.0038, 0.000]);
  return prof.map(([s, r0]) => {
    const r = r0 * SNOUT_SHRINK;
    return {
      // +SN_EY is UP on the snout face (the nostrils sit at −SN_EY)
      c: [
        SN_C[0] + SN_AXIS[0] * s - SN_EY[0] * SNOUT_DROP,
        SN_C[1] + SN_AXIS[1] * s - SN_EY[1] * SNOUT_DROP,
        SN_C[2] + SN_AXIS[2] * s - SN_EY[2] * SNOUT_DROP,
      ],
      ex: SN_EX, ey: SN_EY, rx: r * 1.03, ry: r * 0.985, n: 2.15,
    };
  });
}

// The centre of the flat face — WITH the drop, or every dimple placed against it
// lands above the disc it is supposed to sit in.
const FACE_C = [
  SN_C[0] + SN_AXIS[0] * SN_TIP - SN_EY[0] * SNOUT_DROP,
  SN_C[1] + SN_AXIS[1] * SN_TIP - SN_EY[1] * SNOUT_DROP,
  SN_C[2] + SN_AXIS[2] * SN_TIP - SN_EY[2] * SNOUT_DROP,
];
// nostrils sit a little below the face centre, mirrored across x — and they
// scale with the disc, so a smaller snout keeps its proportions
const NOSTRIL_X = 0.042 * SNOUT_SHRINK;
const NOSTRIL_Y = 0.024 * SNOUT_SHRINK;
const NOSTRIL = [-1, 1].map((s) => [
  FACE_C[0] + SN_EX[0] * NOSTRIL_X * s - SN_EY[0] * NOSTRIL_Y,
  FACE_C[1] + SN_EX[1] * NOSTRIL_X * s - SN_EY[1] * NOSTRIL_Y,
  FACE_C[2] + SN_EX[2] * NOSTRIL_X * s - SN_EY[2] * NOSTRIL_Y,
]);

/** how deep inside a nostril dimple a point is, 0..1 (elliptical falloff) */
function nostrilField(p) {
  let best = 0;
  for (const c of NOSTRIL) {
    const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
    const ax = dx;
    const ay = dy * SN_EY[1] + dz * SN_EY[2];
    const d = Math.hypot(ax / (0.020 * SNOUT_SHRINK), ay / (0.028 * SNOUT_SHRINK));
    best = Math.max(best, 1 - smoothstep(0.55, 1.0, d));
  }
  return best;
}

/* ------------------------------------------------------------------- limbs */

/**
 * One leg, as a radius profile measured UP FROM THE HOOF'S LOWEST POINT.
 *
 * The round-1 review called the old legs spider/crab legs: four long tapered
 * tubes ending in a point. The reference pigs (pigs-01, pigs-04) have short
 * conical nubs barely longer than they are wide, ending in a fat pink knob. The
 * collider's leg length is fixed (legHY drives every pose), so the fix is on the
 * three axes that are free: the shank is ~30% thicker, the hoof is a BULB with a
 * blunt rounded cap instead of a spike, and BELLY_DROP hides the top third of
 * the leg inside the barrel — together those take the exposed leg from a 1.8:1
 * tube to a ~1.2:1 nub. The haunch radius stays under 0.078 so the widest part
 * of the leg can never poke outside the foot corner the Side rests prop on.
 */
const LEG_KEYS = [
  [0.0000, 0.0000],   // blunt cap — a rounded pole, tangent to the felt
  [0.0045, 0.0330],
  [0.0110, 0.0530],
  [0.0195, 0.0655],
  [0.0300, 0.0715],   // widest point of the hoof knob
  [0.0420, 0.0725],
  [0.0540, 0.0695],
  [0.0680, 0.0640],
  [0.0850, 0.0600],   // shank
  [0.1050, 0.0600],
  [0.1280, 0.0635],
  [0.1520, 0.0695],
  [0.1780, 0.0755],
  [0.2060, 0.0780],   // haunch, buried in the belly
  [0.2340, 0.0730],
  [0.2560, 0.0600],
];
const HOOF_TOP = 0.042;   // below this the leg is painted hoof

/**
 * How far the visual hoof has to hang below the leg's build-frame origin so its
 * lowest point lands exactly on the collider box's lowest corner.
 *
 * DERIVED, not guessed — and getting it wrong is why the round-1 review saw pigs
 * that "float on the felt". partMatrix puts the leg's local origin at the
 * collider box's bottom-centre BEFORE the splay rotation, so a leg leaned by θ
 * has its lowest corner a further `legHX·tan|θ|` down. The old single constant
 * 0.0072 is exactly legHX·tan(8°) — right for the two legs leaning 8° and 9 mm
 * short for the two leaning 18°, so half the hooves hovered in every trotter.
 */
function legDrop(part) {
  return P.legFL.he[0] * Math.abs(Math.tan(part.rot[2] * D2R));
}

function legSamples(drop) {
  // swept along +Y ⇒ ex × ey = +Y ⇒ ey = (0,0,−1)
  return LEG_KEYS.map(([y, r]) => ({
    c: [0, y - drop, 0], ex: [1, 0, 0], ey: [0, 0, -1],
    rx: r * 1.0, ry: r * 1.08, n: 2.15,
  }));
}

/**
 * A blunt, slightly drooping paddle ear. The tip reach is deliberately tuned
 * to land on the collider ear's outer corner: the side rests are propped on
 * that corner, so a shorter visual ear would leave the pig hovering.
 *
 * The profile was drawn against EAR_REF (the collider ear's half-extents at the
 * time), and every sample is rescaled to whatever PIG_TUNING says today — so a
 * retuned ear moves the silhouette with it instead of silently detaching the
 * visual pig from the thing the physics rests on.
 */
const EAR_REF = { hx: 0.13, hy: 0.026, hz: 0.075 };
const EAR_KEYS = [
  [-0.132, 0.044, 0.019], [-0.104, 0.061, 0.0250], [-0.070, 0.072, 0.0280],
  [-0.030, 0.0765, 0.0285], [0.009, 0.0760, 0.0265], [0.044, 0.0705, 0.0222],
  [0.077, 0.0615, 0.0178], [0.103, 0.0500, 0.0136], [0.122, 0.0375, 0.0100],
  [0.135, 0.0225, 0.0066], [0.142, 0.0000, 0.0000],
];
const EAR_SCALE = [T.earHX / EAR_REF.hx, T.earHY / EAR_REF.hy, T.earHZ / EAR_REF.hz];
/**
 * The paddle's chord, and where its LEADING (forward) edge is allowed to stop.
 *
 * ROUND-2 REVIEW: "the ear bisects the eye at normal viewing angles." The round-1
 * fix — 3 cm of rearward sweep at the tip — moved the tip but not the paddle's
 * broad middle, which is the part that actually covers the cheek: MEASURED, the
 * widest station still reached z 0.332, and the lens started at z 0.266.
 *
 * So the leading edge is now CLAMPED. Every section is pushed back by whatever it
 * takes to keep its forward edge behind `EAR_LEAD` (local z), which gives the ear
 * a straight forward edge and a swept, tapering trailing one — exactly the shape
 * in pigs-02. `EAR_CHORD` narrows the visual paddle a little so the clamp does not
 * have to push the trailing edge back onto the neck to achieve it.
 *
 * VISUAL ONLY, and deliberately so: the jowler's support point is the ear TIP,
 * whose x and y are untouched here, so the 37° roll dev/collider-test.mjs asserts
 * cannot move. The chord is still DERIVED from the collider's earHZ, so a retuned
 * collider ear still drags the silhouette with it.
 */
const EAR_CHORD = 0.80;
const EAR_LEAD = 0.010;
function earSamples() {
  // swept along +X ⇒ ex × ey = +X ⇒ ex = (0,0,1), ey = (0,−1,0)
  const [sx, sy, sz] = EAR_SCALE;
  return EAR_KEYS.map(([x, w, t]) => {
    const s = clamp((x + 0.05) / 0.20, 0, 1);
    const rx = w * sz * EAR_CHORD;
    // base sweep, then the leading-edge clamp on top of it
    const zc = -0.032 * s * s * sz;
    const trim = Math.max(0, zc + rx - EAR_LEAD);
    return {
      c: [x * sx, -0.0085 * s * s * sy, zc - trim],
      ex: [0, 0, 1], ey: [0, -1, 0],
      rx, ry: t * sy, n: 2.35,
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

/* ============================================== the expression ink drawings
 * Everything here draws in BOARD-METRES on the surface of the cheek, through
 * the `flank(u, z, side, draw)` helper: inside `draw`, +x is forward (toward
 * the snout), +y is down, and a circle is a circle on the pig. Both flanks are
 * drawn from the same code — flank() flips the around-body axis for the −X
 * side — so the two eyes are true mirrors without a second set of numbers.
 * ==================================================================== */

const INK = {
  eye: PALETTE.eye,
  /* ROUND-2 REVIEW: "the eye is an amorphous black void with two catchlights …
   * there is no iris ring, no lid line, no lash, and the outline is soft-edged so
   * it merges into a dark smear at the lower-rear."
   *
   * A toy eye is four concentric things and they have to be four DIFFERENT
   * values, or it is a hole: a crisp dark rim, a dark-but-not-black iris, a true
   * black pupil, and exactly one catchlight. `iris` and `pupil` are both kept in
   * the plum family — the SPEC's no-browns rule applies to the ink too. */
  iris: '#331a2b',
  pupil: '#0c0710',
  rim: 'rgba(52,16,34,0.98)',   // the crisp outline around the lens
  irisRing: 'rgba(126,52,84,0.55)', // faint limbal ring, inside the rim
  sclera: '#fffaf9',
  shine: 'rgba(255,255,255,0.98)',
  // Round-1 note: "eight states are being painted into the atlas and the player
  // will never perceive one of them." Half of that was size (see FACE.eyeR) and
  // half was CONTRAST — the lid and brow used to be 72%-alpha dusty rose on a
  // pink cheek, which is no contrast at all once the renderer has scaled the
  // whole face down to a hundred pixels. Brow and lid are now near-opaque and
  // several shades deeper, because a brow that cannot be seen cannot carry an
  // expression, and the brow is what separates smug from neutral.
  lid: 'rgba(178,84,114,0.95)',
  brow: 'rgba(122,54,78,0.95)',
  crease: 'rgba(140,66,92,0.72)',
  mouth: 'rgba(112,42,66,0.95)',
  maw: '#5f2439',
  tongue: '#e0698c',
  blush: 'rgba(255,116,152,ALPHA)',
};

/** the eye opening: a lens closed from above by `top` and below by `bot` (0..1) */
function eyePath(c, r, top, bot, wide) {
  const rx = r * (wide || 1);
  const hT = r * (1 - top) * 1.34;
  const hB = r * (1 - bot) * 1.34;
  c.beginPath();
  c.moveTo(-rx, 0);
  c.bezierCurveTo(-rx * 0.56, -hT, rx * 0.56, -hT, rx, 0);
  c.bezierCurveTo(rx * 0.56, hB, -rx * 0.56, hB, -rx, 0);
  c.closePath();
}

/**
 * The wet highlights. On a Nintendo-scale eye these are not a detail — the big
 * one is the second-largest shape on the face and it is what tells the player
 * the dark lens is an EYE and not a hole.
 */
function eyeShine(c, r, top, bot, strength = 1) {
  // EXACTLY ONE. The old pair — a big white at the top-right and a 62%-alpha grey
  // at the bottom-left — read as two pupils in one eye, i.e. wall-eyed, which is
  // what the round-2 review measured in the 3D head-cam. The single highlight sits
  // high and forward, where a key light above and in front of the pig would put it.
  c.fillStyle = INK.shine;
  c.globalAlpha = strength;
  c.beginPath();
  c.ellipse(r * 0.28, -r * (1 - top) * 0.44, r * 0.34, r * 0.28, -0.35, 0, 7);
  c.fill();
  c.globalAlpha = 1;
}

/**
 * The lens itself: rim → iris → pupil → catchlight, four separable values.
 * `top`/`bot` are the lid closures, so a hooded eye keeps its structure instead
 * of collapsing to a dark sliver.
 */
function eyeLens(c, r, sc, top, bot, wide, shine) {
  eyePath(c, sc, top, bot, wide);
  c.fillStyle = INK.iris;
  c.fill();
  // the pupil, clipped to the opening so a hooded lid crops it like a real lid
  c.save();
  c.clip();
  c.fillStyle = INK.pupil;
  c.beginPath();
  c.ellipse(r * 0.06, r * 0.04, sc * 0.54, sc * 0.60, 0, 0, 7);
  c.fill();
  // limbal ring: the iris's outer edge, which is what makes the dark shape read
  // as a lens with depth instead of a flat hole
  c.strokeStyle = INK.irisRing;
  c.lineWidth = r * 0.12;
  eyePath(c, sc * 0.86, top, bot, wide);
  c.stroke();
  c.restore();
  // …and a CRISP rim on the outside. The round-2 note "the outline is soft-edged
  // so it merges into a dark smear at the lower-rear" was this stroke missing.
  eyePath(c, sc, top, bot, wide);
  c.strokeStyle = INK.rim;
  c.lineWidth = r * 0.13;
  c.stroke();
  eyeShine(c, sc, top, bot, shine);
}

/**
 * The eye's surround. A pale halo first — the drooping ear throws a real
 * shadow across this exact patch of cheek, and without the lift the eye reads
 * as a smudge in a crevice — then a whisper of contact shadow under the lower
 * lid so it still sits IN the head rather than on it.
 *
 * Both radii are held inside FACE.inkReach × r: with the eye nearly twice its
 * old size, the old 2.0 r halo would have run straight off the carved window.
 */
function eyeSocket(c, soft, r, k = 1) {
  c.fillStyle = soft('rgba(255,236,242,ALPHA)', r * 1.30, 0.60 * k);
  c.beginPath();
  c.arc(r * 0.04, -r * 0.10, r * 1.30, 0, 7);
  c.fill();
  // The contact shadow under the lower lid. Kept WEAK on purpose: at 0.30 it was
  // dark enough to blur into the lens's own lower-rear edge, which is half of why
  // the round-2 review saw "a dark smear" rather than an eye. The crisp rim in
  // eyeLens is what seats the eye in the head now; this is only ambient.
  c.fillStyle = soft('rgba(176,88,118,ALPHA)', r * 1.02, 0.16 * k);
  c.beginPath();
  c.arc(r * 0.02, r * 0.86, r * 1.02, 0, 7);
  c.fill();
}

function brow(c, r, { y, tilt, w = 1.30, th = 0.26, arc = 0.5, alpha = 0.95 }) {
  c.save();
  c.translate(0, y * r);
  c.rotate(tilt);
  c.strokeStyle = INK.brow;
  c.globalAlpha = alpha;
  c.lineWidth = r * th;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-r * w * 0.5, 0);
  c.quadraticCurveTo(0, -r * arc, r * w * 0.5, r * arc * 0.15);
  c.stroke();
  c.globalAlpha = 1;
  c.restore();
}

/** a stroked line, in units of the eye radius, used for lashes and creases */
function tick(c, r, x0, y0, x1, y1, th = 0.2, style = INK.crease) {
  c.strokeStyle = style;
  c.lineWidth = r * th;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(r * x0, r * y0);
  c.lineTo(r * x1, r * y1);
  c.stroke();
}

/** a four-point twinkle, drawn in units of the eye radius */
function sparkle(c, r, x, y, s) {
  c.save();
  c.translate(r * x, r * y);
  c.fillStyle = 'rgba(255,255,255,0.92)';
  c.beginPath();
  const a = r * s, b = r * s * 0.24;
  c.moveTo(0, -a);
  c.quadraticCurveTo(b, -b, a, 0);
  c.quadraticCurveTo(b, b, 0, a);
  c.quadraticCurveTo(-b, b, -a, 0);
  c.quadraticCurveTo(-b, -b, 0, -a);
  c.fill();
  c.restore();
}

/** one open eye, the workhorse: `o` is a small spec object */
function openEye(c, soft, r, o) {
  eyeSocket(c, soft, r, o.socket === undefined ? 1 : o.socket);
  const top = o.top || 0, bot = o.bot || 0;
  const sc = r * (o.scale || 1);
  c.save();
  if (o.tilt) c.rotate(o.tilt);
  if (o.sclera) {
    eyePath(c, sc, top, bot, o.wide);
    c.fillStyle = INK.sclera;
    c.fill();
    c.save();
    c.clip();
    const pr = r * (o.pupil || 0.5);
    c.fillStyle = INK.eye;
    c.beginPath();
    c.arc(r * (o.pupilX || 0.12), r * (o.pupilY || 0), pr, 0, 7);
    c.fill();
    c.restore();
    // rim the opening so the white does not float
    eyePath(c, sc, top, bot, o.wide);
    c.strokeStyle = 'rgba(104,42,62,0.85)';
    c.lineWidth = r * 0.14;
    c.stroke();
    c.fillStyle = INK.shine;
    c.beginPath();
    c.ellipse(r * ((o.pupilX || 0.12) + 0.24), -r * 0.18, r * 0.17, r * 0.14, 0, 0, 7);
    c.fill();
  } else {
    eyeLens(c, r, sc, top, bot, o.wide, o.shine === undefined ? 1 : o.shine);
  }
  c.restore();
  // The upper lid, as a heavy dark lash line rather than the old translucent
  // skin-tone hint. On a hooded eye (smug, squint, sad) this line IS the
  // expression: it is the difference the round-1 review could not see.
  if (o.lid) {
    c.save();
    if (o.tilt) c.rotate(o.tilt);
    c.strokeStyle = INK.lid;
    c.lineWidth = r * (o.lidTh || 0.26);
    c.lineCap = 'round';
    c.beginPath();
    const h = r * (1 - top) * 1.30;
    c.moveTo(-sc * 1.04, -r * 0.02);
    c.bezierCurveTo(-sc * 0.56, -h, sc * 0.56, -h, sc * 1.04, -r * 0.02);
    c.stroke();
    c.restore();
  }
  // A lower-lid bulge — the other half of a smug/squint read, and the thing that
  // stops a hooded eye from just looking like a smaller open one.
  if (o.pouch) {
    c.save();
    if (o.tilt) c.rotate(o.tilt);
    c.strokeStyle = INK.crease;
    c.lineWidth = r * 0.17;
    c.lineCap = 'round';
    c.beginPath();
    const h = r * (1 - bot) * 1.30 + r * 0.26;
    c.moveTo(-sc * 0.92, r * 0.06);
    c.bezierCurveTo(-sc * 0.50, h, sc * 0.50, h, sc * 0.92, r * 0.06);
    c.stroke();
    c.restore();
  }
}

/** a closed, happy eye: a fat ∩ arc with two lashes on the outer corner */
function archEye(c, r) {
  c.strokeStyle = INK.eye;
  c.lineWidth = r * 0.34;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-r * 0.98, r * 0.34);
  c.bezierCurveTo(-r * 0.52, -r * 1.02, r * 0.52, -r * 1.02, r * 0.98, r * 0.30);
  c.stroke();
  tick(c, r, 1.04, 0.20, 1.36, 0.08, 0.18, INK.eye);
  tick(c, r, 0.98, -0.16, 1.28, -0.42, 0.18, INK.eye);
}

/**
 * A clenched eye. Deliberately the MIRROR of the wink's happy ∩: a hard ∪ with
 * creases radiating off both corners. The two states are the only closed eyes
 * in the set, so they have to be unmistakable at a glance from each other.
 */
function clenchEye(c, r) {
  c.strokeStyle = INK.eye;
  c.lineWidth = r * 0.32;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(-r * 0.96, -r * 0.48);
  c.quadraticCurveTo(0, r * 0.92, r * 0.96, -r * 0.48);
  c.stroke();
  tick(c, r, -1.02, -0.66, -1.34, -1.00, 0.18, 'rgba(52,30,40,0.80)');
  tick(c, r, 1.02, -0.66, 1.34, -1.00, 0.18, 'rgba(52,30,40,0.80)');
  tick(c, r, 0.00, 1.00, 0.00, 1.34, 0.18, 'rgba(52,30,40,0.70)');
}

/** dazed: a two-turn spiral */
function spiralEye(c, r) {
  eyePath(c, r * 1.02, 0, 0, 1);
  c.fillStyle = INK.sclera;
  c.fill();
  c.strokeStyle = 'rgba(120,52,74,0.5)';
  c.lineWidth = r * 0.1;
  c.stroke();
  c.save();
  c.beginPath();
  c.arc(0, 0, r * 0.98, 0, 7);
  c.clip();
  c.strokeStyle = INK.eye;
  c.lineWidth = r * 0.26;
  c.lineCap = 'round';
  c.beginPath();
  for (let i = 0; i <= 90; i++) {
    const a = (i / 90) * Math.PI * 4.2;
    const rad = r * 0.95 * (i / 90);
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.stroke();
  c.restore();
}

/** the mouth, drawn at its own anchor; `k` scales everything with the eye */
function drawMouth(c, k, state) {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const line = (pts, th, style) => {
    c.strokeStyle = style || INK.mouth;
    c.lineWidth = k * th;
    c.beginPath();
    c.moveTo(pts[0] * k, pts[1] * k);
    c.bezierCurveTo(pts[2] * k, pts[3] * k, pts[4] * k, pts[5] * k, pts[6] * k, pts[7] * k);
    c.stroke();
  };
  const maw = (w, h, tongue) => {
    c.fillStyle = INK.maw;
    c.beginPath();
    c.ellipse(0, 0, k * w, k * h, -0.12, 0, 7);
    c.fill();
    if (tongue) {
      c.save();
      c.beginPath();
      c.ellipse(0, 0, k * w, k * h, -0.12, 0, 7);
      c.clip();
      c.fillStyle = INK.tongue;
      c.beginPath();
      c.ellipse(-k * w * 0.15, k * h * 0.75, k * w * 0.62, k * h * 0.55, 0, 0, 7);
      c.fill();
      c.restore();
    }
  };
  // Every stroke here is roughly 50% heavier than round 1. A 0.20-width mouth
  // line on a face rendered a hundred pixels tall is a sub-pixel scratch.
  switch (state) {
    case 'neutral':
      line([-0.9, -0.10, -0.30, 0.30, 0.34, 0.24, 0.92, -0.26], 0.30);
      break;
    case 'squint':   // teeth gritted into the wind
      line([-0.95, 0.02, -0.45, 0.34, 0.30, -0.28, 0.95, 0.06], 0.30);
      break;
    case 'ouch':
      maw(0.78, 0.52, true);
      break;
    case 'dazed':    // a loose wobbly line
      line([-0.95, 0.00, -0.40, 0.38, 0.30, -0.34, 0.95, 0.10], 0.28);
      break;
    case 'smug':     // a one-sided smirk: flat at the back, a flick at the front
      line([-0.60, 0.08, -0.05, 0.12, 0.45, 0.06, 1.05, -0.66], 0.34);
      break;
    case 'wink':     // open grin
      c.save();
      c.rotate(-0.16);
      maw(0.86, 0.40, true);
      c.restore();
      break;
    case 'sad':
      line([-0.92, 0.28, -0.34, -0.14, 0.32, -0.16, 0.92, 0.24], 0.30);
      break;
    case 'panic':
      maw(0.44, 0.58, false);
      break;
    default:
      line([-0.9, -0.10, -0.30, 0.30, 0.34, 0.24, 0.92, -0.26], 0.30);
  }
}

/**
 * Paint one expression onto one flank. Called once per (state, side) while the
 * skin sheet is being built — never again.
 *
 * Everything is drawn in ONE flank() call now, at the eye's anchor, with the
 * mouth and blush offset inside that local frame (FACE.mouthAt / FACE.blushAt).
 * One anchor is what makes the carved window sizeable from a single known ink
 * bounding box, and it guarantees the mouth is always the same distance from the
 * eye however the head profile is retuned.
 */
function paintFace(flank, soft, state, side) {
  const r = FACE.eyeR;
  const u = side > 0 ? FACE.eyeU : 1 - FACE.eyeU;
  // A wink closes the eye on the dot flank and leaves the other one sparkling.
  const winkClosed = state === 'wink' && side < 0;

  flank(u, FACE.eyeZ, side, (c) => {
    // 1. the cheek blush, under everything — it is the warm patch that makes the
    //    face read as a face rather than as ink floating on a flank.
    c.save();
    c.translate(FACE.blushAt[0], FACE.blushAt[1]);
    c.fillStyle = soft(INK.blush, FACE.blushR, state === 'panic' ? 0.34 : 0.78);
    c.beginPath();
    c.arc(0, 0, FACE.blushR, 0, 7);
    c.fill();
    c.restore();

    // 2. the eye — the big shape. Each state changes the OUTLINE, not just a
    //    couple of alphas, because a state that only differs in shading is a
    //    state the player never sees.
    switch (state) {
      case 'neutral':
        // wide open and friendly: nearly a full circle. The brow is LEVEL —
        // round 3: "a downward-angled brow, giving the default pig a permanent
        // hippo-ish scowl". The tilt is what read as the scowl; the arch carries
        // the friendliness on its own.
        openEye(c, soft, r, { top: 0.06, bot: 0.02 });
        brow(c, r, { y: -1.34, tilt: 0.0, arc: 0.46, th: 0.22, alpha: 0.68 });
        break;
      case 'squint':
        // squeezed to a hard horizontal slot, brow driven down into it
        openEye(c, soft, r, {
          top: 0.66, bot: 0.44, tilt: -0.12, shine: 0.75,
          lid: true, lidTh: 0.30, pouch: true, socket: 0.85,
        });
        brow(c, r, { y: -1.06, tilt: 0.34, arc: 0.10, th: 0.32 });
        tick(c, r, 1.10, -0.34, 1.38, -0.54, 0.16);
        break;
      case 'ouch':
        // scrunched shut: a hard ∪ with creases blasting off both corners
        eyeSocket(c, soft, r, 1.15);
        clenchEye(c, r);
        brow(c, r, { y: -1.20, tilt: 0.46, arc: 0.06, th: 0.38 });
        break;
      case 'dazed':
        eyeSocket(c, soft, r, 0.9);
        spiralEye(c, r);
        brow(c, r, { y: -1.34, tilt: -0.26, arc: 0.34, th: 0.22, alpha: 0.7 });
        break;
      case 'smug':
        /* THE round-1 failure was that smug was pixel-identical to neutral; the
         * round-2 fix hooded it from ABOVE and round 3 called that correctly too:
         * "smug renders as a half-lidded downward-looking slit, which reads as
         * sleepy/bored/stoned — emotionally backwards for the state that fires when
         * the player just scored. A smug pig needs an upward-curved lower lid, a
         * RAISED (not lowered) brow and a visible smirk."
         *
         * So the closure comes from BELOW now — `bot` 0.46 against a `top` of only
         * 0.14 — which is the difference between a pig squinting up at you and a pig
         * falling asleep. The pouch draws the raised lower lid, the heavy upper lid
         * line is gone (it was the sleepy cue), the brow arches high and clear, and
         * drawMouth's one-sided flick is the smirk. */
        openEye(c, soft, r, {
          top: 0.14, bot: 0.46, tilt: -0.06, pouch: true, shine: 1,
        });
        brow(c, r, { y: -1.52, tilt: -0.30, arc: 0.70, th: 0.30 });
        break;
      case 'wink':
        if (winkClosed) {
          eyeSocket(c, soft, r, 0.9);
          archEye(c, r);
        } else {
          openEye(c, soft, r, { top: 0.02, bot: 0.04 });
          // this pig knows exactly what it just did. Both sparkles are held inside
          // FACE.inkReach (1.05r + 0.28r = 1.33r): at the old 1.24r + 0.36r the
          // outer point fell OFF the carved window and was simply lost.
          sparkle(c, r, 1.05, -1.02, 0.28);
          sparkle(c, r, -1.02, -0.92, 0.18);
        }
        brow(c, r, { y: -1.34, tilt: -0.18, arc: 0.48, th: 0.24, alpha: 0.8 });
        break;
      case 'sad':
        // drooping the other way: lid heavy from above, brow inner end lifted
        openEye(c, soft, r, {
          top: 0.40, bot: 0.00, tilt: 0.20, lid: true, lidTh: 0.30, shine: 1,
        });
        brow(c, r, { y: -1.30, tilt: -0.52, arc: 0.10, th: 0.34 });
        break;
      case 'panic':
        openEye(c, soft, r, {
          sclera: true, scale: 1.22, wide: 0.94, pupil: 0.30,
          pupilX: 0.16, pupilY: -0.06, socket: 1.2,
        });
        brow(c, r, { y: -1.38, tilt: -0.32, arc: 0.40, th: 0.32 });
        break;
      default:
        openEye(c, soft, r, { top: 0.06, bot: 0.02 });
    }

    // 3. the mouth, in the eye's own frame
    c.save();
    c.translate(FACE.mouthAt[0], FACE.mouthAt[1]);
    drawMouth(c, FACE.mouthK, state);
    c.restore();
  });
}

/* ------------------------------------------------- the painted skin texture */

let TEX_CACHE = null;
function skinTexture() {
  if (!HAS_DOM || TEX_CACHE) return TEX_CACHE;

  const W = TEX_W, H = TEX_H;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // Everything below assumes texture v maps straight to canvas y — hence
  // flipY = false on the texture at the bottom of this function. The reserved
  // strip between the body sheet and the face atlas stays pure white: the
  // vertex-coloured parts (legs, ears, snout, tail) all sample it, so their
  // colour is exactly what buildPigGeometry asked for and nothing else.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const bodyH = BODY_TEX_H;

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

  // 3. a soft shadow where each leg meets the belly.
  //    The cheek blush used to live here too; it now belongs to paintFace, drawn
  //    in the eye's own local frame so it lands on the cheek beside the eye
  //    whatever the head profile does — and so it is part of the expression
  //    rather than a fixed patch the atlas cells copy underneath the ink.
  for (const side of [1, -1]) {
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

  // 5. the flank dot. SPEC: BOTH pigs carry it, it is BLACK, and it is a flat
  //    flush disc on the pig's RIGHT flank — the −X flank, which is the one
  //    POSE_UP['side-dot'] turns skyward, so the dot is visible exactly when
  //    the classifier says 'side-dot'. Painted rather than modelled precisely
  //    so it is flush: `flank()` maps world units on the −X flank into texture
  //    space (that is the COM-frame conversion — a disc placed by eye in UV
  //    space ends up floating off the barrel of the body).
  flank(0.715, P.torso.pos[2] + 0.055, -1, (c) => {
    const r = 0.039;
    c.fillStyle = soft('rgba(40,26,32,ALPHA)', r * 1.5, 0.26);
    c.beginPath(); c.arc(0, 0, r * 1.5, 0, 7); c.fill();
    const rg = c.createRadialGradient(-r * 0.25, -r * 0.3, 0, 0, 0, r);
    rg.addColorStop(0, '#241c20');
    rg.addColorStop(0.72, PALETTE.dot);
    rg.addColorStop(0.93, '#050304');
    rg.addColorStop(1, 'rgba(5,3,4,0)');
    c.fillStyle = rg;
    c.beginPath(); c.arc(0, 0, r, 0, 7); c.fill();
  });

  // 6. THE FACE ATLAS. One cell per (expression × flank). Each cell starts as a
  //    copy of the very sheet we just painted — the same cheek, the same blush,
  //    the same mould seam, sampled a little wider than the carved patch so the
  //    gutter matches too. That is what makes the patch border invisible: at the
  //    seam the cell and the body sheet are literally the same pixels.
  for (let e = 0; e < EXPRESSIONS.length; e++) {
    for (const side of [1, -1]) {
      const cell = faceCell(faceCellIndex(e, side));
      const s = faceSrcRect(side);
      ctx.save();
      ctx.beginPath();
      ctx.rect(cell.x, cell.y, FACE_CELL_W, FACE_CELL_H);
      ctx.clip();
      ctx.drawImage(
        cv,
        s.x - FACE_PAD / FACE_SX, s.y - FACE_PAD / FACE_SY,
        s.w + (2 * FACE_PAD) / FACE_SX, s.h + (2 * FACE_PAD) / FACE_SY,
        cell.x, cell.y, FACE_CELL_W, FACE_CELL_H,
      );
      // Ink is drawn in BODY-SHEET coordinates and squeezed into the cell, so
      // flank() keeps doing the world→texture conversion it already gets right
      // (a circle drawn here is a circle on the barrel of the pig, not an
      // ellipse), and the cell is an exact re-parameterisation of the patch.
      ctx.translate(cell.x + FACE_PAD, cell.y + FACE_PAD);
      ctx.scale(FACE_SX, FACE_SY);
      ctx.translate(-s.x, -s.y);
      paintFace(flank, soft, EXPRESSIONS[e], side);
      ctx.restore();
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;          // texture v IS canvas y; every number above says so
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  TEX_CACHE = tex;
  return tex;
}

/* ------------------------------------------------------- pig geometry cache */

/** Where the swappable face vertices live: filled in by carveFace(). */
let FACE_RANGES = null;

/**
 * Carve the two cheek patches out of a body sweep.
 *
 * The patch vertices are DUPLICATED and the triangles wholly inside the patch
 * are re-pointed at the copies, so the copies can carry atlas UVs while the
 * rest of the body keeps sheet UVs — no torn quad at the border, because the
 * quads that straddle it still use the originals. Every duplicate on the patch
 * PERIMETER is welded to its original, which is what makes their normals come
 * out identical and the patch shade as if it were still one surface.
 *
 * Mutates `piece` (position/st grow, index is rewritten) and returns the vertex
 * ranges `setExpression` rewrites.
 */
function carveFace(piece) {
  const cols = BODY_RADIAL + 1;
  const nVerts = piece.position.length / 3;
  const ni = FACE_I[1] - FACE_I[0] + 1;

  const blocks = [];
  let extra = 0;
  for (const side of [1, -1]) {
    const s = faceSrcRect(side);
    const nj = s.j1 - s.j0 + 1;
    blocks.push({ side, j0: s.j0, j1: s.j1, nj, base: nVerts + extra });
    extra += nj * ni;
  }

  const pos = new Float32Array((nVerts + extra) * 3);
  pos.set(piece.position);
  const st = new Float32Array((nVerts + extra) * 2);
  st.set(piece.st);
  const dup = new Int32Array(nVerts).fill(-1);
  const ranges = [];

  for (const b of blocks) {
    const cell = faceCell(faceCellIndex(0, b.side));   // built showing 'neutral'
    const local = new Float32Array(b.nj * ni * 2);
    for (let i = FACE_I[0]; i <= FACE_I[1]; i++) {
      for (let j = b.j0; j <= b.j1; j++) {
        const o = i * cols + j;
        const k = (i - FACE_I[0]) * b.nj + (j - b.j0);
        const d = b.base + k;
        dup[o] = d;
        pos[d * 3] = piece.position[o * 3];
        pos[d * 3 + 1] = piece.position[o * 3 + 1];
        pos[d * 3 + 2] = piece.position[o * 3 + 2];
        const lu = (j - b.j0) / (b.nj - 1);
        const lv = (i - FACE_I[0]) / (ni - 1);
        local[k * 2] = (FACE_PAD + lu * FACE_SRC_W * FACE_SX) / TEX_W;
        local[k * 2 + 1] = (FACE_PAD + lv * FACE_SRC_H * FACE_SY) / TEX_H;
        st[d * 2] = cell.x / TEX_W + local[k * 2];
        st[d * 2 + 1] = cell.y / TEX_H + local[k * 2 + 1];
        if (i === FACE_I[0] || i === FACE_I[1] || j === b.j0 || j === b.j1) {
          piece.weld.push([o, d]);
        }
      }
    }
    ranges.push({ start: b.base, count: b.nj * ni, side: b.side, local });
  }

  const idx = piece.index;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b2 = idx[t + 1], c = idx[t + 2];
    if (dup[a] >= 0 && dup[b2] >= 0 && dup[c] >= 0) {
      idx[t] = dup[a]; idx[t + 1] = dup[b2]; idx[t + 2] = dup[c];
    }
  }

  piece.position = pos;
  piece.st = st;
  return ranges;
}

/** The whole pig: one welded, smooth-normalled geometry, COM-centred. */
function buildPigGeometry() {
  const b = new Builder();
  const skin = linear(PALETTE.skin);
  const skinLight = linear(PALETTE.skinLight);
  const skinDeep = linear(PALETTE.skinDeep);
  const snoutC = linear(PALETTE.snout);
  const snoutDeep = linear(PALETTE.snoutDeep);
  const skinShade = linear(PALETTE.skinShade);
  const hoofC = linear(PALETTE.hoof);
  const hoofTipC = linear(PALETTE.hoofTip);
  const nostrilC = linear(PALETTE.nostril);

  // ---- body (textured).
  // The crest and the hand-sculpted wobble are functions of the RING coords, so
  // they are applied here, before the face patch is carved — a duplicate that
  // warped by a different amount than its original would crack the surface open.
  const bodyPiece = sweep(bodySamples(), BODY_RADIAL);
  {
    const bp = bodyPiece.position, bst = bodyPiece.st;
    const p = [0, 0, 0];
    for (let k = 0; k < bp.length / 3; k++) {
      p[0] = bp[k * 3]; p[1] = bp[k * 3 + 1]; p[2] = bp[k * 3 + 2];
      const u = bst[k * 2], v = bst[k * 2 + 1];
      p[1] += crest(p, u);
      const w = wobble(p, u, v);
      const l = Math.hypot(p[0], p[1] - splineAt(BODY_KEYS, 'yc', p[2])) || 1;
      p[0] += (p[0] / l) * w;
      p[1] += ((p[1] - splineAt(BODY_KEYS, 'yc', p[2])) / l) * w;
      bp[k * 3] = p[0]; bp[k * 3 + 1] = p[1]; bp[k * 3 + 2] = p[2];
    }
    // the sweep hands back v ∈ [0,1]; the body sheet only owns the top
    // BODY_V_MAX of the texture, below which the atlas and the white strip live
    for (let k = 1; k < bst.length; k += 2) bst[k] *= BODY_V_MAX;
  }
  FACE_RANGES = carveFace(bodyPiece);
  // the body's tone comes from the sheet, so its vertex colour is pure cavity
  b.add(bodyPiece, { color: AO_WHITE });

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
      return aoMul(mixLin(base, nostrilC, nostrilField(p) * 0.9), p);
    },
  });

  // ---- legs, hoof tips darkened by the sample's own height
  const legY = LEG_KEYS.map((k) => k[0]);
  for (const name of ['legFL', 'legFR', 'legBL', 'legBR']) {
    const part = P[name];
    b.add(sweep(legSamples(legDrop(part)), LIMB_RADIAL), {
      uv: BLANK_UV,
      matrix: partMatrix(part, [0, part.he[1], 0]),
      // SPEC "Leg/hoof color": pink → magenta, never brown.
      //
      // The round-1 review measured this ramp rendering #ad757a / #c2576c /
      // #37181a — dusty mauve reading as brown. Two things were wrong. The mix
      // into skinShade was 45%, which under a key light that never reaches the
      // undercarriage bottoms out almost black; and the hoof was only barely
      // more saturated than the shank, so nothing on the leg ever POPPED. Now
      // the shank barely shades at all (the fill light in buildScene does that
      // job in a way that keeps the hue), and the hoof takes the vivid
      // reference-photo pink over most of the knob so the foot reads as a
      // separate, brighter thing than the leg above it.
      color: (u, v, p) => {
        const y = legY[Math.round(v * (legY.length - 1))];
        const h = 1 - smoothstep(HOOF_TOP - 0.016, HOOF_TOP + 0.022, y);
        const t = 1 - smoothstep(0.000, HOOF_TOP * 0.38, y);
        const up = smoothstep(0.11, 0.26, y);
        const shank = mixLin(mixLin(skin, skinLight, up * 0.45), skinShade,
                             (1 - up) * 0.20);
        // …times the cavity term, which is what makes the shank emerge FROM the
        // belly instead of being parked against it
        return aoMul(mixLin(mixLin(shank, hoofC, h), hoofTipC, t * 0.55), p);
      },
    });
  }

  // ---- ears. SPEC.md: both ears look symmetric, only the COLLIDER sweep
  // differs, so both visual ears are built from the +X collider ear and the
  // −X one is its exact reflection.
  const earMatrix = partMatrix(P.ear);
  /* ROUND-3 REVIEW: "The ear reads as a hole punched in the head."
   *
   * MEASURED cause, and it is shading rather than shape: the old ramp mixed toward
   * `skinDeep` on the SWEEP parameter alone, so every part of the paddle away from
   * the root went dark — including the whole UNDERSIDE, which is the face the
   * camera sees of the FAR ear once it clears the head's silhouette. A dark oval
   * with a lit rim, sitting inside a head outline, is a socket.
   *
   * The ear is lit like a thin lobe instead. `u` runs around the paddle's section
   * and its ey is −Y, so `cos(2πu)` is +1 on the TOP face and −1 underneath: the
   * top takes light (it faces the key), the underside deepens only mildly, and the
   * tip carries the last of the shading. The AO site above is small and weak for
   * the same reason. */
  /* ROUND-3 also: "its inner surface is a flat plum/mauve plane with a hard
   * elliptical outline and NO RIM THICKNESS; its outer surface is unshaded
   * near-white with no thickness either. At reveal magnification it reads as a
   * wound or a slice of meat."
   *
   * Two values were doing all the work and both were at their extremes: the top
   * face lifted 34% toward `skinLight` (a near-white plane) and the underside sank
   * 40% toward `skinDeep` (a flat plum plane), with nothing in between them. A real
   * ear lobe is three things — a lit top, a shaded underside, and a bright rolled
   * EDGE between them where the thickness catches light. `edge` is that edge: the
   * section's ey is −Y and its ex is +Z, so `cos(2πu)` is +1 on top and −1
   * underneath, and `1 − |cos|` peaks exactly on the two rims. Lifting the rim
   * (rather than darkening it) is what gives the paddle a readable thickness, and
   * it is also what stops the underside from being a single flat tone.
   */
  const earColor = (u, v, p) => {
    const up = Math.cos(u * Math.PI * 2);
    const edge = 1 - Math.abs(up);
    // …and the top face is lifted only 14%, not 34%: MEASURED against the head in
    // a side-rest screenshot, the old value made the near ear the BRIGHTEST thing
    // on the pig, so it read as a pale flap laid over the cheek rather than as part
    // of the same moulding. The rim carries the thickness now; the face just tilts.
    let c = mixLin(skin, skinLight, clamp(up, 0, 1) * 0.14 + edge * edge * 0.26);
    c = mixLin(c, skinDeep, clamp(-up, 0, 1) * 0.30 + smoothstep(0.62, 1.0, v) * 0.22);
    return aoMul(c, p);
  };
  b.add(sweep(earSamples(), LIMB_RADIAL), { uv: BLANK_UV, matrix: earMatrix, color: earColor });
  b.add(sweep(earSamples(), LIMB_RADIAL), { uv: BLANK_UV, matrix: earMatrix, color: earColor, mirrorX: true });

  const geo = b.toGeometry();

  // ---- tail (TubeGeometry along a helix), merged in by hand
  const { geo: tg, tub, rad } = tailGeometry();
  const merged = mergeInto(geo, tg, {
    uv: BLANK_UV,
    color: (i, p) => {
      const t = Math.floor(i / (rad + 1)) / tub;
      return aoMul(mixLin(skin, skinDeep, smoothstep(0.45, 1.0, t) * 0.8), p);
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
    const c = o.color(i, [sp.getX(i), sp.getY(i), sp.getZ(i)]);
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
let MAT = null;

/**
 * The microsurface sheet. Two channels of the same tiled noise, used as the
 * clearcoat's roughness map and as a very shallow normal map.
 *
 * ROUND-2 REVIEW: "the pigs read as matte clay, not rubber toys … at maximum
 * magnification with the 2.3-intensity key light there is not one specular
 * hotspot anywhere on the body." A uniform clearcoat of 0.16 blurred to 0.62
 * roughness cannot produce a hotspot: the coat is 16% present and its lobe is
 * smeared across most of the hemisphere. A glossy vinyl toy has the opposite —
 * a nearly full-strength coat with a TIGHT lobe, plus mould/wear breakup so the
 * hotspot has structure instead of being an airbrushed blob. This sheet is the
 * breakup; `clearcoat`/`clearcoatRoughness` below are the tight lobe.
 */
let MICRO = null;
function microSurface() {
  if (MICRO || !HAS_DOM) return MICRO;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  let s = 24681357;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  ctx.fillStyle = '#8a8a8a';
  ctx.fillRect(0, 0, S, S);
  // soft blotches = polish variation; the coat is glossier in some places
  for (let i = 0; i < 220; i++) {
    const x = rnd() * S, y = rnd() * S, r = S * (0.02 + rnd() * 0.07);
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    const up = rnd() > 0.5;
    rg.addColorStop(0, up ? 'rgba(255,255,255,0.34)' : 'rgba(0,0,0,0.30)');
    rg.addColorStop(1, 'rgba(128,128,128,0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 7);
    ctx.fill();
  }
  // fine grain = the vinyl's own texture; this is what breaks the hotspot up
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() + rnd() - 1) * 26;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const rough = new THREE.CanvasTexture(cv);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  rough.repeat.set(8, 8);

  // A shallow normal map from the same field: flat blue with the grain in x/y.
  const nv = document.createElement('canvas');
  nv.width = nv.height = S;
  const nc = nv.getContext('2d');
  const src = ctx.getImageData(0, 0, S, S).data;
  const dst = nc.createImageData(S, S);
  const at = (x, y) => src[(((y + S) % S) * S + ((x + S) % S)) * 4];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) / 255;
      const gy = (at(x, y + 1) - at(x, y - 1)) / 255;
      const o = (y * S + x) * 4;
      dst.data[o] = clamp(128 - gx * 90, 0, 255);
      dst.data[o + 1] = clamp(128 - gy * 90, 0, 255);
      dst.data[o + 2] = 255;
      dst.data[o + 3] = 255;
    }
  }
  nc.putImageData(dst, 0, 0);
  const normal = new THREE.CanvasTexture(nv);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.repeat.set(8, 8);

  MICRO = { rough, normal };
  return MICRO;
}

function pigMaterial() {
  if (MAT) return MAT;
  const micro = microSurface();
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: skinTexture(),
    vertexColors: true,
    // The BODY stays soft — a rubber pig is not a mirror. The gloss is entirely
    // in the clearcoat, which is how real painted vinyl works: a diffuse pigment
    // layer under a thin hard lacquer.
    roughness: 0.52,
    metalness: 0.0,
    sheen: 0.55,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0xffd3de),
    /* 0.16/0.62 → 0.85/0.16 → 0.66/0.27.
     *
     * ROUND-3: "the gloss overshot from round 2's matte-clay problem into glazed
     * porcelain … one long unbroken specular streak running the full length of each
     * pig's back plus a second broad hotspot on the rump — a wet latex balloon.
     * microSurface() is not visibly breaking the hotspot at ANY magnification."
     *
     * Both halves are real and they are different faults. The STREAK is the coat's
     * strength and lobe width: a nearly-full coat with a 0.16 lobe on a smooth
     * barrel produces one continuous highlight, and a continuous highlight along the
     * back is read as a shape (the review read it as a crease in round 2 and as
     * latex in round 3). The BREAKUP failing is a separate bug — the sheet was there
     * but its normal was too shallow (0.28) and its tile too large (5×) to modulate
     * a lobe that tight, so it did nothing visible. 0.66/0.27 with a 0.44 normal at
     * 8× keeps a real specular that still says vinyl, and the grain now shows up
     * inside it. Satin PVC, which is what the reference photos are. */
    clearcoat: 0.66,
    clearcoatRoughness: 0.27,
    clearcoatRoughnessMap: micro ? micro.rough : null,
    normalMap: micro ? micro.normal : null,
    envMapIntensity: 0.85,
  });
  if (micro) m.normalScale.set(0.44, 0.44);
  MAT = m;
  return m;
}

/**
 * buildPig() — SPEC.md contract.
 * Origin = collider COM, +Z = snout, +Y = up when trotting, ~1 unit long.
 * There is exactly one kind of pig: identical geometry, identical material,
 * both carrying the black dot on the -X flank. Nothing anywhere may call one
 * of them "the dot pig".
 */
export function buildPig() {
  GEO = GEO || buildPigGeometry();

  // Two pigs, one shared geometry and one shared material — but each pig needs
  // its OWN expression, and an expression is nothing but a UV offset. So every
  // buffer except `uv` is shared (same GL buffer, no extra memory); `uv` is a
  // per-pig copy. Still one mesh, one material, one draw call per pig.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', GEO.getAttribute('position'));
  geo.setAttribute('normal', GEO.getAttribute('normal'));
  geo.setAttribute('color', GEO.getAttribute('color'));
  geo.setAttribute('uv', GEO.getAttribute('uv').clone());
  geo.setIndex(GEO.getIndex());
  geo.boundingBox = GEO.boundingBox;
  geo.boundingSphere = GEO.boundingSphere;

  const mesh = new THREE.Mesh(geo, pigMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'pig-mesh';
  const g = new THREE.Group();
  g.name = 'pig';
  g.add(mesh);
  g.userData = {
    triangles: GEO.getIndex().count / 3,
    vertices: GEO.getAttribute('position').count,
    expression: 'neutral',
    faceUV: geo.getAttribute('uv'),
  };
  return g;
}

/**
 * setExpression(pigGroup, state) — SPEC "Character & expressions".
 *
 * Swaps which atlas cell the two cheek patches sample. No canvas work, no new
 * texture, no material churn: ~350 floats and one small buffer re-upload, and
 * only when the state actually changes, so it is free to call every frame.
 * Unknown states are ignored (they leave the pig as it was) rather than throwing
 * in the middle of a replay.
 *
 * @param {THREE.Group} pigGroup  a group from buildPig()
 * @param {string} state          one of EXPRESSIONS
 * @returns {boolean}             true if the face changed
 */
export function setExpression(pigGroup, state) {
  const ud = pigGroup && pigGroup.userData;
  if (!ud || !ud.faceUV || !FACE_RANGES) return false;
  const e = EXPRESSIONS.indexOf(state);
  if (e < 0 || ud.expression === state) return false;
  ud.expression = state;
  const uv = ud.faceUV.array;
  for (const r of FACE_RANGES) {
    const cell = faceCell(faceCellIndex(e, r.side));
    const ox = cell.x / TEX_W, oy = cell.y / TEX_H;
    const loc = r.local;
    for (let k = 0; k < r.count; k++) {
      const o = (r.start + k) * 2;
      uv[o] = ox + loc[k * 2];
      uv[o + 1] = oy + loc[k * 2 + 1];
    }
  }
  ud.faceUV.needsUpdate = true;
  return true;
}

/** current expression of a pig group (defaults to 'neutral') */
export function getExpression(pigGroup) {
  return (pigGroup && pigGroup.userData && pigGroup.userData.expression) || 'neutral';
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
    /* ROUND-3 REVIEW: "green centre L125-128, green outer L84-107 … green and
     * rough are the same tone, so the zone the physics deadens has no visual
     * existence beyond a 0.22-opacity mint hairline."
     *
     * THIS was the green's own collapse — not the rough's tone. The green sheet
     * covers the whole r = 2.7 disc, and this vignette took its outer edge down by
     * 0.60 alpha of near-black, i.e. the green faded to the rough's tone all by
     * itself and no re-tinting of the OTHER zones could have made the boundary
     * read. A putting green is evenly lit; the falloff belongs at the board's
     * outer edge (boardFoot below), not across the target the player aims at. What
     * is left here is a whisper — enough to keep the disc from looking like a flat
     * cutout, nowhere near enough to swallow a zone. */
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(1, size / size);
    const rg = ctx.createRadialGradient(0, 0, size * 0.30, 0, 0, size * 0.74);
    rg.addColorStop(0, 'rgba(10,32,24,0)');
    rg.addColorStop(0.62, 'rgba(10,32,24,0.01)');
    rg.addColorStop(1, 'rgba(6,22,16,0.05)');
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

/**
 * The backdrop: a big cylinder with a vertical gradient, drawn from the inside.
 *
 * It is unlit (MeshBasicMaterial) on purpose — it is scenery, not geometry, and
 * it must not pick up the key light or cast/receive anything. What it buys is a
 * HORIZON: the felt now meets a lit wall rather than the void, so the reveal
 * camera dropping to y 3.6 frames a room instead of a black band, and the disc's
 * rim reads as an object on a surface instead of a cropped shape.
 */
let BACKDROP_TEX = null;
function backdropTexture() {
  if (BACKDROP_TEX || !HAS_DOM) return BACKDROP_TEX;
  const cv = document.createElement('canvas');
  cv.width = 4;
  cv.height = 256;
  const ctx = cv.getContext('2d');
  // Bottom of the sheet = bottom of the wall. The wall is BRIGHTEST where it
  // meets the cloth and falls away upward, which is what makes a horizon read.
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, '#0b1a15');
  g.addColorStop(0.30, PALETTE.sky);
  g.addColorStop(0.66, '#2b544a');
  g.addColorStop(0.88, PALETTE.horizon);
  g.addColorStop(0.97, '#5a917d');
  g.addColorStop(1.00, '#3d6c5c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  BACKDROP_TEX = new THREE.CanvasTexture(cv);
  BACKDROP_TEX.colorSpace = THREE.SRGBColorSpace;
  BACKDROP_TEX.wrapS = THREE.RepeatWrapping;
  return BACKDROP_TEX;
}

/** Radius of the room wall. See buildBackdrop for why it is not 26. */
const WALL_R = 13.5;
const WALL_H = 9.5;

function buildBackdrop() {
  /* ROUND-2 REVIEW: "buildBackdrop is a cylinder of radius 26 and height 22 —
   * 5.6x the board radius — so it never enters frame at the play camera; at the
   * low reveal camera the world visibly ends at a hard elliptical cliff about two
   * metres past the felt."
   *
   * Both halves of that were the same mistake — the wall was so far out and so
   * tall that no shot ever contained the JOIN between the cloth and the wall,
   * which is the only part of a backdrop that does any work. It is now a room the
   * board actually sits in: the wall is 13.5 m out (3x the board, close enough
   * that the reveal camera at y≈2 frames its base) and 9.5 m tall (low enough
   * that its top stays out of frame instead of ending in a straight seam with
   * black above it). The cloth plane is 60 m across, so it still runs well past
   * the wall's foot and the two can never gap.
   */
  const geo = new THREE.CylinderGeometry(WALL_R, WALL_R, WALL_H, 64, 1, true);
  const m = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      map: backdropTexture(),
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: true,
    }),
  );
  // the bottom of the wall sits a hair below the table so no seam shows
  m.position.y = WALL_H / 2 - 0.06;
  m.name = 'backdrop';
  m.renderOrder = -2;
  return m;
}

/**
 * The soft dark join where the cloth runs into the wall — a wide unlit ring that
 * darkens the far cloth. A real room has an ambient-occlusion gradient there;
 * without it the wall's foot is a hard geometric line on a flat floor, which is
 * the "cliff" the round-2 review saw.
 */
function buildWallFoot() {
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  // A radial gradient on a PLANE, not a RingGeometry: three.js maps a ring's uv
  // planar-ly, not radially, so a vertical strip texture on a ring comes out as a
  // linear wipe across the floor instead of a halo around the wall.
  const rg = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  rg.addColorStop(0.00, 'rgba(6,16,13,0)');
  rg.addColorStop(0.48, 'rgba(6,16,13,0)');
  rg.addColorStop(0.78, 'rgba(6,16,13,0.20)');
  rg.addColorStop(1.00, 'rgba(4,11,9,0.52)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  // A CIRCLE, not a plane. MEASURED in a reveal screenshot: on a square plane the
  // radial gradient's outermost stop covers the square's CORNERS too, so the
  // darkening had a straight-edged silhouette — a big faceted quadrilateral
  // hanging over the far felt, which is exactly the "hard geometric seam" the
  // backdrop was supposed to remove. CircleGeometry's uvs fill the unit square, so
  // the gradient's r = 1 lands precisely on the wall's base circle.
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(WALL_R, 64),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = -0.028;
  m.name = 'wall-foot';
  m.renderOrder = -1;
  return m;
}

let FELT = null;
function feltTextures() {
  if (FELT || !HAS_DOM) return FELT;
  // ROUND-2 REVIEW, "the board still floats in a void": every sheet below is now
  // the ONLY source of its surface's tone. The materials that use them pass
  // color 0xffffff — see zoneDisc and buildBoard. Painting a tone here AND
  // setting the same tone as the material colour squares the albedo, which is
  // what made a luminance-72 table render at luminance 36, five levels off the
  // page background behind the canvas.
  const green = new THREE.CanvasTexture(
    noiseCanvas(1024, PALETTE.felt1, PALETTE.felt2, { vignette: true, fibres: 5200 }),
  );
  green.colorSpace = THREE.SRGBColorSpace;
  green.anisotropy = 8;

  // one sheet across the whole disc, not tiled: CircleGeometry's UVs fill the
  // unit square, so any repeat > 1 puts visible square seams on the felt
  const disc = (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    return t;
  };
  // SPEC "Board design" wants the zones tinted progressively DARKER outward, so
  // the green reads as the place to land. MEASURED on the first build of this fix:
  // green 123, rough 135 — the rough was the brightest thing on the board. These
  // are re-picked against the rendered numbers, not the hexes.
  // ROUND-3 REVIEW, MEASURED along +X: green centre 125-128, ROUGH 84-99, FRINGE
  // 54-60. Two faults, and the first one was NOT here (see the vignette note in
  // noiseCanvas — the green was fading to the rough's tone on its own). The second
  // is: "the fringe is a near-black moat", and 54 against a 90 rough and a ~120
  // green is a hole in the table, not the last band of a putting green. The steps
  // below are picked to render as a legible, EVEN ladder — roughly green 124,
  // rough 104, fringe 82 — which is the progression "Board design" always claimed
  // and which leaves the fringe visibly felt rather than visibly absent.
  const rough = disc(new THREE.CanvasTexture(
    noiseCanvas(512, '#2c5c46', '#26553f', { fibres: 4200, grain: 0.20 }),
  ));
  const fringe = disc(new THREE.CanvasTexture(
    noiseCanvas(512, '#254c3a', '#1f4531', { fibres: 3600, grain: 0.22 }),
  ));

  // The table cloth around the board — coarse and tiled, so the surround reads
  // as a real surface receding into the room rather than a flat void.
  //
  // Deliberately NO corner-to-corner gradient: with one, every 6.7 m tile was a
  // light-corner-to-dark-corner ramp and the repeat showed up as a visible
  // checkerboard of brighter and darker squares across the whole cloth. The tone
  // is flat and the grain, blotches and fibres carry the texture instead.
  const table = new THREE.CanvasTexture(
    noiseCanvas(512, PALETTE.table, PALETTE.table, { fibres: 3000, grain: 0.26 }),
  );
  table.colorSpace = THREE.SRGBColorSpace;
  table.wrapS = table.wrapT = THREE.RepeatWrapping;
  table.repeat.set(5, 5);
  table.anisotropy = 8;

  FELT = { green, rough, fringe, table };
  return FELT;
}

/**
 * The stage: a big soft pool of light on the table, centred on the board.
 *
 * ROUND-2 REVIEW, "26.8% of the portrait 3D viewport is dead black". The top
 * quarter of the portrait frame is TABLE, not sky — the play camera's top ray
 * lands on the cloth ~9 m behind the board — so the fix for the void is a table
 * that is (a) actually lit, which is the albedo fix above, and (b) shaped, so the
 * eye is told where to look. This is an unlit additive-ish decal, cheap and
 * shadow-free, that brightens the felt under the board and falls off into the
 * room. Without it a correctly-lit 60 m plane is uniformly flat, which reads as
 * a backdrop rather than as a surface.
 */
function stagePool() {
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const rg = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // MEASURED and pulled back: at 0.30 the pool lifted the cloth beside the board
  // to luminance 135 against a green of 124 — a brighter surround than subject,
  // which is the same composition mistake as the palette being too light. These
  // land the cloth near 100: clearly lit, clearly secondary.
  // ROUND-3: pulled back again, for the same reason and with the same measurement.
  // The pool's inner two thirds land on CLOTH (the board is 4.6 m of a 12.5 m
  // pool), so every point of alpha here brightens the surround, not the subject —
  // it was carrying the cloth to 113-127 against a rough of 90. It now peaks under
  // the board, where the discs cover it anyway, and is nearly gone by the felt's
  // edge, so its whole job is the falloff into the room.
  rg.addColorStop(0.00, 'rgba(196,255,226,0.10)');
  rg.addColorStop(0.34, 'rgba(170,240,208,0.055)');
  rg.addColorStop(0.62, 'rgba(140,215,185,0.018)');
  rg.addColorStop(1.00, 'rgba(120,200,170,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  // likewise a circle: a square plane would put the gradient's tail on its
  // corners and give the pool a visible straight edge
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(12.5, 64),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: true,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = -0.030;
  m.name = 'stage-pool';
  m.renderOrder = -1;
  return m;
}

/**
 * The board's own contact shadow on the cloth — the soft ambient gradient that
 * makes a felt disc REST on a table instead of being a hole punched in it.
 *
 * ROUND-3 REVIEW: "The board's outer edge is a 2:1 luminance cliff with no
 * falloff. MEASURED at the same buffer row on both sides: left column L130 → L74
 * across 4px, right column L127 → L81 → L64 across 8px. A 66-level drop in 4
 * pixels reads as a punched hole in the table … Needs a soft radial falloff /
 * ambient gradient at the fringe-to-cloth transition, the way buildWallFoot does
 * for the wall join."
 *
 * TWO decals, because the cliff has two sides and they are on opposite sides of
 * the felt geometry. `halo` sits on the CLOTH under the discs and darkens it
 * hardest at the rim, releasing over ~1.5 m, so the cloth arrives at the board
 * already most of the way down. `rim` sits ON TOP of the discs, transparent until
 * it is past the rough, and shades the fringe's last few centimetres — a felt
 * edge is a rolled-over lip and the light does fall off there. Together they turn
 * a step into a ramp that crosses the seam.
 *
 * Same rules as buildWallFoot: CircleGeometry, never a PlaneGeometry (a square
 * plane puts the gradient's tail on its corners and gives the halo a straight
 * edge), unlit, no depth write.
 */
const FOOT_R = BOARD.stopR + 1.55;
function feltDecal(radius, y, stops, name) {
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const rg = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, a] of stops) rg.addColorStop(at, `rgba(7,20,15,${a})`);
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 96),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  m.name = name;
  return m;
}

function buildBoardFoot() {
  const g = new THREE.Group();
  g.name = 'board-foot';
  const rim = BOARD.stopR / FOOT_R;               // where the felt's edge lands
  // outward: on the cloth, under the discs (cloth is at y −0.035)
  const halo = feltDecal(FOOT_R, -0.020, [
    [0.00, 0.34], [rim * 0.94, 0.36], [rim, 0.36],
    [rim + (1 - rim) * 0.30, 0.19], [rim + (1 - rim) * 0.64, 0.06], [1.00, 0],
  ], 'board-foot-halo');
  halo.renderOrder = -1;
  // inward: on top of the fringe only — the rolled lip of the felt
  const inner = BOARD.roughR / BOARD.stopR;
  const lip = feltDecal(BOARD.stopR, 0.0072, [
    [0.00, 0], [inner, 0], [inner + (1 - inner) * 0.45, 0.06],
    [0.985, 0.16], [1.00, 0.19],
  ], 'board-foot-lip');
  lip.renderOrder = 1;
  g.add(halo, lip);
  return g;
}

/** One felt disc of the board. Discs are stacked, largest first, a hair apart. */
function zoneDisc(radius, layer, { map, color, roughness, sheen }) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 96),
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      map: map || null,
      roughness,
      metalness: 0,
      sheen,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color(0x6fbf99),
      envMapIntensity: 0.22,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.0015 * layer;
  m.receiveShadow = true;
  return m;
}

/**
 * A faint line where one zone becomes the next, so the board reads as zoned.
 *
 * ROUND-3 REVIEW called the old one "a 0.22-opacity mint hairline" doing all the
 * work of a zone boundary. With the tones now stepping properly (see
 * feltTextures) the line's job is smaller and different: the discs are STACKED,
 * so what a real one would show at the boundary is the upper disc's own edge
 * shadow on the lower one — a dark seam, not a mint glow. Two thin rings do it:
 * a shade just outside the boundary and a highlight just inside, which is what a
 * cut felt edge looks like.
 */
function zoneRing(radius) {
  const g = new THREE.Group();
  const shade = new THREE.Mesh(
    new THREE.RingGeometry(radius, radius + 0.05, 96),
    new THREE.MeshBasicMaterial({
      color: 0x08150f, transparent: true, opacity: 0.30, depthWrite: false,
    }),
  );
  shade.rotation.x = -Math.PI / 2;
  shade.position.y = 0.0066;
  const m = new THREE.Mesh(
    new THREE.RingGeometry(radius - 0.030, radius - 0.004, 96),
    new THREE.MeshBasicMaterial({
      color: 0xbfe8d2, transparent: true, opacity: 0.13, depthWrite: false,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.0065;
  g.add(shade, m);
  return g;
}

/**
 * buildBoard() — SPEC.md "Board design". The table, then three concentric felt
 * discs whose radii ARE the physics zones (BOARD.greenR / roughR / stopR), then
 * a thin ring on each boundary. No walls: a pig leaning on a wall rests in none
 * of the six named poses, and this board makes that rest impossible.
 */
export function buildBoard() {
  const felt = feltTextures();
  const g = new THREE.Group();
  g.name = 'board';

  // ROUND-1 REVIEW: "there is no world." The table used to be painted in
  // PALETTE.bg1 — the exact same token as the page background behind the canvas
  // — so the board floated in a black void with no floor and no horizon, which
  // is worst at the reveal, where the camera drops to y 3.6 and the top of the
  // frame becomes a black band. The table is now a real, visibly lighter surface
  // with its own texture, and a backdrop dome (below) gives the frame a horizon
  // to sit against instead of nothing.
  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshPhysicalMaterial({
      // color 0xffffff, NOT PALETTE.table — the sheet already IS PALETTE.table,
      // and setting both squared the albedo. See PALETTE.table's note: this one
      // line is most of why the round-1 "there is no world" fix never landed.
      color: 0xffffff,
      map: felt && felt.table,
      roughness: 0.88,
      metalness: 0,
      sheen: 0.16,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color(0x4c8f74),
      envMapIntensity: 0.28,
    }),
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.035;
  // Deliberately NOT a shadow receiver. The key's ortho shadow frustum is fitted
  // to BOARD_BOX (±4.8 m), and outside a shadow camera the depth lookup clamps to
  // the border texel — which paints a hard-edged shadowed region on the cloth just
  // past the felt. Nothing ever casts onto the cloth anyway: the pigs cannot leave
  // the board, so the discs below are the only receivers that matter.
  table.receiveShadow = false;
  table.name = 'table';
  g.add(table);

  g.add(buildBackdrop());
  if (HAS_DOM) g.add(buildWallFoot(), stagePool(), buildBoardFoot());

  // Drawn largest first so each smaller zone sits on top of the last, and tinted
  // progressively darker outward — the lively green reads as the place to land,
  // the rough as scrub, the fringe as the edge of the world. Every one of them
  // passes color 0xffffff and lets its own sheet carry the tone (see above).
  const fringe = zoneDisc(BOARD.stopR, 0, {
    map: felt && felt.fringe, color: 0xffffff, roughness: 0.99, sheen: 0.08,
  });
  fringe.name = 'zone-fringe';
  const rough = zoneDisc(BOARD.roughR, 1, {
    map: felt && felt.rough, color: 0xffffff, roughness: 0.97, sheen: 0.14,
  });
  rough.name = 'zone-rough';
  const green = zoneDisc(BOARD.greenR, 2, {
    map: felt && felt.green, color: 0xffffff, roughness: 0.95, sheen: 0.24,
  });
  green.name = 'zone-green';
  g.add(fringe, rough, green);

  const rings = new THREE.Group();
  rings.name = 'zone-rings';
  rings.add(zoneRing(BOARD.greenR), zoneRing(BOARD.roughR));
  g.add(rings);

  return g;
}

/* ================================================================= the cup */

/**
 * buildCup() — the shaker the pigs are tossed FROM.
 *
 * ROUND-2 REVIEW, and it is the most damning note in the set: "there is no cup,
 * no hand, and no anticipation. SPEC reserves frame volume for the cup (z 2.3,
 * y 1.32) and describes LAUNCH_MS as tweening 'out of the cup', but no cup
 * exists. So 'hold to shake' is two pigs vibrating on bare felt, then a ~150 ms
 * snap from the table to 1.2 m with no windup, no arm, no container."
 *
 * Scale check, because a cup is the one prop whose size is checkable: the pigs
 * are 1.0 board-metre long and the board is a 9.2 m disc, so one board-metre is
 * about 4 cm of real pig. A real shaker is a bit under two pig-lengths across,
 * which is the 1.24 m mouth below — big enough that two pigs genuinely disappear
 * into it, which is what lets game.js hide them while it rattles.
 *
 * Returned upright with its BASE at the group origin, so game.js can set
 * `position` to a felt point and `rotation.x` to tip it without composing
 * transforms. Origin at the base is also the pivot a real cup tips about.
 *
 * @returns {THREE.Group}
 */
export function buildCup() {
  const g = new THREE.Group();
  g.name = 'cup';
  const rBase = 0.46, rMouth = 0.62, H = 1.02;

  const shell = new THREE.CylinderGeometry(rMouth, rBase, H, 40, 1, true);
  const outer = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#c8477e'),
    roughness: 0.34,
    metalness: 0,
    clearcoat: 0.9,
    clearcoatRoughness: 0.14,
    sheen: 0.3,
    sheenColor: new THREE.Color(0xffc0d6),
    envMapIntensity: 0.9,
    side: THREE.FrontSide,
  });
  const outerMesh = new THREE.Mesh(shell, outer);
  outerMesh.position.y = H / 2;
  outerMesh.castShadow = true;
  outerMesh.receiveShadow = true;
  g.add(outerMesh);

  // The inside, drawn as its own back-facing shell. Without it the cup is a
  // one-sided tube and you can see straight through the near wall into the felt,
  // which is exactly the tell that gives a "prop" away.
  const innerMesh = new THREE.Mesh(
    shell,
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#6d1f3d'),
      roughness: 0.78,
      metalness: 0,
      side: THREE.BackSide,
    }),
  );
  innerMesh.position.y = H / 2;
  g.add(innerMesh);

  // floor of the cup, so looking in from above sees a bottom, not the felt
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(rBase * 0.99, 32),
    new THREE.MeshStandardMaterial({ color: new THREE.Color('#571630'), roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.012;
  g.add(floor);

  // a rolled lip: reads as moulded plastic and catches the key light, which is
  // what makes the silhouette legible against the felt at the play camera
  const lip = new THREE.Mesh(
    new THREE.TorusGeometry(rMouth, 0.052, 10, 40),
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#f291ac'),
      roughness: 0.24,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.10,
      envMapIntensity: 1.1,
    }),
  );
  lip.rotation.x = -Math.PI / 2;
  lip.position.y = H;
  lip.castShadow = true;
  g.add(lip);

  // a base bead, same trick at the other end
  const foot = new THREE.Mesh(
    new THREE.TorusGeometry(rBase, 0.040, 8, 32),
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#a83266'),
      roughness: 0.36,
      metalness: 0,
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
    }),
  );
  foot.rotation.x = -Math.PI / 2;
  foot.position.y = 0.035;
  g.add(foot);

  g.userData = { height: H, mouthR: rMouth };
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

/** The whole board, for shadow fitting and as the default camera focus. */
const BOARD_BOX = new THREE.Box3(
  new THREE.Vector3(-(BOARD.stopR + 0.2), -0.05, -(BOARD.stopR + 0.2)),
  new THREE.Vector3(BOARD.stopR + 0.2, 1.9, BOARD.stopR + 0.2),
);
/** Height the camera aims at: about a pig's standing height off the felt. */
const LOOK_Y = 0.24;

/**
 * Distance-fit the camera so `box` fills the frame with `margin` to spare.
 * Called on every resize, which is what keeps the portrait framing honest on
 * phones as different as a SE and a Max.
 */
function frameBox(camera, box, { pitchDeg = 52, margin = 0.94, target } = {}) {
  const pitch = pitchDeg * D2R;
  const dir = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch));
  const tgt = target || new THREE.Vector3(0, LOOK_Y, -0.1);
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
 * @returns {{renderer, scene, camera, lights, env, boardBox, resize, render,
 *            frame, setFocus, dispose, pitchDeg}}
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

  // The hemisphere's GROUND colour is what lights every downward-facing surface,
  // which on this pig means the entire undercarriage: belly, inner legs, hooves.
  // At 0x24513f (dark green) the legs bottomed out at #37181a — the dark dusty
  // mauve the round-1 review measured and correctly called brown. It is now a
  // much lighter, warmer bounce, which is the difference between a hoof that
  // reads pink and one that reads dirty.
  // ROUND-2: the reveal now really is a close-up from a LOW camera, which is the
  // first shot in the game's history that shows the undercarriage at size. At the
  // old ground colour the far pig's shaded flank measured as a dark maroon that
  // reads brown — the exact failure SPEC's "Leg/hoof color" section forbids — so
  // the bounce is lighter and warmer again.
  const hemi = new THREE.HemisphereLight(0xcfe8f5, 0xa6cbb6, 0.50);
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
  fitShadowCamera(key, BOARD_BOX);

  // ROUND-2: the reveal can now stand roughly OPPOSITE the key, where this rim was
  // the dominant light on the pig — and a strongly blue rim on a pink albedo reads
  // LAVENDER, which is as wrong as brown. Warmer and weaker.
  const rim = new THREE.DirectionalLight(0xc4e2ff, 0.40);
  rim.position.set(-3.6, 3.0, -5.0);
  scene.add(rim);

  const bounce = new THREE.DirectionalLight(0xffd9e6, 0.20);
  bounce.position.set(-1.2, 1.0, 6.2);
  scene.add(bounce);

  // UNDER-FILL. Aimed straight UP from below the felt, so it only ever touches
  // surfaces the key cannot reach — the undercarriage, the inner face of each
  // leg, the shaded side of every hoof. It is tinted pink rather than white on
  // purpose: the SPEC's no-browns line is about HUE, and a warm pink bounce is
  // what a pink rubber pig standing on a lit surface would actually get. It
  // casts no shadow, so it costs one extra light and nothing else.
  const under = new THREE.DirectionalLight(0xffb8cf, 0.52);
  under.position.set(0.4, -2.0, 0.8);
  under.target.position.set(0, 0.4, 0);
  scene.add(under, under.target);

  const lights = { hemi, key, rim, bounce, under };

  let focus = BOARD_BOX;
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
    boardBox: BOARD_BOX, resize, render, frame, setFocus, dispose,
    get pitchDeg() { return pitchDeg; },
  };
}

/**
 * The contact shadow under a pig — an ambient-occlusion patch, not a cast one.
 *
 * ROUND-1 REVIEW: "the pigs are never planted, and the two shadow systems are
 * inverted." The old blob was a wide, evenly soft smudge that spread its alpha
 * over a whole metre, so at rest it read as haze rather than contact. The
 * gradient below is deliberately front-loaded: two thirds of the darkness lives
 * inside the first 35% of the radius, which is the size of the actual footprint
 * of a pig lying on felt, and the outer half is only a whisper of ambient
 * darkening. That is what makes a hoof look like it is TOUCHING.
 *
 * Its partner half of the fix is in game.js `apply()`, which fades and spreads
 * this patch as the pig climbs AND turns the hard 2048-map cast shadow off once
 * the pig is airborne — the map shadow was staying razor-sharp and fully opaque
 * at y = 1.4, reading as a detached third pig on the felt.
 */
export function buildContactShadow(radius = 0.42) {
  if (!HAS_DOM) return null;
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const rg = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  rg.addColorStop(0.00, 'rgba(0,0,0,0.80)');
  rg.addColorStop(0.22, 'rgba(0,0,0,0.72)');
  rg.addColorStop(0.38, 'rgba(0,0,0,0.40)');
  rg.addColorStop(0.58, 'rgba(0,0,0,0.16)');
  rg.addColorStop(0.80, 'rgba(0,0,0,0.05)');
  rg.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.004;
  m.name = 'contact-shadow';
  return m;
}

export default {
  buildPig, buildBoard, buildCup, buildScene, buildContactShadow, PALETTE,
  pigTriangles, setExpression, getExpression, EXPRESSIONS,
};
