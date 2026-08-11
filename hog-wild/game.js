// hog-wild/game.js
//
// State machine, turn logic, players, persistence, wake lock, UI wiring.
// See SPEC.md for the module contracts this file depends on.
//
// State machine (SPEC.md, PRD §7.1):
//   setup -> ready -> shaking -> tossing -> settling -> resolved -> (ready | turnEnd) -> win

import { revealToss, celebrate, sadness, initAudio, setMuted } from './fx.js';
import { sampleAt, duration, firstState, makeState, tweenInto, ease } from './replay.js';

/* =========================================================================
 * odds.js — loaded defensively.
 *
 * SPEC.md says game.js consumes odds.js's drawToss/scoreToss/POSES. That
 * module is owned by a different agent and may not exist yet (or may land
 * mid-build). A hard `import ... from './odds.js'` at the top of this file
 * would make the *whole game* fail to load — including Quick Toss, which
 * has no 3D dependency and should always work — the moment that file is
 * missing or briefly broken. That directly violates "never a blank page."
 *
 * So: try to load the real module at boot. If it's missing or throws, fall
 * back to an inline copy of the exact same model (PRD §5 / SPEC.md
 * "Shared vocabulary"). Once the real odds.js exists and loads cleanly, it
 * is what actually drives the game — this fallback only fires in its
 * absence, keeping "Quick Toss has identical odds" true either way.
 * ==================================================================== */

const FALLBACK_POSES = {
  'side-blank': { points: 0, p: 0.349, label: 'Sider' },
  'side-dot': { points: 0, p: 0.302, label: 'Sider' },
  razorback: { points: 5, p: 0.224, label: 'Razorback' },
  trotter: { points: 5, p: 0.088, label: 'Trotter' },
  snouter: { points: 10, p: 0.03, label: 'Snouter' },
  jowler: { points: 15, p: 0.007, label: 'Leaning Jowler' },
};
const FALLBACK_OINKER_CHANCE = 0.0038;
const FALLBACK_DOUBLE_POINTS = { razorback: 20, trotter: 20, snouter: 40, jowler: 60 };

function fallbackPickPose(rng) {
  const roll = rng();
  let cumulative = 0;
  const keys = Object.keys(FALLBACK_POSES);
  for (const key of keys) {
    cumulative += FALLBACK_POSES[key].p;
    if (roll < cumulative) return key;
  }
  return keys[keys.length - 1];
}

function fallbackDrawToss(rng = Math.random) {
  if (rng() < FALLBACK_OINKER_CHANCE) return { oinker: true };
  return { a: fallbackPickPose(rng), b: fallbackPickPose(rng) };
}

function isSideKey(key) {
  return key.startsWith('side');
}

function fallbackScoreToss(a, b) {
  const labelA = FALLBACK_POSES[a].label;
  const labelB = FALLBACK_POSES[b].label;

  if (isSideKey(a) && isSideKey(b)) {
    if (a === b) {
      return {
        type: 'sider',
        points: 1,
        headline: 'Sider! +1',
        detail: 'Both pigs landed the same way up.',
      };
    }
    return {
      type: 'pigout',
      points: 0,
      headline: 'Pig Out!',
      detail: "Opposite sides — this turn's points are gone.",
    };
  }

  if (a === b) {
    const points = FALLBACK_DOUBLE_POINTS[a];
    return {
      type: 'double',
      points,
      headline: `Double ${labelA}! +${points}`,
      detail: 'Both pigs the same — that\'s worth way more than two.',
    };
  }

  const points = FALLBACK_POSES[a].points + FALLBACK_POSES[b].points;
  const named = [a, b]
    .filter((k) => !isSideKey(k))
    .map((k) => FALLBACK_POSES[k].label)
    .join(' + ');
  return {
    type: 'mixed',
    points,
    headline: `${named}! +${points}`,
    detail:
      isSideKey(a) || isSideKey(b)
        ? 'A pig on its side is worth nothing, but the other one counts.'
        : 'Two different positions score the sum of both pigs.',
  };
}

const FALLBACK_ODDS = {
  POSES: FALLBACK_POSES,
  OINKER_CHANCE: FALLBACK_OINKER_CHANCE,
  drawToss: fallbackDrawToss,
  scoreToss: fallbackScoreToss,
};

// Exported solely so dev scripts can headlessly verify the fallback model
// (e.g. `node --experimental-vm-modules` style import in a throwaway test)
// without needing a DOM. game.js itself never imports these back.
export { FALLBACK_POSES, FALLBACK_OINKER_CHANCE, fallbackDrawToss, fallbackScoreToss };

let odds = FALLBACK_ODDS;

/** Pick a pose key from whichever odds model is active, purely for
 * display (e.g. the "tangled" flavor poses shown during an Oinker, which
 * never affect scoring). Not used for anything that must match §5 exactly. */
function pickDisplayPose() {
  const entries = Object.entries(odds.POSES);
  const roll = Math.random();
  let cumulative = 0;
  for (const [key, def] of entries) {
    cumulative += def.p;
    if (roll < cumulative) return key;
  }
  return entries[entries.length - 1][0];
}

async function loadOdds() {
  try {
    const mod = await import('./odds.js');
    if (mod && typeof mod.drawToss === 'function' && typeof mod.scoreToss === 'function' && mod.POSES) {
      odds = mod;
    } else {
      console.warn('[hog-wild] odds.js loaded but missing expected exports — using built-in fallback odds.');
    }
  } catch (err) {
    console.warn('[hog-wild] odds.js not available yet — using built-in fallback odds.', err);
  }
}

/* =========================================================================
 * 3D adapter — every call into pig.js / physics.js goes through here.
 *
 * If those modules are missing, throw, or don't match the SPEC.md contract,
 * `adapter.ready` stays false and the game runs in Quick-Toss-only mode:
 * the pen's hold-to-shake gesture is hidden and Quick Toss (identical odds,
 * §7.4) becomes the only way to play. The UI is never blank.
 * ==================================================================== */

/* The cup hovers just inside the near edge of the pen, one lane each, at about
 * the height physics.js releases from (LANE spawn is x 1.05–2.10, y 1.0–1.9,
 * z 1.5–2.7). Keeping the cup inside that window is what makes the release
 * tween a short hop rather than a visible jump. */
const CUP = [
  [-1.15, 1.32, 2.30],
  [1.15, 1.32, 2.30],
];
const GATHER_MS = 260;   // rest -> cup, when a hold starts
const LAUNCH_MS = 150;   // cup -> the recording's first frame, on release
const SETTLE_HOLD_MS = 240; // PRD §8.1 beat 1: let the rest land before the reveal
const RETURN_MS = 220;   // cup -> back down, when a hold is cancelled

