// Shared collider-pig rendering for the _watch pages (arena.html, poses.html).
// One place to change how the demo pigs look.
import * as THREE from 'three';

export function shapeToGeometry(shape) {
  if (shape.halfExtents) return new THREE.BoxGeometry(shape.halfExtents.x * 2, shape.halfExtents.y * 2, shape.halfExtents.z * 2);
  if (shape.radius !== undefined && !shape.vertices) return new THREE.SphereGeometry(shape.radius, 24, 18);
  if (shape.vertices?.length) { // ConvexPolyhedron / Cylinder
    const pos = [];
    for (const f of shape.faces) for (let i = 1; i < f.length - 1; i++)
      for (const idx of [f[0], f[i], f[i + 1]]) {
        const v = shape.vertices[idx]; pos.push(v.x, v.y, v.z);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }
  return new THREE.SphereGeometry(0.05, 8, 6);
}

/**
 * Build a THREE.Group visualizing a cannon-es compound pig body.
 * Every pig gets the black dot on its RIGHT flank (-X; snout is +Z), matching
 * both the real pigs and POSE_UP['side-dot'] in physics.js.
 * @param pigBody cannon-es Body from buildPigBody()
 * @param P       the live physics.js module (for PIG_TUNING + COM)
 */
export function buildPigGroup(pigBody, P, { baseColor = 0xf6a8bc } = {}) {
  const group = new THREE.Group();
  pigBody.shapes.forEach((shape, i) => {
    const m = new THREE.Mesh(shapeToGeometry(shape),
      new THREE.MeshStandardMaterial({ color: baseColor, roughness: .6 }));
    const off = pigBody.shapeOffsets[i], or = pigBody.shapeOrientations[i];
    m.position.copy(off);
    m.quaternion.copy(or);
    m.castShadow = true;
    group.add(m);
  });

  // Painted dot: flat black disc flush on the right flank. The body re-centers
  // its shapes on the COM, so convert the build-frame flank point.
  const t = P.PIG_TUNING ?? { torsoHX: .17, torsoY: .376, torsoZ: -.13 };
  let com = [0, 0, 0];
  try { const c = P.pigMassProperties().com; if (c?.length === 3) com = c; } catch {}
  const dot = new THREE.Mesh(new THREE.CylinderGeometry(.075, .075, .012, 20),
    new THREE.MeshStandardMaterial({ color: 0x141414, roughness: .5 }));
  dot.rotation.z = Math.PI / 2; // disc face outward on ±X
  dot.position.set(-(t.torsoHX + .008) - com[0], t.torsoY - com[1], t.torsoZ - com[2]);
  group.add(dot);

  return group;
}
