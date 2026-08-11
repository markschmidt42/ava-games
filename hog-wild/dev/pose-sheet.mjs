// Draws the collider in each of its six settled poses as one SVG sheet, so the
// attitudes can be eyeballed without a browser or a pig mesh. Each pose is
// simulated to rest first, so what you see is where the pig actually ends up.
//
//   node dev/pose-sheet.mjs > dev/pose-sheet.svg
import { PigSim, POSE_KEYS, classify, PIG_CLOUD } from '../physics.js';

const VIEW_YAW = 34 * (Math.PI / 180);   // swing round to a three-quarter view
const VIEW_PITCH = 22 * (Math.PI / 180); // and look down a little
const SCALE = 190;
const COLS = 3, CELL_W = 300, CELL_H = 250;

const COLOR = {
  torso: '#f291ac', ridge: '#e0708f', head: '#f7a9bd', snout: '#ff5c7a',
  ear: '#ffd54a', ear2: '#d8c06a', tail: '#c96f8c',
  legFL: '#7ec8a0', legFR: '#5ddb92', legBL: '#4fae7c', legBR: '#3f8f66',
};

function mat3(q) {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [1 - (yy + zz), xy - wz, xz + wy, xy + wz, 1 - (xx + zz), yz - wx, xz - wy, yz + wx, 1 - (xx + yy)];
}
function hull2(pts) {
  if (pts.length < 3) return pts.slice();
  const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of s) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
  for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (up.length >= 2 && cr(up.at(-2), up.at(-1), p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}
/** world (x,y,z) -> screen (sx, sy), y up, three-quarter view */
function project(p) {
  const cx = Math.cos(VIEW_YAW), sx = Math.sin(VIEW_YAW);
  const x = p[0] * cx + p[2] * sx;
  const zz = -p[0] * sx + p[2] * cx;
  return [x * SCALE, -(p[1] * Math.cos(VIEW_PITCH) - zz * Math.sin(VIEW_PITCH)) * SCALE];
}

const sim = new PigSim({ pigs: 1 });
const cells = [];
for (const pose of POSE_KEYS) {
  sim.place(0, pose, { gap: 0.004, yaw: 0.35 });
  sim.settleInPlace(0, 1.2);
  const q = sim.pigs[0].quaternion;
  const c = classify(q);
  const m = mat3(q);
  // rotate the cloud, drop it onto the floor
  const byPart = new Map();
  let ymin = Infinity;
  for (const { part, v } of PIG_CLOUD) {
    const w = [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
    ymin = Math.min(ymin, w[1]);
    if (!byPart.has(part)) byPart.set(part, []);
    byPart.get(part).push(w);
  }
  const shapes = [];
  // draw far parts first so the near ones overlap correctly
  const order = [...byPart.entries()].sort((a, b) => {
    const za = a[1].reduce((s, p) => s + p[2], 0) / a[1].length;
    const zb = b[1].reduce((s, p) => s + p[2], 0) / b[1].length;
    return za - zb;
  });
  for (const [part, pts] of order) {
    const poly = hull2(pts.map((p) => project([p[0], p[1] - ymin, p[2]])));
    shapes.push({ part, poly, touching: c.contacts.includes(part) });
  }
  cells.push({ pose, shapes, c });
}

const W = COLS * CELL_W, H = Math.ceil(POSE_KEYS.length / COLS) * CELL_H;
const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,sans-serif">`);
out.push(`<rect width="${W}" height="${H}" fill="#14231c"/>`);
cells.forEach((cell, i) => {
  const ox = (i % COLS) * CELL_W + CELL_W / 2;
  const oy = Math.floor(i / COLS) * CELL_H + CELL_H - 62;
  out.push(`<g transform="translate(${ox} ${oy})">`);
  out.push(`<line x1="-125" y1="0" x2="125" y2="0" stroke="#2f6b52" stroke-width="3"/>`);
  for (const s of cell.shapes) {
    if (!s.poly.length) continue;
    const d = s.poly.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    out.push(`<polygon points="${d}" fill="${COLOR[s.part] || '#888'}" fill-opacity="${s.touching ? 0.95 : 0.55}"` +
      ` stroke="${s.touching ? '#fff' : '#0d1712'}" stroke-width="${s.touching ? 2 : 1}"/>`);
  }
  out.push(`<text x="0" y="34" fill="#f4fbf7" font-size="17" font-weight="700" text-anchor="middle">${cell.pose}</text>`);
  out.push(`<text x="0" y="52" fill="#a9c9b8" font-size="11" text-anchor="middle">rests on ${cell.c.contacts.join(' + ')}</text>`);
  out.push(`<text x="0" y="66" fill="#a9c9b8" font-size="11" text-anchor="middle">conf ${cell.c.confidence.toFixed(2)} · support ${cell.c.support.toFixed(3)} · off-axis ${cell.c.offAxisDeg.toFixed(1)}°</text>`);
  out.push('</g>');
});
out.push(`<text x="12" y="20" fill="#a9c9b8" font-size="12">Hog Wild pig collider — settled poses (white outline = touching the floor)</text>`);
out.push('</svg>');
console.log(out.join('\n'));