/** Where the pigs sit while nobody is tossing. */
const IDLE_SPOTS = [
  { pose: 'side-blank', at: [-1.25, 0.55], yaw: -0.7 },
  { pose: 'trotter', at: [1.2, 0.15], yaw: 2.5 },
];

const adapter = {
  ready: false,
  THREE: null,
  phys: null,
  scene: null,
  sim: null,
  cache: null,
  pigs: [],          // { group, shadow, p:[3], q:[4] }
  mode: 'idle',      // 'idle' | 'shake' | 'replay' | 'tween'
  running: false,
  dirty: true,
  skip: false,
  _raf: null,
  _prefillQueued: false,
  _scratch: [makeState(), makeState()],

  async boot(canvas) {
    try {
      const [pigMod, physMod, THREE] = await Promise.all([
        import('./pig.js'), import('./physics.js'), import('three'),
      ]);
      const { buildScene, buildPig, buildPen, buildContactShadow } = pigMod;
      const { PigSim, TrajectoryCache, posePlacement } = physMod;
      if (
        typeof buildScene !== 'function' ||
        typeof buildPig !== 'function' ||
        typeof buildPen !== 'function' ||
        typeof PigSim !== 'function' ||
        typeof TrajectoryCache !== 'function' ||
        typeof posePlacement !== 'function'
      ) {
        throw new Error('pig.js / physics.js loaded but missing expected exports');
      }

      this.THREE = THREE;
      this.phys = physMod;
      this.scene = buildScene(canvas);
      this.scene.scene.add(buildPen());

      // SPEC.md: the two pigs are IDENTICAL and both carry the painted dot —
      // the dot is what tells a Sider from a Pig Out, so a dotless pig would
      // make half the tosses unreadable.
      this.pigs = [0, 1].map(() => {
        const group = buildPig({ dot: true });
        this.scene.scene.add(group);
        const shadow = buildContactShadow ? buildContactShadow(0.5) : null;
        if (shadow) this.scene.scene.add(shadow);
        return { group, shadow, p: [0, 0.3, 0], q: [0, 0, 0, 1] };
      });

      this.sim = new PigSim();
      // chunkSims smaller than the default 24: prefill() only checks its budget
      // BETWEEN searches, so one chunk is the real granularity of a stall. 10
      // sims is ~11ms worst case, which fits inside an idle callback.
      this.cache = new TrajectoryCache(this.sim, { chunkSims: 10 });
      this.cache.onRefill = () => this.queuePrefill();

      this._qa = new THREE.Quaternion();
      this._qb = new THREE.Quaternion();
      this._qc = new THREE.Quaternion();
      this._camBase = new THREE.Vector3();
      this._camShake = new THREE.Vector3();
      // two skew axes so the rattle never looks like a single spin
      this._axA = new THREE.Vector3(0.31, 0.88, 0.36).normalize();
      this._axB = new THREE.Vector3(-0.74, 0.19, 0.64).normalize();

      // ready BEFORE the first placement: restIdle/placePose refuse to touch a
      // pen that is not ready yet, and silently leaving both pigs at the world
      // origin stacks them on top of each other
      this.ready = true;
      this.restIdle();
      this.applyFraming();
      window.addEventListener('resize', () => {
        this.dirty = true;
        this.applyFraming();
      });
      this.start();
      this.queuePrefill();
      return true;
    } catch (err) {
      console.warn('[hog-wild] 3D boot failed — falling back to Quick Toss-only mode.', err);
      this.ready = false;
      return false;
    }
  },

  /**
   * PRD §7.5 asks for portrait framing; SPEC.md's 52° pitch is tuned for a
   * roughly square viewport. On a phone the pen is 5.4 × 7.4 and a 52° camera
   * projects it almost square, which leaves the top ~40% of a tall canvas as
   * empty table and shrinks the pigs to specks. Looking down harder trades
   * that dead space for pen: the deep axis stops foreshortening, so the pen
   * fills the height. Desktop keeps the 52° hero angle.
   */
  applyFraming() {
    if (!this.ready) return;
    const el = this.scene.renderer.domElement;
    const tall = el.clientHeight > el.clientWidth * 1.15;
    const pitch = tall ? 64 : 52;
    // Framing the whole pen wastes the far third of it: measured over 144
    // recordings (all six poses, both lanes) nothing ever travels past
    // z = -1.8, |x| = 2.45 or y = 1.9, so the far end is permanently empty
    // felt. Framing the reachable volume instead makes the pigs ~25% bigger
    // for free. The box still contains the cup (z 2.3, y 1.45) and the whole
    // measured flight envelope with room to spare.
    const box = this.playBox();
    if (pitch !== this._pitch || box !== this._focusBox) {
      this._pitch = pitch;
      this._focusBox = box;
      this.scene.frame(box, { pitchDeg: pitch });
    }
    // the camera moved, so any shake baseline is stale
    this._camShaking = false;
    this.dirty = true;
  },

  playBox() {
    if (!this._playBox) {
      const V = this.THREE.Vector3;
      this._playBox = new this.THREE.Box3(new V(-2.66, -0.05, -2.35), new V(2.66, 1.55, 3.45));
    }
    return this._playBox;
  },

  /* ---------------------------------------------------------------- render */

  start() {
    if (!this.ready || this.running) return;
    this.running = true;
    this.dirty = true;
    const loop = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      try {
        this.step(now);
      } catch (err) {
        // one bad frame must not kill the loop, or the pen freezes forever
        console.warn('[hog-wild] render step failed (non-fatal)', err);
      }
    };
    this._raf = requestAnimationFrame(loop);
  },

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  },

  step(now) {
    let moved = false;
    if (this.mode === 'shake') moved = this.stepShake(now);
    else if (this.mode === 'replay') moved = this.stepReplay(now);
    else if (this.mode === 'tween') moved = this.stepTween(now);
    // Idle is genuinely static — two rubber pigs lying on felt. Re-rendering it
    // 60 times a second would just burn a phone battery (PRD §10), so idle only
    // paints when something actually changed.
    if (!moved && !this.dirty) return;
    this.dirty = false;
    this.applyAll();
    this.scene.render();
  },

  applyAll() {
    for (const pig of this.pigs) this.apply(pig);
  },

  apply(pig) {
    pig.group.position.set(pig.p[0], pig.p[1], pig.p[2]);
    pig.group.quaternion.set(pig.q[0], pig.q[1], pig.q[2], pig.q[3]);
    if (!pig.shadow) return;
    // the blob fades and spreads as the pig climbs away from the felt
    const h = Math.max(0, pig.p[1] - 0.18);
    const k = Math.max(0, 1 - h / 1.3);
    pig.shadow.position.set(pig.p[0], 0.005, pig.p[2]);
    const s = 1 + h * 0.7;
    pig.shadow.scale.set(s, s, 1);
    pig.shadow.material.opacity = 0.16 + 0.62 * k * k;
  },

  /* ------------------------------------------------------------ idle state */

  /** Rest both pigs on the felt (fresh game / resume / fallback). */
  restIdle() {
    if (!this.ready) return;
    IDLE_SPOTS.forEach((spot, i) => this.placePose(i, spot.pose, spot.at, spot.yaw));
    this.mode = 'idle';
    this.dirty = true;
  },

  /** Put pig i in `pose`, resting on the felt at [x, z]. Real placement math
   *  from physics.js, so the pig sits ON the floor rather than through it. */
  placePose(i, pose, at, yaw = 0) {
    const pig = this.pigs[i];
    if (!pig) return;
    const pl = this.phys.posePlacement(pose, { yaw, at });
    pig.p[0] = pl.position[0]; pig.p[1] = pl.position[1]; pig.p[2] = pl.position[2];
    pig.q[0] = pl.quaternion.x; pig.q[1] = pl.quaternion.y;
    pig.q[2] = pl.quaternion.z; pig.q[3] = pl.quaternion.w;
    this.dirty = true;
  },

  snapshot() {
    return this.pigs.map((pig) => ({ p: pig.p.slice(), q: pig.q.slice() }));
  },

  /* ---------------------------------------------------------------- shake */

  startShake() {
    if (!this.ready) return;
    this.mode = 'shake';
    this.shakeT0 = performance.now();
    this.shakeFrom = this.snapshot();
    this.ramp = 0;
  },

  stepShake(now) {
    const e = now - this.shakeT0;
    const g = ease(Math.min(1, e / GATHER_MS));
    // PRD §7.2: intensity ramps over the first ~1s so the hold charges up
    const ramp = Math.min(1, e / 1000);
    this.ramp = ramp;
    const amp = (0.014 + 0.055 * ramp) * g;
    const spin = 0.0016 + 0.0075 * ramp;
    for (let i = 0; i < this.pigs.length; i++) {
      const pig = this.pigs[i];
      const from = this.shakeFrom[i];
      const cup = CUP[i];
      const ph = i * 2.3;
      pig.p[0] = from.p[0] + (cup[0] - from.p[0]) * g + Math.sin(now * 0.041 + ph) * amp;
      pig.p[1] = from.p[1] + (cup[1] - from.p[1]) * g + Math.sin(now * 0.053 + ph * 1.7) * amp * 0.7;
      pig.p[2] = from.p[2] + (cup[2] - from.p[2]) * g + Math.cos(now * 0.037 + ph * 0.6) * amp;
      // rattle: two out-of-phase axis rotations, blended in as the pig is
      // scooped up so it never snaps out of its resting attitude
      this._qa.setFromAxisAngle(this._axA, now * spin + ph);
      this._qb.setFromAxisAngle(this._axB, -now * spin * 1.37 + ph);
      this._qa.multiply(this._qb);
      this._qb.set(from.q[0], from.q[1], from.q[2], from.q[3]);
      this._qc.slerpQuaternions(this._qb, this._qa, g);
      pig.q[0] = this._qc.x; pig.q[1] = this._qc.y; pig.q[2] = this._qc.z; pig.q[3] = this._qc.w;
    }
    this.cameraShake(0.018 * ramp, now);
    // spend the hold on the search the release is about to need (PRD §10)
    if (this.cache.needsRefill) this.cache.prefill(3);
    return true;
  },

  /** Release the hold without tossing (too short a press) — put them back. */
  cancelShake() {
    if (!this.ready || this.mode !== 'shake') return;
    this.startTween(this.snapshot(), this.shakeFrom, RETURN_MS);
    this.cameraShake(0);
  },

  cameraShake(mag, now = 0) {
    const cam = this.scene.camera;
    if (mag <= 0) {
      if (this._camShaking) {
        cam.position.copy(this._camBase);
        this._camShaking = false;
        this.dirty = true;
      }
      return;
    }
    if (!this._camShaking) {
      this._camBase.copy(cam.position);
      this._camShaking = true;
    }
    this._camShake.set(
      Math.sin(now * 0.071) * mag,
      Math.sin(now * 0.093 + 1.1) * mag * 0.8,
      Math.cos(now * 0.061) * mag * 0.5,
    );
    cam.position.copy(this._camBase).add(this._camShake);
  },

  /* ---------------------------------------------------------------- tween */

  startTween(from, to, ms, then = 'idle') {
    this.tween = { from, to, ms, t0: performance.now(), then };
    this.mode = 'tween';
  },

  stepTween(now) {
    const tw = this.tween;
    const f = ease(Math.min(1, (now - tw.t0) / tw.ms));
    for (let i = 0; i < this.pigs.length; i++) {
      const out = this._scratch[i];
      tweenInto(out, tw.from[i], tw.to[i], f);
      const pig = this.pigs[i];
      pig.p[0] = out.p[0]; pig.p[1] = out.p[1]; pig.p[2] = out.p[2];
      pig.q[0] = out.q[0]; pig.q[1] = out.q[1]; pig.q[2] = out.q[2]; pig.q[3] = out.q[3];
    }
    if (f >= 1) this.mode = tw.then;
    return true;
  },

  /* ----------------------------------------------------------- the toss */

  /**
   * Play the toss for an ALREADY-DRAWN outcome (Approach B, SPEC.md: this call
   * must never influence the result, only how it looks). Resolves once the pigs
   * have come to rest on screen.
   *
   * @param {{oinker:true}|{a:string,b:string}} outcome
   * @returns {Promise<{poses:[string,string], fallback:boolean}|null>}
   *   `poses` are the poses the RECORDINGS actually settle in — game.js checks
   *   them against the drawn outcome so a search fallback can be logged.
   */
  async toss(outcome) {
    if (!this.ready) return null;
    let recs = null;
    try {
      recs = this.takeRecordings(outcome);
    } catch (err) {
      console.warn('[hog-wild] trajectory search failed (non-fatal)', err);
    }
    if (!recs) {
      // PRD §6.3: never stall. Show the drawn result without a tumble.
      console.warn('[hog-wild] no trajectory available — placing the pigs directly');
      this.showInstant(outcome);
      return null;
    }
    try {
      return await this.play(recs);
    } catch (err) {
      console.warn('[hog-wild] replay failed (non-fatal)', err);
      this.showInstant(outcome);
      return null;
    }
  },

  takeRecordings(outcome) {
    if (outcome.oinker) {
      const pair = this.cache.takeOinker();
      if (!pair || !pair.frames?.length) return null;
      return { pair };
    }
    // pig 0 owns the left half, pig 1 the right — that lane discipline is what
    // lets two independently searched recordings play together without ever
    // occupying the same space (SPEC.md, verified in dev/replay-test.mjs)
    const a = this.cache.take(outcome.a, -1);
    const b = this.cache.take(outcome.b, 1);
    if (!a?.frames?.length || !b?.frames?.length) return null;
    return { a, b };
  },

  play(recs) {
    const pair = !!recs.pair;
    const list = pair ? [recs.pair, recs.pair] : [recs.a, recs.b];
    const which = pair ? [1, 2] : [0, 0];
    const from = this.snapshot();
    const to = list.map((rec, i) => {
      const st = makeState();
      firstState(rec, st, which[i]);
      return st;
    });
    const dur = Math.max(duration(list[0]), duration(list[1])) * 1000;
    this.playState = {
      list, which, from, to, dur,
      t0: performance.now(),
      total: LAUNCH_MS + dur + SETTLE_HOLD_MS,
      poses: pair
        ? [recs.pair.settledPose, recs.pair.settledPoseB]
        : [recs.a.settledPose, recs.b.settledPose],
      fallback: !pair && !!(recs.a.fallbackFrom || recs.b.fallbackFrom),
    };
    this.skip = false;
    this.cameraShake(0);
    this.mode = 'replay';
    return new Promise((resolve) => {
      this._playDone = resolve;
      // requestAnimationFrame does not run in a hidden tab. Someone switching
      // apps mid-toss must not come back to a turn that is stuck in 'tossing'
      // with every button disabled, so the replay also has a wall-clock
      // deadline: when it fires, the pigs snap to their real final frames and
      // the turn resolves exactly as it would have.
      this._playGuard = setTimeout(() => this.finishReplay(), this.playState.total + 900);
    });
  },

  /** PRD §8.3: a tap during the toss jumps to the end of it. Resolved here and
   *  now rather than by setting a flag for the next frame, so it works even
   *  when the frame loop is throttled (background tab, heavy GPU load). The
   *  result is untouched: the pigs land on the same final frames. */
  requestSkip() {
    if (!this.ready || this.mode !== 'replay') return;
    this.skip = true;
    this.finishReplay();
  },

  /** Land the pigs on their recordings' final frames and resolve the toss.
   *  Idempotent: whichever of rAF or the deadline gets here first wins. */
  finishReplay() {
    const ps = this.playState;
    if (!ps) return;
    clearTimeout(this._playGuard);
    for (let i = 0; i < this.pigs.length; i++) {
      const out = this._scratch[i];
      sampleAt(ps.list[i], duration(ps.list[i]) + 1, out, ps.which[i]);
      const pig = this.pigs[i];
      pig.p[0] = out.p[0]; pig.p[1] = out.p[1]; pig.p[2] = out.p[2];
      pig.q[0] = out.q[0]; pig.q[1] = out.q[1]; pig.q[2] = out.q[2]; pig.q[3] = out.q[3];
    }
    this.playState = null;
    this.mode = 'idle';
    this.dirty = true;
    const done = this._playDone;
    this._playDone = null;
    if (done) done({ poses: ps.poses, fallback: ps.fallback });
  },

  stepReplay(now) {
    const ps = this.playState;
    if (!ps) { this.mode = 'idle'; return false; }
    let e = now - ps.t0;
    if (this.skip) e = ps.total;
    for (let i = 0; i < this.pigs.length; i++) {
      const pig = this.pigs[i];
      const out = this._scratch[i];
      if (e < LAUNCH_MS) {
        // out of the cup and into the first simulated frame
        tweenInto(out, ps.from[i], ps.to[i], ease(e / LAUNCH_MS));
      } else {
        sampleAt(ps.list[i], (e - LAUNCH_MS) / 1000, out, ps.which[i]);
      }
      pig.p[0] = out.p[0]; pig.p[1] = out.p[1]; pig.p[2] = out.p[2];
      pig.q[0] = out.q[0]; pig.q[1] = out.q[1]; pig.q[2] = out.q[2]; pig.q[3] = out.q[3];
    }
    if (e >= ps.total) this.finishReplay();
    return true;
  },

  /**
   * No-tumble presentation: Quick Toss, prefers-reduced-motion, and the §6.3
   * fallback. The pigs are placed in the poses the draw already produced, so
   * the pen still agrees with the scoreboard — it just skips the flight.
   */
  showInstant(outcome, displayPoses = null) {
    if (!this.ready) return;
    const poses = outcome.oinker
      ? (displayPoses ?? ['side-blank', 'side-dot'])
      : [outcome.a, outcome.b];
    if (outcome.oinker) {
      // tangled in the middle, which is what an Oinker looks like
      this.placePose(0, poses[0], [-0.27, 0.05], 0.5);
      this.placePose(1, poses[1], [0.27, -0.05], -1.9);
    } else {
      this.placePose(0, poses[0], [-1.2, 0.4], Math.random() * 6.28);
      this.placePose(1, poses[1], [1.2, -0.2], Math.random() * 6.28);
    }
    this.mode = 'idle';
    this.cameraShake(0);
  },

  /* --------------------------------------------------------- idle prefill */

  /** Top the pools up out of idle time (PRD §10) — never on a timer of its
   *  own, and never while a replay owns the frame budget. */
  queuePrefill() {
    if (!this.ready || this._prefillQueued || !this.cache.needsRefill) return;
    this._prefillQueued = true;
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback.bind(window)
      : (cb) => setTimeout(() => cb({ timeRemaining: () => 12 }), 60);
    idle((deadline) => {
      this._prefillQueued = false;
      try {
        if (this.mode === 'idle' || this.mode === 'shake') {
          const left = deadline?.timeRemaining ? deadline.timeRemaining() : 12;
          this.cache.prefill(Math.max(4, Math.min(16, left)));
        }
      } catch (err) {
        console.warn('[hog-wild] prefill failed (non-fatal)', err);
      }
      if (this.cache.needsRefill) this.queuePrefill();
    }, { timeout: 500 });
  },
};


