// Registers three-loader.mjs, so `node --import ./dev/three-hook.mjs <script>`
// can import pig.js (which uses the bare "three" specifier) headlessly.
import { register } from 'node:module';

register('./three-loader.mjs', import.meta.url);
