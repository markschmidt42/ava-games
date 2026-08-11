// SPEC.md, "Grounding must be measured, not eyeballed": transform every VISUAL
// vertex by posePlacement() and take the minimum world y, per pose.
//
//   node --import ./dev/three-hook.mjs dev/grounding.mjs
//
// Negative = the mesh presses into the felt (invisible). Positive = a gap of light
// under the pig (visible, and the thing this exists to catch). SPEC's accepted band
// is −5.4…+0.9 mm; `posePlacement`'s own 4 mm hover is included in the numbers, so
// the figure is "how far the visual reaches past the collider's support", not a
// physical gap. It is the same measurement across builds, which is what matters:
// re-run it after ANY change to BODY_PROFILE, crest(), the legs, the ear or the
// snout, and after any change to PIG_TUNING.
import * as THREE from '../vendor/three.module.js';
import { buildPig } from '../pig.js';
import { posePlacement, POSE_KEYS } from '../physics.js';

const pig = buildPig();
let geo = null;
pig.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) geo = o.geometry; });
if (!geo) {
  console.error('no pig geometry — did buildPig() change shape?');
  process.exit(1);
}

const pos = geo.getAttribute('position');
const v = new THREE.Vector3();
const q = new THREE.Quaternion();
const rows = [];
for (const pose of POSE_KEYS) {
  const pl = posePlacement(pose, { yaw: 0.3, at: [0, 0] });
  const pq = pl.quaternion;
  q.set(pq.x ?? pq[0], pq.y ?? pq[1], pq.z ?? pq[2], pq.w ?? pq[3]);
  let min = Infinity, at = null;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyQuaternion(q);
    const y = v.y + pl.position[1];
    if (y < min) {
      min = y;
      at = [pos.getX(i), pos.getY(i), pos.getZ(i)].map((n) => +n.toFixed(3));
    }
  }
  rows.push([pose, +(min * 1000).toFixed(1), at]);
}

console.log('pose            minY(mm)   lowest vertex (COM frame)');
for (const [p, m, at] of rows) {
  console.log(p.padEnd(14), String(m).padStart(7), '  ', JSON.stringify(at));
}
const worst = Math.max(...rows.map((r) => Math.abs(r[1])));
const ok = worst <= 6.0;
console.log(`\nworst |minY| = ${worst.toFixed(1)} mm — ${ok ? 'PASS' : 'FAIL'} (band ±6 mm)`);
process.exit(ok ? 0 : 1);