/* =========================================================================
 * Persistence (PRD §9, SPEC.md)
 * ==================================================================== */

const SAVE_KEY = 'hogwild.v1';
const MUTE_KEY = 'hogwild.muted.v1';

function saveGame() {
  try {
    const payload = {
      version: 1,
      players: state.players,
      currentIndex: state.currentIndex,
      turnTotal: state.turnTotal,
      tossedThisTurn: state.tossedThisTurn,
      targetScore: state.targetScore,
      // PRD §9: the outcome is committed the moment it is drawn, so a reload
      // mid-flight resumes into the result instead of undoing it
      pending: state.pending,
      // ...and a turn wiped by a Pig Out / Oinker stays wiped: without this a
      // reload during the 2-second "pass the pigs" beat would hand the player
      // their turn back
      turnEndPending: state.turnEndPending,
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  } catch (err) {
    // Storage can fail (private mode, quota). Never let it break the game.
    console.warn('[hog-wild] saveGame failed (non-fatal)', err);
  }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.players) || data.players.length < 2) return null;
    return data;
  } catch (err) {
    console.warn('[hog-wild] loadGame failed (non-fatal)', err);
    return null;
  }
}

function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (err) {
    console.warn('[hog-wild] clearSave failed (non-fatal)', err);
  }
}

