// Node resolver for the bare `three` specifier that pig.js imports.
//
// In the browser the importmap in index.html maps "three" → ./vendor/three.module.js.
// Node has no importmap, so a script that wants to load pig.js headlessly (e.g.
// grounding.mjs) registers this hook first:
//
//   node --import ./dev/three-hook.mjs dev/grounding.mjs
//
// three's math and geometry are DOM-free; pig.js's HAS_DOM guards skip the canvas
// textures, so the geometry is built exactly as it is in the game.
import { fileURLToPath } from 'node:url';

const VENDOR = new URL('../vendor/three.module.js', import.meta.url).href;

export async function resolve(spec, ctx, next) {
  if (spec === 'three') return { url: VENDOR, shortCircuit: true };
  return next(spec, ctx);
}

export const __self = fileURLToPath(import.meta.url);
