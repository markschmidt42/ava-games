// Re-derives the POSE_UP table in physics.js from the collider's geometry.
//
//   node dev/derive-poseup.mjs        # print the block to paste into physics.js
//
// RUN THIS AFTER EVERY CHANGE TO PIG_TUNING. POSE_UP is the settled attitude of
// each pose; it is what posePlacement() uses to drop the pig into a pose for
// testing, and what classify() measures its off-axis angle against. If the
// geometry moves and POSE_UP does not, the pig gets placed slightly off its own
// equilibrium and can slide into a neighbouring rest — which looks like a
// stability failure but is really a stale constant.
//
// For each pose we take the dominant (largest-basin) support face. razorback
// and trotter are pinned to their exact axes on purpose: both have a symmetric
// family of leaning variants either side, so the middle is the right reference.
import { supportFaces } from './support-analysis.mjs';
import { makeParts, PIG_TUNING, POSE_KEYS } from '../physics.js';

const PINNED = { razorback: [0, -1, 0], trotter: [0, 1, 0] };

const over = JSON.parse(process.argv[2] || '{}');
const faces = supportFaces(makeParts({ ...PIG_TUNING, ...over }));
const best = {};
for (const f of faces) {
  if (!f.label) continue;
  if (!best[f.label] || f.omega > best[f.label].omega) best[f.label] = f;
}
const missing = POSE_KEYS.filter((k) => !best[k]);
if (missing.length) console.error(`!! no support face for: ${missing.join(', ')}`);

console.log('export const POSE_UP = {');
for (const k of POSE_KEYS) {
  const up = PINNED[k] || best[k]?.up || [0, 0, 0];
  const key = k.includes('-') ? `'${k}'` : k;
  console.log(`  ${key}: norm3([${up.map((v) => Number(v.toFixed(3))).join(', ')}]),`);
}
console.log('};');

console.error('\ndominant support face per pose:');
for (const k of POSE_KEYS) {
  const f = best[k];
  console.error('  ' + k.padEnd(11), f
    ? `margin ${f.margin.toFixed(4)}  rests on ${f.contacts.join('+')}${PINNED[k] ? '  (axis pinned)' : ''}`
    : 'NONE');
}