function loadMutePref() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMutePref(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* non-fatal */
  }
}

/* =========================================================================
 * Wake lock (PRD §10)
 * ==================================================================== */

let wakeLock = null;

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => {
        wakeLock = null;
      });
    }
  } catch (err) {
    // Expected to fail sometimes (low battery, power saving). Silent.
    wakeLock = null;
  }
}

function releaseWakeLock() {
  try {
    wakeLock?.release?.();
  } catch {
    /* non-fatal */
  }
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.screen === 'game') {
    acquireWakeLock();
    // the canvas kept no frames while hidden; force one now
    adapter.dirty = true;
  }
});

/* =========================================================================
 * State
 * ==================================================================== */

const state = {
  screen: 'setup', // 'setup' | 'game' | 'win'
  turnState: 'ready', // 'ready' | 'shaking' | 'tossing' | 'settling' | 'resolved'
  players: [], // [{ name, score }]
  currentIndex: 0,
  turnTotal: 0,
  tossedThisTurn: false,
  targetScore: 100,
  // a toss that has been drawn and saved but not yet revealed (PRD §9)
  pending: null,
  // a turn that has ended but whose "pass the pigs" beat is still playing
  turnEndPending: false,
  // display-only poses for an Oinker, so the pen and the labels agree
  oinkerShown: null,
  // guards against a second toss starting while one is in the air
  tossInFlight: false,
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* =========================================================================
 * DOM references
 * ==================================================================== */

const $ = (id) => document.getElementById(id);

const dom = {
  body: document.body,
  screens: {
    setup: $('screen-setup'),
    game: $('screen-game'),
    win: $('screen-win'),
  },
  // setup
  playerRows: $('playerRows'),
  addPlayerBtn: $('addPlayerBtn'),
  targetOptions: $('targetOptions'),
  customTarget: $('customTarget'),
  startGameBtn: $('startGameBtn'),
  setupHint: $('setupHint'),
  // game
  turnName: $('turnName'),
  turnPoints: $('turnPoints'),
  penWrap: $('penWrap'),
  penCanvas: $('penCanvas'),
  penHint: $('penHint'),
  poseLabels: [$('poseLabel0'), $('poseLabel1')],
  resultCard: $('resultCard'),
  resultHeadline: $('resultHeadline'),
  resultDetail: $('resultDetail'),
  hogWildBtn: $('hogWildBtn'),
  holdFill: $('holdFill'),
  stopBtn: $('stopBtn'),
  quickTossBtn: $('quickTossBtn'),
  muteBtn: $('muteBtn'),
  scoreboardToggle: $('scoreboardToggle'),
  scoreboardPanel: $('scoreboardPanel'),
  scoreList: $('scoreList'),
  targetLabel: $('targetLabel'),
  newGameBtn: $('newGameBtn'),
  rulesToggle: $('rulesToggle'),
  rulesPanel: $('rulesPanel'),
  // win
  winName: $('winName'),
  winDetail: $('winDetail'),
  finalScores: $('finalScores'),
  playAgainBtn: $('playAgainBtn'),
  changePlayersBtn: $('changePlayersBtn'),
};

/* =========================================================================
 * Screen management
 * ==================================================================== */

function showScreen(name) {
  state.screen = name;
  for (const [key, el] of Object.entries(dom.screens)) {
    if (!el) continue;
    el.hidden = key !== name;
  }
  dom.body.dataset.screen = name;
  window.scrollTo(0, 0);

  if (name === 'game') {
    acquireWakeLock();
    // the current-player marker is only drawn on the game screen, and the
    // callers that start a game render the scoreboard while the screen is
    // still 'setup'/'win' — so re-render once we are actually here
    if (state.players.length) renderScoreboard();
    // the pen only renders while it is on screen
    adapter.start();
    adapter.dirty = true;
    adapter.scene?.resize();
  } else {
    releaseWakeLock();
    adapter.stop();
  }
}

/* =========================================================================
 * Setup screen
 * ==================================================================== */

function addPlayerRow(name = '') {
  const row = document.createElement('div');
  row.className = 'player-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 14;
  input.autocomplete = 'off';
  input.value = name;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-btn';
  remove.textContent = '✕';
  remove.setAttribute('aria-label', 'Remove player');
  remove.addEventListener('click', () => {
    row.remove();
    refreshPlayerPlaceholders();
  });

  row.appendChild(input);
  row.appendChild(remove);
  dom.playerRows.appendChild(row);
  refreshPlayerPlaceholders();
}

function refreshPlayerPlaceholders() {
  [...dom.playerRows.querySelectorAll('input')].forEach((input, i) => {
    input.placeholder = `Player ${i + 1}`;
  });
}

function readPlayerNames() {
  return [...dom.playerRows.querySelectorAll('input')].map(
    (input, i) => input.value.trim() || `Player ${i + 1}`
  );
}

function populateSetupFromPlayers(players) {
  dom.playerRows.innerHTML = '';
  if (players && players.length) {
    players.forEach((p) => addPlayerRow(p.name));
  } else {
    addPlayerRow();
    addPlayerRow();
  }
}

function setTargetActive(value) {
  state.targetScore = value;
  [...dom.targetOptions.children].forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.target) === value);
  });
}

dom.targetOptions.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-target]');
  if (!btn) return;
  dom.customTarget.value = '';
  setTargetActive(Number(btn.dataset.target));
});

dom.customTarget.addEventListener('input', () => {
  const value = Number(dom.customTarget.value);
  if (value > 0) {
    state.targetScore = Math.round(value);
    [...dom.targetOptions.children].forEach((btn) => btn.classList.remove('active'));
  }
});

dom.addPlayerBtn.addEventListener('click', () => addPlayerRow());

dom.startGameBtn.addEventListener('click', () => {
  const names = readPlayerNames();
  if (names.length < 2) {
    dom.setupHint.textContent = 'Add at least two players — somebody has to pass the pigs to!';
    return;
  }
  state.players = names.map((name) => ({ name, score: 0 }));
  state.currentIndex = 0;
  state.turnTotal = 0;
  state.tossedThisTurn = false;
  state.pending = null;
  state.turnEndPending = false;
  adapter.restIdle();
  beginTurn(true);
  saveGame();
  showScreen('game');
});

/* =========================================================================
 * Game screen — turn banner / scoreboard rendering
 * ==================================================================== */

function currentPlayer() {
  return state.players[state.currentIndex];
}

function renderTurnBanner() {
  dom.turnName.textContent = currentPlayer()?.name ?? '—';
  dom.turnPoints.textContent = state.turnTotal;
}

function bumpTurnPoints() {
  dom.turnPoints.classList.remove('bump');
  void dom.turnPoints.offsetWidth;
  dom.turnPoints.classList.add('bump');
}

function renderScoreboard() {
  dom.scoreList.innerHTML = '';
  dom.targetLabel.textContent = state.targetScore;
  state.players.forEach((player, i) => {
    const li = document.createElement('li');
    if (i === state.currentIndex && state.screen === 'game') li.className = 'current';

    const marker = document.createElement('span');
    marker.className = 'marker';
    marker.textContent = i === state.currentIndex && state.screen === 'game' ? '🐷' : '';

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = player.name;

    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = player.score;

    li.append(marker, who, pts);
    dom.scoreList.appendChild(li);
  });
}

function setResultCard(tone, headline, detail) {
  dom.resultCard.className = 'result-card' + (tone ? ` ${tone}` : '');
  dom.resultHeadline.textContent = headline;
  dom.resultDetail.textContent = detail;
  dom.resultCard.hidden = false;
}

function clearResultCard() {
  dom.resultCard.hidden = true;
}

/* Both Side poses share the label "Sider" in odds.js, which is right for the
 * scoring copy but leaves the pen unreadable: two pigs on their sides captioned
 * "Sider / Sider" while the headline says "Pig Out!" is a mystery. The pen
 * labels therefore name which face is up. This is about the POSE, not the pigs
 * — the pigs are identical and interchangeable (SPEC.md). */
const POSE_LABELS = {
  'side-blank': 'Side · blank',
  'side-dot': 'Side · dot',
};
function poseLabel(pose) {
  return POSE_LABELS[pose] ?? odds.POSES[pose]?.label ?? pose;
}

function setPoseLabels(labelA, labelB) {
  dom.poseLabels[0].textContent = labelA ?? '';
  dom.poseLabels[1].textContent = labelB ?? '';
}

function setActionsEnabled({ toss, stop, quick }) {
  dom.hogWildBtn.disabled = !toss;
  dom.stopBtn.disabled = !stop;
  dom.quickTossBtn.disabled = !quick;
}

function setTurnState(next) {
  state.turnState = next;
  dom.body.dataset.turnstate = next;
}

/* =========================================================================
 * Turn flow
 * ==================================================================== */

function beginTurn(freshGame) {
  setTurnState('ready');
  clearResultCard();
  setPoseLabels('Ready', 'Ready');
  renderTurnBanner();
  renderScoreboard();
  setActionsEnabled({ toss: true, stop: false, quick: true });
  if (freshGame) {
    setResultCard('', `${currentPlayer().name} starts!`, 'Toss the pigs to begin.');
  } else {
    setResultCard('', `${currentPlayer().name}'s turn!`, 'Toss the pigs when you\'re ready.');
  }
}

function nextPlayer() {
  state.currentIndex = (state.currentIndex + 1) % state.players.length;
  state.turnTotal = 0;
  state.tossedThisTurn = false;
  state.turnEndPending = false;
  saveGame();
  beginTurn(false);
}

/* -------------------------------------------------------------------------
 * A toss, in order (PRD §7.1, §8.1; SPEC.md "Approach B invariants"):
 *
 *   1. drawToss()  — the outcome, decided BEFORE anything is searched or
 *      animated. Nothing after this point may change it.
 *   2. persist it as `pending` (PRD §9: a reload mid-flight must not be a way
 *      to duck a Pig Out — the toss is already committed).
 *   3. take real recordings for that outcome and replay them.
 *   4. only once the pigs are at rest: labels, result card, score, reveal.
 *
 * Step 4 coming last is the whole point. The old ordering set the labels and
 * the headline before the animation, which told the player the answer while
 * the pigs were still in the air.
 * ---------------------------------------------------------------------- */

/** Show the pigs coming to rest for an already-drawn outcome.
 *  Returns whatever the adapter reports about the trajectory it actually
 *  played, or null when no tumble was shown. */
async function playToss(outcome, { instant }) {
  if (!adapter.ready) return null;
  if (instant) {
    adapter.showInstant(outcome, outcome.oinker ? state.oinkerShown : null);
    return null;
  }
  const played = await adapter.toss(outcome);
  if (played?.fallback) {
    console.warn('[hog-wild] trajectory search fell back — the drawn outcome still scores.');
  } else if (played && !outcome.oinker) {
    // The label is about to claim a pose; the recording had better agree.
    const want = [outcome.a, outcome.b];
    played.poses.forEach((pose, i) => {
      if (pose !== want[i]) {
        console.warn(`[hog-wild] pig ${i} landed as ${pose} but the draw said ${want[i]}`);
      }
    });
  }
  return played;
}

/** Everything the player sees once the pigs have stopped moving.
 *  `played` is what the adapter actually replayed, or null on the no-tumble
 *  paths (Quick Toss, reduced motion, resume). */
function revealResult(outcome, played = null) {
  state.tossedThisTurn = true;

  if (outcome.oinker) {
    const player = currentPlayer();
    // An Oinker scores the same however the heap ends up, but the labels should
    // still name the poses the pigs are ACTUALLY lying in when a real pair
    // recording played — otherwise the pen and the captions disagree.
    const [shownA, shownB] = played?.poses ?? state.oinkerShown ?? [pickDisplayPose(), pickDisplayPose()];
    state.turnTotal = 0;
    player.score = 0;
    state.pending = null;
    state.turnEndPending = true;
    saveGame();

    setPoseLabels(poseLabel(shownA), poseLabel(shownB));
    renderTurnBanner();
    renderScoreboard();
    setResultCard(
      'awful',
      'Oinker!! 😱',
      `The pigs are touching — ${player.name} goes all the way back to zero.`
    );
    sadness('oinker');
    revealToss({ ...outcome, type: 'oinker', points: 0, headline: 'Oinker!!' });

    setTurnState('resolved');
    setActionsEnabled({ toss: false, stop: false, quick: false });
    scheduleTurnEnd(reducedMotion ? 500 : 2400);
    return;
  }

  const result = odds.scoreToss(outcome.a, outcome.b);
  setPoseLabels(poseLabel(outcome.a), poseLabel(outcome.b));

  if (result.type === 'pigout') {
    state.turnTotal = 0;
    state.pending = null;
    state.turnEndPending = true;
    saveGame();
    renderTurnBanner();
    setResultCard('bad', result.headline, result.detail);
    sadness('pigout');
    revealToss({ ...outcome, ...result });

    setTurnState('resolved');
    setActionsEnabled({ toss: false, stop: false, quick: false });
    scheduleTurnEnd(reducedMotion ? 500 : 2000);
    return;
  }

  state.turnTotal += result.points;
  state.pending = null;
  saveGame();
  renderTurnBanner();
  bumpTurnPoints();
  renderScoreboard();

  const tone = result.type === 'double' ? 'big' : 'good';
  setResultCard(tone, result.headline, `${result.detail} Turn total: ${state.turnTotal}.`);
  if (result.type === 'double') celebrate('double');
  revealToss({ ...outcome, ...result });

  // Back to the player: toss again, or bank what is now on the table.
  setTurnState('ready');
  setActionsEnabled({ toss: true, stop: state.turnTotal > 0, quick: true });
}

let turnEndTimer = null;
function scheduleTurnEnd(delay) {
  clearTimeout(turnEndTimer);
  turnEndTimer = setTimeout(() => {
    turnEndTimer = null;
    nextPlayer();
  }, delay);
}

/**
 * @param {object} opts
 *   quick — the Quick Toss button: no tumble, per PRD §7.4 identical odds
 */
async function performToss({ quick = false } = {}) {
  // reached either straight from 'ready' (Quick Toss) or from 'shaking' (the
  // hold gesture releasing) — both are legal entries, nothing else is
  if (state.turnState !== 'ready' && state.turnState !== 'shaking') return;
  if (state.tossInFlight) return;
  state.tossInFlight = true;
  setTurnState('tossing');
  setActionsEnabled({ toss: false, stop: false, quick: false });
  clearResultCard();
  setPoseLabels('…', '…');

  // Approach B (SPEC.md): draw the outcome FIRST, independent of hold
  // duration/shake — those only affect how the toss looks.
  const outcome = odds.drawToss();
  // Oinker flavor poses are chosen here so the pen and the labels agree even
  // on the instant path.
  state.oinkerShown = outcome.oinker ? [pickDisplayPose(), pickDisplayPose()] : null;
  state.pending = outcome;
  saveGame();

  try {
    // prefers-reduced-motion makes the no-tumble path the default (PRD §7.4)
    const played = await playToss(outcome, { instant: quick || reducedMotion || !adapter.ready });
    setTurnState('settling');
    revealResult(outcome, played);
  } finally {
    state.tossInFlight = false;
  }
}

/** A toss that was drawn and saved but whose reveal never happened (the page
 *  went away mid-flight). Resume by showing the result immediately — the
 *  outcome was committed before the pigs were even in the air. */
function resumePending(outcome) {
  state.oinkerShown = outcome.oinker ? [pickDisplayPose(), pickDisplayPose()] : null;
  adapter.showInstant(outcome, state.oinkerShown);
  setTurnState('settling');
  revealResult(outcome);
}

function bankPoints() {
  if (state.turnState !== 'ready' || state.tossInFlight) return;
  if (!state.tossedThisTurn || state.turnTotal === 0) return;
  clearTimeout(turnEndTimer);

  const player = currentPlayer();
  const banked = state.turnTotal;
  player.score += banked;
  state.turnTotal = 0;
  state.tossedThisTurn = false;
  state.turnEndPending = true;
  saveGame();
  renderTurnBanner();
  renderScoreboard();
  celebrate('bank');

  if (player.score >= state.targetScore) {
    showWin(player);
    return;
  }

  setResultCard('good', `${player.name} banked ${banked}!`, `Now at ${player.score} of ${state.targetScore} points.`);
  setActionsEnabled({ toss: false, stop: false, quick: false });
  // through scheduleTurnEnd, so New Game / a win can cancel the pass
  scheduleTurnEnd(reducedMotion ? 300 : 1200);
}

/* =========================================================================
 * Hold-to-shake input (pointer + keyboard)
 *
 * Mobile: hold anywhere in the pen. Desktop: hold the Go Hog Wild button
 * or hold Space. Min hold 250ms so a stray tap doesn't toss. Release
 * outside the pen still throws — the "up" listener lives on window.
 * ==================================================================== */

const MIN_HOLD_MS = 250;
const RAMP_MS = 1000;

let holdActive = false;
let holdStart = 0;
let rampRaf = null;

function startHold() {
  if (state.turnState !== 'ready' || holdActive) return;
  if (dom.body.classList.contains('mode-quick-only')) return;
  holdActive = true;
  holdStart = performance.now();
  setTurnState('shaking');
  initAudio();
  dom.hogWildBtn.classList.add('holding');
  // the gesture always works (PRD §7.3/§7.4) but prefers-reduced-motion means
  // it must not start a rattle
  if (!reducedMotion) adapter.startShake();

  const tick = () => {
    if (!holdActive) return;
    const elapsed = performance.now() - holdStart;
    const ramp = Math.min(1, elapsed / RAMP_MS);
    dom.holdFill.style.transform = `scaleX(${ramp})`;
    rampRaf = requestAnimationFrame(tick);
  };
  rampRaf = requestAnimationFrame(tick);
}

function endHold() {
  if (!holdActive) return;
  holdActive = false;
  cancelAnimationFrame(rampRaf);
  dom.hogWildBtn.classList.remove('holding');
  dom.holdFill.style.transform = 'scaleX(0)';

  const heldMs = performance.now() - holdStart;
  if (heldMs < MIN_HOLD_MS) {
    // Too short — treat as a cancelled tap, not a toss.
    adapter.cancelShake();
    setTurnState('ready');
    return;
  }
  performToss();
}

function cancelHold() {
  if (!holdActive) return;
  holdActive = false;
  cancelAnimationFrame(rampRaf);
  dom.hogWildBtn.classList.remove('holding');
  dom.holdFill.style.transform = 'scaleX(0)';
  adapter.cancelShake();
  setTurnState('ready');
}

for (const target of [dom.penWrap, dom.hogWildBtn]) {
  target.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startHold();
  });
}
// Release outside the pen still throws — listen on window, not the target.
window.addEventListener('pointerup', () => endHold());
window.addEventListener('pointercancel', cancelHold);

// Tap during a toss skips to the end of it (PRD §8.3). This does not touch the
// result — the outcome was drawn before the throw and the recording still plays
// out to its real final frame, just instantly.
dom.penWrap.addEventListener('pointerdown', () => {
  if (state.turnState === 'tossing') adapter.requestSkip();
});

let spaceHeld = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault(); // must not scroll the page
    if (!spaceHeld) {
      spaceHeld = true;
      startHold();
    }
    return;
  }
  if (e.code === 'Enter') {
    if (!dom.stopBtn.disabled) bankPoints();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    spaceHeld = false;
    endHold();
  }
});

dom.stopBtn.addEventListener('click', () => bankPoints());

dom.quickTossBtn.addEventListener('click', () => {
  if (state.turnState !== 'ready') return;
  cancelHold();
  initAudio();
  performToss({ quick: true });
});

/* =========================================================================
 * Scoreboard / rules slide-up panels + mute
 * ==================================================================== */

function togglePanel(panel, toggleBtn) {
  const opening = panel.hidden;
  panel.hidden = !opening;
  toggleBtn.setAttribute('aria-expanded', String(opening));
}

dom.scoreboardToggle.addEventListener('click', () => togglePanel(dom.scoreboardPanel, dom.scoreboardToggle));
dom.rulesToggle.addEventListener('click', () => togglePanel(dom.rulesPanel, dom.rulesToggle));

dom.newGameBtn.addEventListener('click', () => {
  const midGame = state.turnTotal > 0 || state.players.some((p) => p.score > 0);
  if (midGame && !confirm('Start a new game? The current scores will be lost.')) return;
  goToSetup(false);
});

let muted = loadMutePref();
setMuted(muted);
function renderMuteBtn() {
  dom.muteBtn.textContent = muted ? '🔇' : '🔊';
  dom.muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}
dom.muteBtn.addEventListener('click', () => {
  muted = !muted;
  setMuted(muted);
  saveMutePref(muted);
  renderMuteBtn();
});
renderMuteBtn();

/* =========================================================================
 * Win screen
 * ==================================================================== */

function showWin(winner) {
  clearSave();
  clearTimeout(turnEndTimer);
  state.pending = null;
  state.turnEndPending = false;
  dom.winName.textContent = winner.name;
  dom.winDetail.textContent = `wins with ${winner.score} points!`;

  dom.finalScores.innerHTML = '';
  [...state.players]
    .sort((a, b) => b.score - a.score)
    .forEach((p, i) => {
      const li = document.createElement('li');
      const marker = document.createElement('span');
      marker.className = 'marker';
      marker.textContent = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = p.name;
      const pts = document.createElement('span');
      pts.className = 'pts';
      pts.textContent = p.score;
      li.append(marker, who, pts);
      dom.finalScores.appendChild(li);
    });

  celebrate('win');
  showScreen('win');
}

dom.playAgainBtn.addEventListener('click', () => {
  state.players.forEach((p) => (p.score = 0));
  state.currentIndex = 0;
  state.turnTotal = 0;
  state.tossedThisTurn = false;
  state.pending = null;
  state.turnEndPending = false;
  adapter.restIdle();
  saveGame();
  beginTurn(true);
  showScreen('game');
});

dom.changePlayersBtn.addEventListener('click', () => goToSetup(true));

function goToSetup(keepNames) {
  clearSave();
  clearTimeout(turnEndTimer);
  state.pending = null;
  state.turnEndPending = false;
  state.turnTotal = 0;
  state.tossedThisTurn = false;
  adapter.restIdle();
  populateSetupFromPlayers(keepNames ? state.players : null);
  showScreen('setup');
}

/* =========================================================================
 * Boot
 * ==================================================================== */

/* PRD §7.5: never show mobile-only copy on desktop — say what the input
 * actually is. Kept live so a resized window says the right thing. */
const desktopQuery = window.matchMedia('(min-width: 900px)');
function renderPenHint() {
  if (!dom.penHint) return;
  dom.penHint.textContent = desktopQuery.matches
    ? 'Hold the button (or Space) to shake'
    : 'Hold anywhere to shake';
}
/* On desktop the scoreboard is a column of the game grid, not a slide-up
 * panel, and its 🏆 toggle is hidden by CSS — so if game.js leaves it
 * `hidden` there is no way to ever see the scores. */
function syncScoreboardPanel() {
  if (!dom.scoreboardPanel) return;
  if (desktopQuery.matches) {
    dom.scoreboardPanel.hidden = false;
    dom.scoreboardToggle?.setAttribute('aria-expanded', 'true');
  } else {
    dom.scoreboardPanel.hidden = true;
    dom.scoreboardToggle?.setAttribute('aria-expanded', 'false');
  }
}
desktopQuery.addEventListener?.('change', () => {
  renderPenHint();
  syncScoreboardPanel();
});

async function boot() {
  dom.body.classList.toggle('reduced-motion', reducedMotion);
  renderPenHint();
  syncScoreboardPanel();

  await loadOdds();

  const resumed = loadGame();
  if (resumed) {
    state.players = resumed.players;
    state.currentIndex = resumed.currentIndex ?? 0;
    state.turnTotal = resumed.turnTotal ?? 0;
    state.tossedThisTurn = !!resumed.tossedThisTurn;
    state.targetScore = resumed.targetScore ?? 100;
    state.pending = resumed.pending ?? null;
    state.turnEndPending = !!resumed.turnEndPending;
    setTargetActive(state.targetScore);
    beginTurn(false);
    setActionsEnabled({ toss: true, stop: state.tossedThisTurn && state.turnTotal > 0, quick: true });
    showScreen('game');
  } else {
    populateSetupFromPlayers(null);
    setTargetActive(100);
    showScreen('setup');
  }

  const ok = await adapter.boot(dom.penCanvas);
  dom.body.classList.toggle('mode-3d', ok);
  dom.body.classList.toggle('mode-quick-only', !ok);
  if (ok && state.screen === 'game') adapter.scene.resize();

  // A toss that was drawn but never revealed (the page went away mid-flight)
  // resolves now, without a tumble.
  if (state.screen === 'game' && state.pending) {
    resumePending(state.pending);
  } else if (state.screen === 'game' && state.turnEndPending) {
    // the turn was already over; the reload just skipped the beat
    nextPlayer();
  }
}

boot();

/* A single dev handle. Nothing in the game reads it — it exists so a browser
 * session (or the next agent working on juice) can inspect state, force a
 * pose, or re-frame the camera without adding console plumbing later. */
window.hogwild = {
  state,
  adapter,
  get odds() { return odds; },
  toss: (opts) => performToss(opts),
  bank: () => bankPoints(),
};
