// hog-wild/game.js
//
// State machine, turn logic, players, persistence, wake lock, UI wiring.
// See SPEC.md for the module contracts this file depends on.
//
// State machine (SPEC.md, PRD §7.1):
//   setup -> ready -> shaking -> tossing -> settling -> resolved -> (ready | turnEnd) -> win

import {
  revealToss, celebrate, sadness, initAudio, setMuted,
  impact, pigVoice, haptic, shakePulse, shakeLoop, stopShakeLoop,
  initVisualFx, blinkRed, clearBlink, burstPigs, resetPigVisuals, stepVisualFx,
  cheer, popPigs,
  REVEAL_FX, OINKER_POP_S,
} from './fx.js';
import { sampleAt, duration, firstState, makeState, tweenInto, ease } from './replay.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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
        detail: 'Matching sides.',
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
      detail: '',
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
    // …and no detail on a scoring round: see odds.js's round-3 copy note.
    detail: '',
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

/* The cup hovers just inside the near edge of the board, one lane each, at about
 * the height physics.js releases from (LANE spawn is x 1.05–2.10, y 1.0–1.9,
 * z 1.5–2.7). Keeping the cup inside that window is what makes the release
 * tween a short hop rather than a visible jump. */
const CUP = [
  [-0.30, 1.34, 2.34],
  [0.30, 1.34, 2.34],
];
/* =========================================================================
 * The cup — SPEC "Presentation model" reserves this volume and LAUNCH_MS is
 * described as tweening "out of the cup".
 *
 * ROUND-2 REVIEW: "there is no cup, no hand, and no anticipation. Full scene
 * graph is: board, table, backdrop, zone-fringe/rough/green, zone-rings, 2
 * anonymous meshes, 2 pigs with contact shadows — nothing else … So 'hold to
 * shake' is two pigs vibrating on bare felt, then a ~150 ms snap from the table
 * to 1.2 m with no windup, no arm, no container. The single most important
 * gesture in the game has no diegetic object attached to it."
 *
 * There is a cup now (pig.js `buildCup`), and the gesture is built around it:
 *
 *   idle     the cup sits on the felt at CUP_REST, just outside the green
 *   hold     it lifts to CUP_HOLD, tilts its mouth toward the camera, and
 *            rattles with the two pigs bouncing around INSIDE it
 *   release  it TIPS toward the board over CUP_TIP_MS while the pigs fly out —
 *            the windup and the throw, in one gesture, with a container
 *   cancel   it settles back down and the pigs go back where they were
 *
 * **SHAKE-INTERACTION FIX 1 (owner, 2026-08-11) reversed the pigs' role here.**
 * The first build HID them: "you cannot see dice inside a shaker either", and
 * `CUP_SWALLOW` was the gather fraction past which `pig.group.visible` went
 * false. PRD §7.1 says "pigs rattle visibly inside", the owner tested it on a
 * phone, and the note is blunt: currently they do not. So the pigs are now
 * STAGED IN THE CUP'S OWN FRAME (see `CUP_SHAKE` and `stepShake`) and stay
 * visible for the whole hold, the cup's mouth tilts toward the camera far enough
 * to see into, and buildCup's mouth grew from 1.24 m to 1.60 m because two 1.0 m
 * pigs physically could not rattle inside the old one. `CUP_SWALLOW` is gone.
 * ==================================================================== */
// On the FRINGE, not on the green: at z 3.55 the cup sat inside the rough, on the
// playing surface, and read as a bucket someone had left on the mat. At the very
// edge of the board is where a shaker is actually put down. z came in from 4.35 to
// 4.12 when the mouth grew to r 0.80, so the resting cup's far rim (4.92) still
// sits inside the focus box's z 4.95; its near rim (3.32) is still clear of every
// pig rest (z ≤ 2.68), so they never meet.
const CUP_REST = [0.0, 0.0, 4.12];
const CUP_HOLD = [0.0, 1.05, 2.42];  // hovering, mouth at ≈ y 2.15
const CUP_LIFT_MS = 300;
const CUP_TIP_MS = 260;              // the throw
const CUP_HOME_MS = 480;             // …and back down to the felt
const CUP_TIP_RAD = -1.15;           // ≈66° forward, mouth toward the board
const GATHER_MS = 260;   // rest -> cup, when a hold starts
const LAUNCH_MS = 150;   // cup -> the recording's first frame, on release
const SETTLE_HOLD_MS = 240; // PRD §8.1 beat 1: let the rest land before the reveal
const RETURN_MS = 220;   // cup -> back down, when a hold is cancelled

/* =========================================================================
 * CUP_SHAKE — the rattle, SPEC "Shake interaction" must-fix 1.
 *
 * "During ready/shaking states the pigs are inside the cup, and while shaking
 * they bounce around like crazy in there … The cup's mouth must face the camera
 * enough that the rattling is actually visible."
 *
 * Everything below is expressed in the CUP'S LOCAL FRAME (base at y 0, mouth at
 * y `height`) and transformed through `cup.matrixWorld` every frame. That is the
 * whole trick: staging in world space and hoping the numbers keep agreeing with
 * a cup that lifts, tilts and rattles is how you get pigs floating beside their
 * container. In the cup's frame "inside" is a statement about `baseR`/`mouthR`
 * and stays true through any transform the cup is given.
 *
 * The tilt is the other half. The play camera looks down at 64° in portrait and
 * 52° on desktop, so an UPRIGHT cup's mouth is already 26°/38° off face-on —
 * open, but you are looking across the rim into a shaded tube. `tiltRad` leans
 * the mouth a further 19° toward the lens (positive rotation.x is toward +Z,
 * which is where the camera is; CUP_TIP_RAD is negative because the throw goes
 * the other way, toward the board) which both squares the mouth up AND swings
 * the near wall down out of the sightline.
 *
 * The two pigs are separated in HEIGHT, not sideways. A 1.0 m pig in a 1.36 m
 * interior has ~0.18 m of sideways room once it is horizontal, which is all the
 * rattle needs and nothing like enough to stand two pigs side by side; stacked,
 * they jostle past each other with correct depth ordering and read as two
 * objects in one container.
 * ==================================================================== */
const CUP_SHAKE = {
  tiltRad: 0.34,        // extra lean of the mouth TOWARD the camera (≈19°)
  entryY: 0.30,         // local height above the mouth the scoop lifts them to
  slotY: [0.34, 0.70],  // local height each pig rattles around
  slotX: [-0.04, 0.04],
  slotZ: [0.04, -0.04],
  jitterIdle: 0.020,    // rattle amplitude at intensity 0 …
  jitterFull: 0.070,    // … and flat out
  jitterY: 1.35,        // vertical amplitude multiplier (a bounce, not a slide)
  spinIdle: 0.0022,     // rad per ms of the tumble
  spinFull: 0.0125,
  /** How far into the gather the drop into the slot starts / ends, as multiples
   *  of GATHER_MS. The scoop lifts them to the rim first and THEN drops them in,
   *  because a straight line from the felt to the slot goes through the wall. */
  dropFrom: 0.70,
  dropSpan: 0.95,
  /** Keep a pig's CENTRE this far inside the interior wall. It is the pig's half
   *  length, deliberately: at that pad a fully horizontal pig cannot get an end
   *  through the wall at any yaw, which makes containment geometry rather than a
   *  tuned guess. The lateral offset is SCALED to fit rather than clipped, so
   *  when the rattle does reach the limit it rides the wall instead of sticking
   *  to a flat spot. */
  wallPad: 0.50,
};

/** Chip projection: how far above a pig's COM the chip's tail points. Whether a
 *  chip is SHOWN is a question about the pig's projected size, not about a pixel
 *  constant — see adapter.projectChips, which is where the round-3 "the game
 *  labels empty felt" note is answered. */
const CHIP_LIFT = 0.28;
/** px of canvas kept clear outside a chip's own measured box (see projectChips) */
const CHIP_MARGIN = 6;

/** Where the pigs sit while nobody is tossing. */
const IDLE_SPOTS = [
  { pose: 'side-blank', at: [-1.25, 0.55], yaw: -0.7 },
  { pose: 'trotter', at: [1.2, 0.15], yaw: 2.5 },
];

/* =========================================================================
 * Presentation model — SPEC "Presentation model", ported from the approved
 * demo arena (`_watch/arena.html`). Every timing and threshold the reveal
 * uses lives in these three blocks and nowhere else.
 * ==================================================================== */

/** Beat 3 — the camera reveal choreography. */
const REVEAL = {
  zoomInMs: 1300,       // ease in on the called round
  holdMs: 3000,         // linger, drifting
  zoomOutMs: 900,       // ease back to the overview framing
  holdOrbit: 0.10,      // rad/s of orbit drift during the hold
  /* ---- how CLOSE the reveal gets ------------------------------------------
   * ROUND-1 REVIEW, two notes that meet here: the expressions were invisible
   * ("either the ink needs to be bigger or the reveal camera has to push in much
   * closer — ideally both"), and the result card covered the pigs.
   *
   * The old distance was a hand-tuned linear function of separation
   * (sep × 1.5 + 2.1), which for a typical 2.4 m spread put the camera 5.7 m
   * out — and which ignored the viewport aspect entirely, so it was framed for
   * a landscape canvas and wasted most of a portrait one. It is now SOLVED for
   * instead: the distance is the closest one at which the pig-pig line still
   * fits across the frame with `pigPad` to spare AND `frameHalfH` of vertical
   * room survives the upward composition bias. On a 16:9 canvas a 2.4 m spread
   * now resolves to ~3.6 m instead of 5.7 — the pigs are 60% bigger on screen,
   * which is what makes a brow readable.
   */
  /* ---- ROUND-2 REVIEW: the whole solve above was wrong, twice ---------------
   * "The reveal both crops the pigs and makes them SMALLER than the default shot.
   * Captured one reveal where the right pig was sliced vertically by the canvas
   * edge … measured the reveal camera at 5.56 m from the pig midpoint, giving
   * ~56 CSS px of pig versus ~74 px at the overview. SPEC claims the distance is
   * 'SOLVED, not proportional' and that the composition bias 'can never crop what
   * it is revealing' — neither holds in the shipped build."
   *
   * Both failures came from the same shortcut: the old solve was a closed-form
   * estimate in METRES (half-separation + a pad, divided by a tangent) that never
   * asked the projection whether the result actually fit. It ignored the pigs'
   * own extent, it ignored that the composition lift is a ROTATION and not an
   * ndc translation, and when its estimate exceeded `maxDist` it silently
   * clamped — which is exactly the shipped crop. MEASURED at the time of the
   * rewrite: pigs at x ±2.79 (a 5.58 m spread) asked for 6.71 m, got clamped to
   * 6.4, and the outer pig's far edge sat at ndc x 1.07.
   *
   * It is now a real fit test — `fitsAt()` projects each pig as a bounding sphere
   * through a scratch camera and checks containment in the usable band — wrapped
   * in a binary search for the closest distance that passes, over a family of
   * swings. Nothing is clamped: if even `maxDist` cannot hold both pigs, the shot
   * becomes a single-pig HERO close-up (`heroFrac`), which is the honest answer
   * to "these two are 5.6 m apart" and still delivers the character moment the
   * beat exists for.
   */
  minDist: 1.85,        // any closer and the near plane starts eating the pig
  /* 9.6, not 6.2. LIVE-TESTED at 6.2: a Pig Out — the one result whose whole
   * meaning is "these two pigs are opposite sides" — fell through to the hero shot
   * and showed ONE pig. Losing a pig is a worse failure than a slightly wider
   * shot, so the pair is tried out to a generous ceiling first and the hero shot is
   * a genuine last resort. It costs nothing in the common case (the search returns
   * the MINIMUM fitting distance, which is still ~5 m for a typical spread) and
   * even at the ceiling it is 2.4× closer than the 23 m overview. */
  maxDist: 9.6,
  /* Bounding-sphere radius of a pig, in board-metres — a FALLBACK only:
   * `adapter.boot` replaces it with the real one measured off the built geometry
   * (see `_pigR`). 0.58 was a guess, and it was a guess on the wrong side of the
   * thing round 3 measured. The mesh's own farthest vertex is 0.544 from the
   * origin, so 0.58 does contain the pig — but the review measures the projected
   * 8-corner AABB, whose far corner is 0.723 out, and 0.18 m of empty box corner
   * outside the frame reads in a measurement exactly like a cropped pig. The fit
   * now uses the corner radius, which makes "it can never crop what it is
   * revealing" true under the strictest available metric and costs ~25% of
   * on-screen size. MEASURED at 0.58 on a 2.46 m spread: the near pig reached
   * ndc x −1.02 (its box corner did; no triangle was outside). */
  pigR: 0.58,
  /* The pad around each projected corner, in board-metres. Not a pig radius — the
   * corners ARE the pig's extent now — just a little air so a rounded rump does not
   * sit exactly on the frame edge. */
  pointPad: 0.06,
  /* Mirrors pig.js's `FACE.eyeR` (0.052 board-metres) and SPEC's promise for the
   * reveal ("20–33 px of eye … against 4.1 px at the overview"). Together they turn
   * "the reveal is the character shot" into a filter the solve can apply — see
   * solveRig. If FACE.eyeR is ever retuned, this follows it. */
  eyeR: 0.052,
  minEyePx: 20,
  ndcLimit: 0.90,       // the fit must stay inside this much of the frame
  cardPad: 14,          // px of clearance between the result card and a pig
  distSteps: 11,        // binary-search iterations (≈2 mm of precision)
  /* The reveal must NEVER be further out than this fraction of the overview
   * distance — that is the round-2 note "it currently reveals less than doing
   * nothing", turned into an invariant. A pair shot that cannot satisfy it is
   * abandoned for the hero shot rather than shipped. */
  /* 0.62, not 0.52: on the shipped desktop framing the overview stands 17.4 m out,
   * so 0.52 made the ceiling 9.03 m and `maxDist` (9.6) dead code. The two limits
   * should not shadow each other — `maxDist` is the taste limit and this is the
   * "never wider than the shot you are improving on" invariant. */
  heroFrac: 0.62,
  /* How much a metre of extra distance is allowed to cost against seeing the
   * face. The first build of the exact-fit solve produced a beautifully framed
   * 4.7 m two-pig shot in which both pigs were seen from BEHIND — technically the
   * closest fit, and useless, because the beat exists to show an expression. The
   * search now scores `front` (the camera's alignment with the hero pig's snout,
   * −1…1) minus `dist/maxDist × frontWeight`, so a frontal shot beats a rear one
   * even from further back, while among frontal shots the closest still wins. */
  frontWeight: 0.55,
  heightRatio: 0.34,    // camera height as a fraction of that distance
  /* ---- swing, and why the perpendicular is not always right ---------------
   * SPEC "Presentation model" beat 3 puts the reveal camera on the PERPENDICULAR
   * of the pig-pig line. That is the ideal shot — both pigs equidistant, neither
   * hiding the other — and it is what a landscape canvas gets. But on a phone it
   * is a trap: standing perpendicular means the whole separation has to fit
   * across the frame's SHORT axis, and a 2.2 m spread in portrait needs the
   * camera 9 m out, which is further away than the overview and makes a
   * hard-won brow invisible again.
   *
   * So the camera may SWING off the perpendicular by up to `swingMax`, which
   * trades some of the separation out of the frame's width and into its depth —
   * where the reveal's shallow elevation foreshortens it into the (plentiful)
   * vertical. The swing is chosen as the one that comes CLOSEST while still
   * fitting, so a landscape canvas keeps the SPEC's exact shot and only a narrow
   * one pays for its shape.
   *
   * The cap is 88°, not 52°. At 52° a portrait canvas simply could not hold a
   * typical spread and the old solve clamped (i.e. cropped); near 90° the camera
   * looks straight down the pig-pig line, the separation costs the frame's width
   * NOTHING, and the near pig fills the shot with the far one stacked behind and
   * above it. Because the fit is now measured rather than modelled, the search is
   * free to use the whole range and take whatever is closest.
   */
  swingMax: 88 * Math.PI / 180,
  swingSteps: 13,
  /* ---- the HOLD is part of the shot, so it is part of the fit ---------------
   * ROUND-4, MEASURED: on a Leaning Jowler + Trotter (3.3 m spread, desktop
   * 654×551) the rig solved to 5.16 m and ARRIVED clean — worst |ndc| 0.813 at
   * t = 0 of the hold — and then the beat's own orbit drift walked the hero pig
   * off the right edge: 0.905 at +0.5 s, 0.956 at +1.0 s, 1.005 at +1.5 s. A
   * crop is a crop whether it happens on the arrival frame or a second later,
   * and the fit test only ever asked about the arrival frame.
   *
   * `holdOrbit × holdMs` is a KNOWN quantity, so the honest fix is to solve for
   * the whole sweep: every candidate distance is tested at the bearing it
   * arrives on AND at the bearings the drift will carry it to. The distance the
   * search returns is therefore the closest one that holds for the entire beat.
   * `driftFits` below is where that happens, and stepReveal clamps the live
   * drift to exactly the span that was tested so a starved renderer with a big
   * frame delta cannot walk past it either.
   *
   * It costs size, and not much: the same case re-solved to 5.44 m (5% further,
   * 23.4 px of eye against 25.1) and never passed |ndc| 0.87 for the whole hold.
   */
  driftChecks: 3,       // bearings sampled across the drift span, inclusive
  pathChecks: [0.25, 0.45, 0.65, 0.85],  // where along the zoom-in the fit is verified
  pathRepairs: 9,       // outward steps allowed to make a failing path fit
  pathStep: 1.07,       // …each one this much further out
  midY: 0.16,           // the look-at point sits just above the felt
  /* ---- composition --------------------------------------------------------
   * The result card is pinned to the bottom of the canvas while the camera
   * moves, so whether it landed on top of the pigs used to be pure luck — and
   * the round-1 review caught it covering BOTH pigs on a Double Trotter, at the
   * one moment the reveal exists to serve. The reveal camera pitches down by
   * however much of the frame the card actually occupies (`cardPad` above, and
   * `frameBand()`, which measures the LIVE element so it stays right when the copy
   * wraps to a third line) — and, unlike round 1, the lift is now part of the fit
   * test rather than applied after it, which is what makes SPEC's "it can never
   * crop what it is revealing" true instead of aspirational.
   *
   * The OVERVIEW needs the same treatment, for the same reason. The card is up
   * whenever the pigs are at rest and readable — the whole `ready` and `resolved`
   * stretch — and a pig that lands in the near third of the green projects
   * straight into the band. Unlike the reveal this cannot be measured live (the
   * overview rig is captured on boot and on resize, long before a card exists),
   * so it is a fixed lift sized for a two-line card, paid for out of the empty
   * felt the framing was leaving at the TOP of the canvas. `frameBox`'s margin is
   * tightened by half of it so the lift can never crop the play volume. */
  overviewBias: 0.13,
  /* ---- ROUND-3 REVIEW: the camera never actually arrived --------------------
   * "across ALL 5 sampled reveal frames neither pig was inside NDC ±1 … REVEAL
   * .maxDist is 9.6 yet the camera sits at 12.4–12.5 m … the celebration has
   * already fired (per spec it fires on ARRIVAL), so the camera believes it has
   * arrived while both subjects are outside the frustum."
   *
   * REPRODUCED, and the fit solve was innocent: instrumented live, the rig for a
   * Double Snouter solved to 5.37 m, well inside the 9.03 m ceiling. What failed
   * was the TRANSPORT. The old motion was an exponential glide —
   * `k = 1 − exp(−rate·dt)` per frame — which is a fixed fraction of the REMAINING
   * distance per frame and therefore only converges if enough frames are drawn.
   * The phase clock is frame-driven too (`r.t += dt`), so on a starved renderer
   * both advance together and the phase can END while the camera is still most of
   * the way out: MEASURED in an automated browser that painted twice during the
   * 1.3 s zoom-in, the camera got 47% of the way in — 12.4 m of an 17.4 → 5.4 m
   * move — and then `stepReveal` flipped to `hold` and fired the celebration,
   * exactly as reported. An exponential glide has no arrival, only an asymptote.
   *
   * So the transport is now ABSOLUTE: each phase captures the pose it started
   * from and interpolates to its target on `ease(t / duration)`. At t = duration
   * the factor is exactly 1, so the camera is exactly on the rig on the frame the
   * phase ends — with 2 frames or with 200. It stays interruptible for the same
   * reason it was a glide: `out` captures wherever the camera actually IS when the
   * phase flips, so a skip tap mid-zoom still leaves smoothly from that pose.
   * The `hold` phase tracks the (slowly drifting) rig directly, since the `in`
   * phase guarantees it is already there.
   */
};

/** How far the hold's orbit drift travels, in radians — a KNOWN quantity, which
 *  is what lets the fit solve cover the whole beat (see REVEAL.driftChecks). */
function revealDriftSpan() {
  return REVEAL.holdOrbit * (REVEAL.holdMs / 1000);
}

/**
 * Grounding — the two shadow systems and where they hand over.
 * See `adapter.apply()` for why each number is what it is.
 */
const SHADOW = {
  restY: 0.17,      // COM height of a pig lying on the felt
  liftOff: 0.22,    // above this the hard map shadow is a lie; switch it off
  fadeH: 1.15,      // m over which the contact patch fades out entirely
  restScale: 0.92,  // the patch is TIGHTER than the blob texture's full size
  spread: 0.80,     // …and grows with height
  peak: 0.95,       // opacity in contact
  floor: 0.06,      // …and at the top of the arc
};

/** Beat 1 — the per-pig settle machine, read off the replayed recording. */
const SETTLE = {
  speed: 0.08,                     // m/s — "this pig has stopped"
  spin: 0.18,                      // rad/s
  frames: 12,                      // consecutive frames (~0.1 s at 120 Hz)
  bumpPos: 0.035,                  // m — a settled pig displaced this far…
  bumpAngle: 4 * Math.PI / 180,    // …or turned this far…
  wakeSpeed: 0.2,                  // …or moving again → "resettling…"
  minT: 0.4,                       // never call a settle in the first 0.4 s
};

/** "Character & expressions" — what the face does while the pig is in flight. */
const FACE = {
  squintSpin: 6.0,       // rad/s of tumble that makes a pig screw its eyes shut
  squintY: 0.42,         // …while airborne (above this the pig is off the felt)
  ouchMs: 340,           // how long an "ouch" is held after a hard contact
  // impulse that counts as a hard hit, per region: a face-plant hurts at half
  // the impulse a rump-first landing does
  ouchImpulse: { snout: 2.5, head: 2.8, belly: 4.0, back: 4.5, side: 4.5, rump: 4.5, legs: 8.0 },
  dazedMinS: 0.9,        // this much low-energy wobble before a settle = dazed
  dazedLeadS: 0.3,       // …starting this far into the wobble
  dazedSpin: 3.0,        // what still counts as "wobbling, not tumbling"
  dazedSpeed: 0.8,
  voiceGain: 0.42,       // the happy oink a scoring pig gives on its own settle
};

/* -------------------------------------------------------------------------
 * Recording analysis — the presentation timeline of ONE pig.
 *
 * The pigs the player sees are a replayed Recording, not a live sim, so the
 * per-pig settle machine and the expression track are derived from the frames
 * ONCE, when the recording is taken, using the SPEC thresholds above. That
 * keeps the beats frame-rate independent (they fire against the replay clock,
 * not against however many frames the phone managed to draw) and it means a
 * skip tap can deliver the same calls instantly.
 * ---------------------------------------------------------------------- */

/** Which frame keys one pig uses: 0 → single, 1/2 → pair pig A/B. */
function recKeys(which) {
  if (which === 1) return ['p1', 'q1'];
  if (which === 2) return ['p2', 'q2'];
  return ['p', 'q'];
}

function quatAngleBetween(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(d > 1 ? 1 : d);
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * @param {object} rec        a Recording (or PairRecording)
 * @param {number} which      0 single · 1 pair pig A · 2 pair pig B
 * @param {Function} classify (quaternionObject) → { pose, confidence }
 * @returns {{
 *   calls: Array<{t:number, kind:'settle'|'bump', pose?:string, confidence?:number}>,
 *   track: Array<{t:number, expr:string}>,
 *   events: Array<{t:number, impulse:number, region:string}>,
 *   settleT: number,
 * }}
 */
function analyzeRecording(rec, which, classify) {
  const dt = rec?.dt ?? 1 / 120;
  const frames = rec?.frames ?? [];
  const n = frames.length;
  const empty = { calls: [], track: [], events: [], settleT: 0 };
  if (!n) return empty;

  const [pk, qk] = recKeys(which);
  if (!frames[0][pk]) return empty;

  // finite-difference speed / spin, one per frame
  const speed = new Float32Array(n);
  const spin = new Float32Array(n);
  for (let i = 0; i < n - 1; i++) {
    speed[i] = dist3(frames[i + 1][pk], frames[i][pk]) / dt;
    spin[i] = quatAngleBetween(frames[i][qk], frames[i + 1][qk]) / dt;
  }

  const asQuat = (q) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });
  const settledPose = which === 2
    ? (rec.settledPoseB ?? rec.settledPose)
    : rec.settledPose;

  /* --- beat 1: settle / bump calls ---------------------------------------- */
  const calls = [];
  let settled = false, calm = 0, snapP = null, snapQ = null, settleT = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    if (settled) {
      if (
        dist3(frames[i][pk], snapP) > SETTLE.bumpPos ||
        quatAngleBetween(frames[i][qk], snapQ) > SETTLE.bumpAngle ||
        speed[i] > SETTLE.wakeSpeed
      ) {
        settled = false; calm = 0;
        calls.push({ t, kind: 'bump' });
      }
      continue;
    }
    if (t >= SETTLE.minT && speed[i] < SETTLE.speed && spin[i] < SETTLE.spin) {
      if (++calm >= SETTLE.frames) {
        settled = true;
        calm = 0;
        snapP = frames[i][pk].slice();
        snapQ = frames[i][qk].slice();
        settleT = t;
        const c = classify(asQuat(frames[i][qk]));
        calls.push({ t, kind: 'settle', pose: c.pose, confidence: c.confidence });
      }
    } else {
      calm = 0;
    }
  }
  // Safety net (the arena's "call it where it lies"): the recording ended while
  // the pig was still technically moving, which can happen because the sim's
  // own settle test is not the SPEC's. Call the last frame.
  if (!settled) {
    settleT = (n - 1) * dt;
    const c = classify(asQuat(frames[n - 1][qk]));
    calls.push({ t: settleT, kind: 'settle', pose: c.pose, confidence: c.confidence });
  }
  // The chip must never disagree with the scorecard, so the FINAL settle is
  // named by the recording's own settledPose (which is what scored).
  if (settledPose) {
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i].kind === 'settle') { calls[i].pose = settledPose; break; }
    }
  }

  /* --- expressions ------------------------------------------------------- */
  const settleIdx = Math.min(n - 1, Math.round(settleT / dt));
  const base = new Array(n);
  for (let i = 0; i < n; i++) {
    const y = frames[i][pk][1];
    const fast = spin[i] > FACE.squintSpin;
    base[i] = fast && (y > FACE.squintY || spin[i] > FACE.squintSpin * 1.7) ? 'squint' : 'neutral';
  }
  // dazed: a long low-energy wobble immediately before the settle
  let run = 0;
  for (let i = settleIdx; i >= 0; i--) {
    if (frames[i][pk][1] > FACE.squintY || spin[i] > FACE.dazedSpin || speed[i] > FACE.dazedSpeed) break;
    run++;
  }
  if (run * dt >= FACE.dazedMinS) {
    const from = settleIdx - run + Math.round(FACE.dazedLeadS / dt);
    for (let i = Math.max(0, from); i <= settleIdx; i++) base[i] = 'dazed';
  }
  // ouch wins over everything: a hard contact is the loudest thing happening
  const allEvents = Array.isArray(rec.events) ? rec.events : [];
  const pigTag = which === 2 ? 2 : which === 1 ? 1 : null;
  const events = pigTag
    ? allEvents.filter((e) => e.pig === pigTag)
    : allEvents;
  const ouchFrames = Math.max(1, Math.round((FACE.ouchMs / 1000) / dt));
  for (const e of events) {
    const floor = FACE.ouchImpulse[e.region] ?? 4.5;
    if (e.impulse < floor) continue;
    const i0 = Math.max(0, Math.min(n - 1, Math.round(e.t / dt)));
    for (let i = i0; i < Math.min(n, i0 + ouchFrames); i++) base[i] = 'ouch';
  }

  // compress to keyframes — the replay only needs the changes
  const track = [];
  let prev = null;
  for (let i = 0; i <= settleIdx; i++) {
    if (base[i] !== prev) {
      prev = base[i];
      track.push({ t: i * dt, expr: base[i] });
    }
  }

  return { calls, track, events, settleT };
}

/** The face a settled pig wears, before the round as a whole is called. */
function settleExpression(pose) {
  if (!pose) return 'neutral';
  if (pose === 'jowler') return 'wink';
  return (odds.POSES[pose]?.points ?? 0) > 0 ? 'smug' : 'neutral';
}

const adapter = {
  ready: false,
  THREE: null,
  phys: null,
  scene: null,
  sim: null,
  cache: null,
  pigs: [],          // { group, shadow, p:[3], q:[4] }
  mode: 'idle',      // 'idle' | 'shake' | 'replay' | 'reveal' | 'tween'
  running: false,
  dirty: true,
  skip: false,
  _raf: null,
  _prefillQueued: false,
  _scratch: [makeState(), makeState()],
  /** game.js fills these in: the per-pig settle beats report through them. */
  onPigSettle: null,   // (i, { pose, confidence }) => void
  onPigBump: null,     // (i) => void

  async boot(canvas) {
    try {
      const [pigMod, physMod, THREE] = await Promise.all([
        import('./pig.js'), import('./physics.js'), import('three'),
      ]);
      const { buildScene, buildPig, buildBoard, buildCup, buildContactShadow } = pigMod;
      const { PigSim, TrajectoryCache, posePlacement } = physMod;
      if (
        typeof buildScene !== 'function' ||
        typeof buildPig !== 'function' ||
        typeof buildBoard !== 'function' ||
        typeof PigSim !== 'function' ||
        typeof TrajectoryCache !== 'function' ||
        typeof posePlacement !== 'function'
      ) {
        throw new Error('pig.js / physics.js loaded but missing expected exports');
      }

      this.THREE = THREE;
      this.phys = physMod;
      this.pigMod = pigMod;
      this.scene = buildScene(canvas);
      this.scene.scene.add(buildBoard());
      // fx.js owns the particles and the red blink but must stay importable on
      // pages with no importmap, so it is handed THREE rather than importing it
      initVisualFx({ THREE, scene: this.scene.scene });

      // SPEC.md: the two pigs are IDENTICAL and both carry the painted dot —
      // the dot is what tells a Sider from a Pig Out, so a dotless pig would
      // make half the tosses unreadable. buildPig() takes no options for
      // exactly that reason: there is no such thing as "the blank pig".
      this.pigs = [0, 1].map(() => {
        const group = buildPig();
        this.scene.scene.add(group);
        const shadow = buildContactShadow ? buildContactShadow(0.5) : null;
        if (shadow) this.scene.scene.add(shadow);
        return { group, shadow, p: [0, 0.3, 0], q: [0, 0, 0, 1] };
      });

      // MEASURE the pig, don't assume it. Everything that asks "is the pig inside
      // the frame" — the reveal's fit test and the chips' visibility rule — needs a
      // radius, and a hard-coded one silently stops matching the model the moment
      // the silhouette is retuned (round 3 retuned it). The AABB's far corner is the
      // bound, not the farthest vertex: see REVEAL.pigR.
      this._pigR = this.measurePigR();

      // The shaker. Degrades to nothing if pig.js is an older build without it,
      // because a missing prop must never cost the player the game.
      this.cupState = { lift: 0, tip: 0, tilt: 0 };
      this.cup = typeof buildCup === 'function' ? buildCup() : null;
      if (this.cup) {
        this.cupShadow = buildContactShadow ? buildContactShadow(0.72) : null;
        if (this.cupShadow) this.scene.scene.add(this.cupShadow);
        this.scene.scene.add(this.cup);
        this.placeCup();
      }

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
      // reveal-camera scratch: an aim helper (position + lookAt → quaternion),
      // the captured overview rig, and one Vector3 for projecting chips.
      // It MUST be a Camera, not a bare Object3D: Object3D.lookAt aims +Z at
      // the target, cameras aim -Z, so a plain helper hands back a quaternion
      // that faces exactly away from the pigs.
      // A PerspectiveCamera specifically: aimDown() needs a real `fov` to turn a
      // half-frame bias into a pitch angle, and a bare Camera has none.
      this._camAim = new THREE.PerspectiveCamera();
      this._overviewPos = new THREE.Vector3();
      this._overviewQuat = new THREE.Quaternion();
      this._revealPos = new THREE.Vector3();
      this._revealLook = new THREE.Vector3();
      this._proj = new THREE.Vector3();
      // two skew axes so the rattle never looks like a single spin
      this._axA = new THREE.Vector3(0.31, 0.88, 0.36).normalize();
      this._axB = new THREE.Vector3(-0.74, 0.19, 0.64).normalize();
      // rattle scratch: one point and one quaternion for the cup-local -> world
      // transform stepShake runs twice a frame
      this._qd = new THREE.Quaternion();
      this._cupPt = new THREE.Vector3();

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
   * roughly square viewport. On a phone a 52° camera projects the play volume
   * almost square, which leaves the top ~40% of a tall canvas as empty table
   * and shrinks the pigs to specks. Looking down harder trades that dead space
   * for board: the deep axis stops foreshortening, so the felt fills the
   * height. Desktop keeps the 52° hero angle.
   */
  applyFraming() {
    if (!this.ready) return;
    const el = this.scene.renderer.domElement;
    const tall = el.clientHeight > el.clientWidth * 1.15;
    const pitch = tall ? 64 : 52;
    // Framing the whole board wastes most of it: the board is a 4.6 m disc but
    // the pigs only ever use a slice of it. RE-MEASURED on the zoned board over
    // 144 recordings (all six poses, both lanes): no COM ever travels past
    // |x| = 3.29, y = 1.89, or z outside -2.28…2.68, and rests reach |x| 3.27.
    // (The walled pen was narrower — |x| 2.45 — because the walls bounced the
    // pigs back; with no walls a hard throw slides further out sideways, so the
    // box had to grow in x and could shrink at the far end.) The box below is
    // that envelope plus a little in x and z — where a pig can come to REST, so
    // it must never be cropped — and deliberately a little short of it in y: the
    // very top of the release arc is allowed to clip out of frame for a few
    // frames rather than push the camera back on every toss. It still contains
    // the cup (z 2.3, y 1.32) and the whole green (r 2.7).
    const box = this.playBox();
    this._pitch = pitch;
    this._focusBox = box;
    // Always re-frame, even when nothing changed: pig.js's own resize listener
    // re-frames the camera behind our back, and the reveal needs a TRUSTWORTHY
    // overview rig to glide back to. Framing is a handful of projections, and
    // this only runs on boot and on resize.
    this.scene.frame(box, {
      pitchDeg: pitch,
      // room for the upward composition lift below, so it cannot crop the box
      margin: 0.94 - REVEAL.overviewBias * 0.5,
    });
    this.aimDown(this.scene.camera, REVEAL.overviewBias);
    this._overviewPos.copy(this.scene.camera.position);
    this._overviewQuat.copy(this.scene.camera.quaternion);
    // How far the OVERVIEW stands off the middle of the board. The reveal solve
    // measures itself against this (REVEAL.heroFrac) so the character shot can
    // never end up further out than the shot it is supposed to improve on.
    // the reveal glides home to a LOOK POINT as well as a position; both moved
    this._overviewLook = null;
    this._overviewDist = this.scene.camera.position.distanceTo(
      new this.THREE.Vector3(0, REVEAL.midY, 0),
    );
    // the camera moved, so any shake baseline is stale
    this._camShaking = false;
    this.dirty = true;
  },

  /**
   * ROUND-2 REVIEW: "26.8% of the portrait 3D viewport is dead black … 147 of 546
   * CSS px above the board contain nothing — not felt, not backdrop, nothing."
   *
   * MEASURED while fixing it, and the diagnosis in the note is half right. The
   * top of the portrait frame is not sky and not void: the camera sits 21 m out at
   * 64° and its topmost ray lands on the TABLE about 9 m behind the board. The
   * region was black because the cloth's albedo was being squared by a
   * colour-times-map bug (see PALETTE.table in pig.js), so a luminance-72 surface
   * rendered at 36 — five levels off the page background. Fixing the cloth is what
   * turns those rows into a lit table in a room.
   *
   * The box's job here is different, and it is the reason the camera is 21 m out:
   * a 6.9 m-wide volume in a 351 px-wide viewport can only ever be 21 m away, and
   * NO fov or pitch changes that (angular size is a ratio). So the overview is a
   * table shot by construction and the reveal is the character shot — see REVEAL.
   * What the box CAN do is stop wasting the vertical: `zMax` now reaches past the
   * cup's resting place, which costs nothing in distance (width is the binding
   * constraint) and buys real subject in the near third of the frame.
   */
  /**
   * Re-frame whenever the canvas actually changes size, not just on `resize`.
   *
   * MEASURED bug, found while checking the reveal's distance ceiling: the overview
   * rig captured at boot said 15.76 m while the live camera was at 22.33 m. boot()
   * runs while the SETUP screen is up, so the pen canvas has a different size (or
   * none) at that moment, and no `resize` event ever fires when a hidden element
   * becomes visible — so the captured `_overviewPos` / `_overviewDist` stayed
   * wrong for the whole session, and pig.js's own resize() had meanwhile moved the
   * real camera. That matters twice over now: the reveal glides HOME to
   * `_overviewPos`, and it measures its own distance ceiling against
   * `_overviewDist`.
   */
  watchSize() {
    const el = this.scene.renderer.domElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    if (w === this._sizeW && h === this._sizeH) return;
    this._sizeW = w; this._sizeH = h;
    this.scene.resize(w, h);
    this.applyFraming();
  },

  /**
   * The radius that contains a pig however it is rotated, measured off the built
   * mesh: the farthest corner of its local AABB from the group origin. (The
   * origin is the collider COM, which is what recording quaternions rotate about,
   * so this is a real rotation-invariant bound.)
   * @returns {number} board-metres
   */
  measurePigR() {
    let r = 0;
    const g = this.pigs?.[0]?.group;
    if (!g) return REVEAL.pigR;
    g.traverse((o) => {
      const bb = o.isMesh && o.geometry && (o.geometry.boundingBox
        || (o.geometry.computeBoundingBox(), o.geometry.boundingBox));
      if (!bb) return;
      for (const x of [bb.min.x, bb.max.x]) {
        for (const y of [bb.min.y, bb.max.y]) {
          for (const z of [bb.min.z, bb.max.z]) r = Math.max(r, Math.hypot(x, y, z));
        }
      }
    });
    return r > 0.1 ? r : REVEAL.pigR;
  },

  pigR() { return this._pigR || REVEAL.pigR; },

  playBox() {
    if (!this._playBox) {
      const V = this.THREE.Vector3;
      this._playBox = new this.THREE.Box3(new V(-3.42, -0.05, -2.50), new V(3.42, 1.70, 4.95));
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
    const dt = this._lastNow ? Math.min((now - this._lastNow) / 1000, 0.1) : 1 / 60;
    this._lastNow = now;
    this.watchSize();
    // the camera punch is an offset, not a state: undo it before anything else
    // touches the camera this frame, and re-apply it after
    this.unpunch();
    let moved = false;
    if (this.mode === 'shake') moved = this.stepShake(now);
    else if (this.mode === 'replay') moved = this.stepReplay(now);
    else if (this.mode === 'reveal') moved = this.stepReveal();
    else if (this.mode === 'tween') moved = this.stepTween(now);
    // The cup runs on its own clock, not on `mode` — the throw and the walk back
    // down to the felt both outlive the frame the mode changed on.
    if (this.stepCup(now, dt)) moved = true;
    if (this.stepPunch()) moved = true;
    // the blink / squash-pop / particle burst age on real time and keep the
    // canvas painting for as long as they run
    if (stepVisualFx(dt)) moved = true;
    // Idle is genuinely static — two rubber pigs lying on felt. Re-rendering it
    // 60 times a second would just burn a phone battery (PRD §10), so idle only
    // paints when something actually changed.
    if (!moved && !this.dirty) return;
    this.dirty = false;
    this.applyAll();
    this.projectChips();
    this.scene.render();
  },

  applyAll() {
    for (const pig of this.pigs) this.apply(pig);
  },

  /**
   * Plant the pig on the felt and drive its two shadows.
   *
   * ROUND-1 REVIEW: "the pigs are never planted, and the two shadow systems are
   * inverted." Both halves of that were true and both are fixed here.
   *
   * AT REST the contact patch now runs to full strength and tucks in tight (see
   * buildContactShadow's front-loaded gradient), so a resting pig reads as
   * touching rather than hovering in haze.
   *
   * IN FLIGHT the emphasis swaps. The 2048 shadow map was staying razor-sharp
   * and fully opaque at y = 1.4, offset far down-left, reading as a detached
   * third dark pig complete with splayed leg claws — while the soft blob that
   * should have taken over had already faded to its floor. So the mesh's
   * castShadow is now switched OFF once the pig is properly airborne (a shadow
   * map cannot be faded per-object, and at that height it is a lie anyway), and
   * the blob simultaneously grows and softens to carry the height cue. The
   * crossover sits at SHADOW_LIFT, where the pig is moving fast enough that
   * nobody can see the swap — and where the map shadow has only just started to
   * detach.
   */
  apply(pig) {
    pig.group.position.set(pig.p[0], pig.p[1], pig.p[2]);
    pig.group.quaternion.set(pig.q[0], pig.q[1], pig.q[2], pig.q[3]);
    const h = Math.max(0, pig.p[1] - SHADOW.restY);
    const mesh = pig.group.children[0];
    if (mesh) {
      const wantCast = h < SHADOW.liftOff;
      if (mesh.castShadow !== wantCast) mesh.castShadow = wantCast;
    }
    if (!pig.shadow) return;
    // a pig that burst into particles casts nothing — and neither does one that
    // is inside the cup (stepShake sets `hideShadow`): the cup has its own patch,
    // and a second one under it reads as a pig lying on the felt
    pig.shadow.visible = pig.group.visible && !pig.hideShadow;
    const k = clamp(1 - h / SHADOW.fadeH, 0, 1);
    pig.shadow.position.set(pig.p[0], 0.005, pig.p[2]);
    const s = SHADOW.restScale + h * SHADOW.spread;
    pig.shadow.scale.set(s, s, 1);
    // Math.pow(k, 0.7) rather than k²: the old square meant the patch had all
    // but vanished by the time the pig was a hand's width off the felt, which is
    // exactly the height range a settling pig spends most of its time in.
    pig.shadow.material.opacity = SHADOW.floor +
      (SHADOW.peak - SHADOW.floor) * Math.pow(k, 0.7);
  },

  /* ------------------------------------------------------------ idle state */

  /** Rest both pigs on the felt (fresh game / resume / fallback). */
  restIdle() {
    if (!this.ready) return;
    IDLE_SPOTS.forEach((spot, i) => this.placePose(i, spot.pose, spot.at, spot.yaw));
    this.resetPresentation();
    this.mode = 'idle';
    this.dirty = true;
  },

  /** Wipe every trace of the last round's reveal: chips, faces, blink, and the
   *  pigs themselves if an Oinker blew them up. */
  resetPresentation() {
    // through finishReveal, not `this.reveal = null`: a reveal that is still
    // running owns an unresolved promise and a guard timer, and dropping it on
    // the floor would leave the turn that is awaiting it hung forever
    if (this.reveal) this.finishReveal();
    this.hideChips();
    resetPigVisuals(this.pigs.map((p) => p.group));
    for (const pig of this.pigs) {
      // an Oinker's burst hides them; nothing else may leave them hidden, and
      // nothing may leave their contact patch switched off either
      pig.group.visible = true;
      pig.hideShadow = false;
      if (pig.shadow) pig.shadow.visible = true;
    }
    this.cupHome();
    this.faces('neutral');
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

  /* ------------------------------------------------- chips & expressions */

  /** Swap one pig's face (SPEC "Character & expressions"). Cheap — a UV
   *  rewrite, and pig.js ignores a state the pig is already wearing. */
  face(i, expr) {
    const pig = this.pigs[i];
    if (!pig || !this.pigMod?.setExpression) return;
    if (this.pigMod.setExpression(pig.group, expr)) this.dirty = true;
  },

  faces(expr) {
    for (let i = 0; i < this.pigs.length; i++) this.face(i, expr);
  },

  /** Show pig i's settle chip. `html` is trusted game copy, never player text. */
  showChip(i, html, { resettling = false } = {}) {
    const el = dom.chips[i];
    if (!el) return;
    el.innerHTML = html;
    el.classList.toggle('resettling', resettling);
    el.classList.add('show');
    this.dirty = true;
    // Place it NOW rather than waiting for the next painted frame: `.show` makes
    // it visible immediately, and a chip that has never been projected sits at
    // left:0/top:0 — the top-left corner of the pen — for that one frame.
    this.projectChips();
  },

  hideChips() {
    for (const el of dom.chips) {
      if (!el) continue;
      el.classList.remove('show', 'resettling');
    }
  },

  /**
   * Keep every visible chip glued to its pig — re-projected every painted frame,
   * so it tracks both the pigs and the reveal camera.
   *
   * ROUND-1 REVIEW: "the projected chips clamp and stack into the canvas corner
   * when the pigs leave frame (two chips piled on the header row)." Clamping was
   * the bug — but only when it was the PIG that had left, not the chip. So the
   * two questions are asked separately now:
   *
   *  - visibility is decided by the PIG's own projected position. Off-frame or
   *    behind the camera and the chip goes away entirely (`.offscreen`), because
   *    a label pinned to the edge of the canvas names nothing and two of them
   *    land on top of each other. It comes back when its pig does.
   *  - placement is the pig's position plus CHIP_LIFT, clamped into the canvas.
   *    A visible pig near the top of a close reveal has no room above it for its
   *    chip; the chip slides down onto the pig rather than vanishing, which keeps
   *    the label with the thing it is naming.
   */
  /**
   * ROUND-3 REVIEW, three separate faults, all of them "a chip is allowed to sit
   * somewhere it says nothing":
   *
   *  - "the Trotter chip rendered … fully inside the canvas — while its pig's
   *    entire 8-corner bounding box was at ndc x >= 1.060. So the 'hide rather
   *    than clamp when the PIG leaves frame' rule never fires; the game labels
   *    empty felt." The old test allowed the pig's COM to be `CHIP_EDGE` (24 px)
   *    OUTSIDE the canvas before hiding — and a COM 24 px out means the whole pig
   *    is out. Visibility is now measured against the pig's projected SIZE: at
   *    least half of its bounding disc has to be on canvas.
   *  - "the 'Snouter 10 pts' chip is clamped directly ON TOP OF the result card,
   *    overlapping the headline … two text layers over the felt, which beat 6
   *    explicitly forbids." The clamp knew about the canvas and not about the
   *    card. It does now: a chip is pushed clear above the card, and a pig that is
   *    itself behind the card loses its chip entirely — a leader pointing into an
   *    opaque panel is the same lie as a leader pointing off-canvas.
   *  - "both chips render stacked 25 px apart at ~40% opacity ('Side · dot 0 pts'
   *    twice), illegible". Two chips are now de-collided against each other, and
   *    an Oinker shows none at all (see hideChips in burstPigsNow / the Oinker
   *    path in game.js — pose chips are meaningless when the round is not a pose).
   */
  projectChips() {
    if (!this.ready) return;
    const el0 = dom.chips[0];
    if (!el0 || !el0.classList) return;
    const canvas = this.scene.renderer.domElement;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    const cam = this.scene.camera;
    const tanHalf = Math.tan((cam.fov * 0.5 * Math.PI) / 180);
    // The card's top edge in canvas pixels — the floor every chip has to stay
    // above. Measured live, like frameBand's, so a wrapped detail line moves it.
    let cardTop = h;
    const card = dom.resultCard;
    if (card && !card.hidden && card.offsetParent) {
      const cr = card.getBoundingClientRect();
      const kr = canvas.getBoundingClientRect();
      if (cr.height) cardTop = Math.max(0, cr.top - kr.top);
    }
    const placed = [];
    for (let i = 0; i < this.pigs.length; i++) {
      const el = dom.chips[i];
      if (!el || !el.classList.contains('show')) continue;
      const pig = this.pigs[i];
      // 1. is the PIG on screen — as a body, not as a point?
      this._proj.set(pig.p[0], pig.p[1], pig.p[2]);
      const depth = cam.position.distanceTo(this._proj);
      this._proj.project(cam);
      const behind = this._proj.z > 1;
      const pigX = (this._proj.x * 0.5 + 0.5) * w;
      const pigY = (-this._proj.y * 0.5 + 0.5) * h;
      // half the pig's projected height, in canvas px, capped so a hero close-up
      // (where one pig legitimately fills the frame) cannot hide its own chip
      const rpx = Math.min(
        (this.pigR() / Math.max(0.2, depth * tanHalf)) * (h / 2),
        Math.min(w, h) * 0.22,
      );
      const off = behind ||
        pigX < rpx * 0.5 || pigX > w - rpx * 0.5 ||
        pigY < rpx * 0.5 || pigY > h - rpx * 0.5 ||
        // …or the pig is behind the result card, where a leader points at a panel
        pigY > cardTop - CHIP_MARGIN;
      el.classList.toggle('offscreen', off);
      if (off) continue;
      // 2. where does its chip go?
      //
      // ROUND-2 REVIEW: "projected chips are not clamped to the canvas. Measured a
      // chip spanning page x 703-821 against a canvas right edge of 810 — an 11 px
      // slice through live text." The old clamp used a CONSTANT (CHIP_EDGE × 2 =
      // 48 px) as a stand-in for the chip's half width. "Trotter 5 pts" happens to
      // be 95 px wide, so it just fit; "Razorback 5 pts" does not, and neither
      // does any chip once the font scales. The chip's OWN measured box is the
      // only correct bound, so that is what is used — and when the clamp actually
      // has to move the chip, the leader flips to point back at its pig instead of
      // lying about where the pig is.
      this._proj.set(pig.p[0], pig.p[1] + CHIP_LIFT, pig.p[2]).project(cam);
      const x = (this._proj.x * 0.5 + 0.5) * w;
      const y = (-this._proj.y * 0.5 + 0.5) * h;
      const cw = el.offsetWidth || 96;
      const ch = el.offsetHeight || 24;
      // .pig-chip is translate(-50%,-100%): `left` is its centre, `top` its bottom
      const halfW = cw / 2 + CHIP_MARGIN;
      const lx = clamp(x, Math.min(halfW, w / 2), Math.max(w - halfW, w / 2));
      const lowest = Math.min(h - CHIP_MARGIN, cardTop - CHIP_MARGIN);
      let ly = clamp(y, ch + CHIP_MARGIN, Math.max(ch + CHIP_MARGIN, lowest));
      // 3. and it must not land on the OTHER chip either
      for (const q of placed) {
        if (Math.abs(lx - q.lx) > (cw + q.cw) / 2 + 2) continue;
        if (ly > q.ly - q.ch - 4 && ly - ch - 4 < q.ly) {
          ly = Math.max(ch + CHIP_MARGIN, q.ly - q.ch - 6);
        }
      }
      placed.push({ lx, ly, cw, ch });
      el.style.left = `${lx}px`;
      el.style.top = `${ly}px`;
      // How far the leader has to slide to keep pointing at the pig. Expressed as
      // a percentage of the chip's own width so the CSS notch can position itself.
      const lead = clamp(50 + ((x - lx) / cw) * 100, 12, 88);
      el.style.setProperty('--lead', `${lead}%`);
      // …and if the chip had to drop onto/below its pig, put the notch on top
      el.classList.toggle('below', ly < y);
    }
  },

  /* ------------------------------------------------------------------ cup */

  /**
   * Put the cup wherever `cupState` says it is.
   *
   * `lift` 0 = on the felt at CUP_REST, 1 = hovering at CUP_HOLD. `tip` 0 =
   * upright, 1 = tipped CUP_TIP_RAD toward the board. `tilt` 0..1 leans the mouth
   * CUP_SHAKE.tiltRad toward the camera, which is what makes the pigs rattling
   * inside it visible at all (SPEC "Shake interaction" 1). `rattle` is the shake
   * jitter, in metres, and it is deliberately the SAME amplitude the pigs get so
   * the container and its contents read as one object.
   *
   * The pigs are staged in this cup's frame, so this has to run BEFORE they are
   * placed each frame — and it leaves `cup.matrixWorld` up to date for them.
   */
  placeCup(rattle = 0, now = 0) {
    const cup = this.cup;
    if (!cup) return;
    const s = this.cupState;
    const f = ease(clamp(s.lift, 0, 1));
    const x = CUP_REST[0] + (CUP_HOLD[0] - CUP_REST[0]) * f;
    const y = CUP_REST[1] + (CUP_HOLD[1] - CUP_REST[1]) * f;
    const z = CUP_REST[2] + (CUP_HOLD[2] - CUP_REST[2]) * f;
    cup.position.set(
      x + (rattle ? Math.sin(now * 0.047) * rattle : 0),
      y + (rattle ? Math.sin(now * 0.061 + 0.8) * rattle * 0.7 : 0),
      z + (rattle ? Math.cos(now * 0.039) * rattle : 0),
    );
    // a little lean back as it lifts, so the lift has a direction; then the
    // shake tilt opens the mouth to the camera; then the throw takes it the
    // other way. All three are the same axis, so they simply add.
    cup.rotation.set(
      0.20 * f
      + CUP_SHAKE.tiltRad * clamp(s.tilt, 0, 1)
      + CUP_TIP_RAD * ease(clamp(s.tip, 0, 1)),
      0,
      0,
    );
    // …and roll a touch on the rattle, so it never looks like a rigid slide
    if (rattle) cup.rotation.z = Math.sin(now * 0.053) * rattle * 1.6;
    else cup.rotation.z = 0;
    // the pigs' staging reads this matrix in the same frame, so it cannot wait
    // for the renderer's own traversal
    cup.updateMatrixWorld(true);
    // Same rule as the pigs (SHADOW.liftOff): a hard 2048-map shadow from an
    // object a metre off the felt is a lie and reads as a second object lying on
    // the cloth. MEASURED in a shake screenshot: the lifted cup threw a crisp dark
    // ellipse well up-left of itself. Off it goes, and the contact patch below
    // carries the height instead.
    const airborne = cup.position.y > SHADOW.liftOff;
    cup.traverse((o) => { if (o.isMesh) o.castShadow = !airborne; });
    if (this.cupShadow) {
      this.cupShadow.position.set(cup.position.x, 0.004, cup.position.z);
      const h = Math.max(0, cup.position.y);
      const k = clamp(1 - h / 1.5, 0, 1);
      this.cupShadow.material.opacity = 0.16 + 0.62 * k;
      const sc = 0.9 + (1 - k) * 0.7;
      this.cupShadow.scale.set(sc, sc, sc);
    }
  },

  /**
   * The cup's own timeline, outside `mode`.
   *
   * `stepShake` drives the lift and the rattle directly while a hold is running,
   * because those have to stay locked to the pigs. Everything AFTER the hold is
   * here: the tip (the throw), then the return to the felt. The return is an
   * exponential glide so an interrupted toss still lands the cup gracefully.
   *
   * @returns {boolean} true while the cup is still moving
   */
  stepCup(now, dt) {
    const ph = this.cupPhase;
    if (!this.cup || !ph) return false;
    if (ph.throwing) {
      const f = (now - ph.t0) / CUP_TIP_MS;
      this.cupState.tip = Math.min(1, f);
      // the shake tilt unwinds over the same window: the cup rolls straight
      // through upright on its way from "mouth at me" to "mouth at the board",
      // which is exactly the arc a hand makes
      this.cupState.tilt = (ph.tilt0 ?? 0) * Math.max(0, 1 - f);
      this.placeCup();
      if (f >= 1) {
        ph.throwing = false;
        ph.t0 = now;
        ph.lift0 = this.cupState.lift;   // where the return starts FROM
        ph.tilt0 = this.cupState.tilt;
      }
      return true;
    }
    // …and back down. Tip unwinds first (it is the fast part of a real throw),
    // then the cup settles onto the felt.
    const f = clamp((now - ph.t0) / CUP_HOME_MS, 0, 1);
    const e = ease(f);
    this.cupState.tip = (ph.tip0 ?? 1) * (1 - e);
    this.cupState.tilt = (ph.tilt0 ?? 0) * (1 - e);
    this.cupState.lift = (ph.lift0 ?? 1) * (1 - e);
    this.placeCup();
    if (f >= 1) {
      this.cupState.tip = 0;
      this.cupState.tilt = 0;
      this.cupState.lift = 0;
      this.placeCup();
      this.cupPhase = null;
    }
    return true;
  },

  /** Put the cup back on the felt, now, with no animation. */
  cupHome() {
    this.cupPhase = null;
    if (!this.cup) return;
    this.cupState.lift = 0;
    this.cupState.tip = 0;
    this.cupState.tilt = 0;
    this.placeCup();
  },

  /* ---------------------------------------------------------------- shake */

  startShake() {
    if (!this.ready) return;
    // an Oinker left the pigs as dust — the new toss brings them back
    this.resetPresentation();
    this.mode = 'shake';
    this.shakeT0 = performance.now();
    this.shakeFrom = this.snapshot();
    this.ramp = 0;
    // null = "nobody is driving me", and stepShake falls back to its own
    // elapsed-time ramp. The input layer normally sets this every frame — see
    // setShakeIntensity — which is what lets device motion and a touch hold feed
    // ONE pipeline (SPEC "Shake interaction" 3).
    this.shakeDrive = null;
  },

  /**
   * The single entry point for "how hard are the pigs being shaken right now",
   * 0..1. Touch-hold feeds it a 1 s ramp; device motion feeds it a normalised
   * EMA of acceleration. Everything downstream — the pigs' jitter, the cup's
   * rattle and tilt, the camera shake — reads only this number, so the two
   * input sources cannot drift into two different-looking shakes.
   *
   * @param {number|null} v
   */
  setShakeIntensity(v) {
    this.shakeDrive = v == null ? null : clamp(Number(v) || 0, 0, 1);
    if (this.mode === 'shake') this.dirty = true;
  },

  /**
   * The interior radius of the cup at a given local height — a cone, not a
   * cylinder, so a pig riding low has less room than one near the rim.
   */
  cupInnerR(localY) {
    const ud = this.cup?.userData;
    if (!ud) return 0.5;
    const baseR = ud.baseR ?? 0.46;
    const mouthR = ud.mouthR ?? 0.62;
    const H = ud.height ?? 1.02;
    return baseR + (mouthR - baseR) * clamp(localY / H, 0, 1);
  },

  /**
   * The rattle (SPEC "Shake interaction" 1): the pigs are IN the cup and going
   * berserk in there.
   *
   * The gather is two moves, not one, because a straight line from a pig lying on
   * the felt to a point 0.4 m up inside a cup passes through the cup's wall. So
   * the scoop lifts each pig to a point just ABOVE the mouth (`entryY`) and then
   * drops it in — which is also what a hand does.
   *
   * Once they are in, everything is computed in the cup's LOCAL frame and pushed
   * through `cup.matrixWorld`, so the pigs inherit the cup's lift, its tilt, its
   * roll and its own rattle for free and cannot come unstuck from it. The
   * containment is geometric: the lateral offset is scaled to fit inside
   * `cupInnerR(y) - CUP_SHAKE.wallPad`, and wallPad is the pig's half length.
   */
  stepShake(now) {
    const e = now - this.shakeT0;
    // PRD §7.2: intensity ramps over the first ~1s so the hold charges up. The
    // input layer normally owns this; the elapsed-time fallback exists so a
    // caller that forgets still gets a rattle rather than a frozen cup.
    const ramp = this.shakeDrive != null ? this.shakeDrive : Math.min(1, e / 1000);
    this.ramp = ramp;
    const gIn = ease(clamp(e / GATHER_MS, 0, 1));
    const gDrop = ease(clamp(
      (e - GATHER_MS * CUP_SHAKE.dropFrom) / (GATHER_MS * CUP_SHAKE.dropSpan), 0, 1,
    ));
    const amp = (0.014 + 0.055 * ramp) * gIn;

    // The cup goes FIRST: the pigs live in its frame this frame.
    this.cupState.lift = Math.min(1, e / CUP_LIFT_MS);
    this.cupState.tip = 0;
    this.cupState.tilt = Math.min(1, e / CUP_LIFT_MS);
    this.placeCup(amp * 0.8, now);

    const cup = this.cup;
    const H = cup?.userData?.height ?? 1.02;
    const jit = CUP_SHAKE.jitterIdle + (CUP_SHAKE.jitterFull - CUP_SHAKE.jitterIdle) * ramp;
    const spin = CUP_SHAKE.spinIdle + (CUP_SHAKE.spinFull - CUP_SHAKE.spinIdle) * ramp;

    for (let i = 0; i < this.pigs.length; i++) {
      const pig = this.pigs[i];
      const from = this.shakeFrom[i];
      const ph = i * 2.3;

      // --- where the pig wants to be, in the cup's own frame -----------------
      const slotY = CUP_SHAKE.slotY[i] ?? 0.4;
      // a bounce: |sin| kicks off the bottom of the well rather than gliding
      const bounce = Math.abs(Math.sin(now * (0.021 + 0.006 * ramp) + ph * 1.9));
      let ly = slotY + (bounce - 0.5) * jit * CUP_SHAKE.jitterY * 2;
      let lx = (CUP_SHAKE.slotX[i] ?? 0)
        + Math.sin(now * 0.031 + ph) * jit
        + Math.sin(now * 0.073 + ph * 2.7) * jit * 0.45;
      let lz = (CUP_SHAKE.slotZ[i] ?? 0)
        + Math.cos(now * 0.027 + ph * 1.3) * jit
        + Math.cos(now * 0.067 + ph * 0.7) * jit * 0.45;
      // the entry point of the scoop, and the drop into the slot
      const entryY = H + CUP_SHAKE.entryY;
      ly = entryY + (ly - entryY) * gDrop;
      lx *= gDrop;
      lz *= gDrop;
      // …and containment: scale (don't clip) the lateral offset to fit
      const maxR = Math.max(0.02, this.cupInnerR(ly) - CUP_SHAKE.wallPad);
      const r = Math.hypot(lx, lz);
      if (r > maxR) { const k = maxR / r; lx *= k; lz *= k; }

      if (cup) {
        this._cupPt.set(lx, ly, lz).applyMatrix4(cup.matrixWorld);
      } else {
        // no cup in this build: fall back to the old world-space rattle points
        const c = CUP[i];
        this._cupPt.set(c[0] + lx, c[1] + ly - slotY, c[2] + lz);
      }

      // --- blend out of the resting pose over the scoop ----------------------
      pig.p[0] = from.p[0] + (this._cupPt.x - from.p[0]) * gIn;
      pig.p[1] = from.p[1] + (this._cupPt.y - from.p[1]) * gIn;
      pig.p[2] = from.p[2] + (this._cupPt.z - from.p[2]) * gIn;

      // rattle: two out-of-phase axis rotations, blended in as the pig is
      // scooped up so it never snaps out of its resting attitude, then carried
      // into the cup's own frame so a tilted cup tumbles its contents with it
      this._qa.setFromAxisAngle(this._axA, now * spin + ph);
      this._qb.setFromAxisAngle(this._axB, -now * spin * 1.37 + ph);
      this._qa.multiply(this._qb);
      if (cup) {
        cup.getWorldQuaternion(this._qd);
        this._qa.premultiply(this._qd);
      }
      this._qb.set(from.q[0], from.q[1], from.q[2], from.q[3]);
      this._qc.slerpQuaternions(this._qb, this._qa, gIn);
      pig.q[0] = this._qc.x; pig.q[1] = this._qc.y; pig.q[2] = this._qc.z; pig.q[3] = this._qc.w;

      // They stay DRAWN for the whole hold — that is must-fix 1. The contact
      // patch does not: a shadow on the felt under a pig that is a metre up
      // inside a cup is the same lie the cup's own map shadow was.
      pig.group.visible = true;
      pig.hideShadow = gIn > 0.35;
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
    // the pigs come back out of the cup, and the cup comes back down — with NO
    // tip, because nothing was thrown (hence tip0: whatever it actually is,
    // which during a shake is 0; the old code hard-coded 1 and snapped the cup
    // into a full pour on every cancelled tap)
    for (const pig of this.pigs) {
      pig.group.visible = true;
      pig.hideShadow = false;
      if (pig.shadow) pig.shadow.visible = true;
    }
    if (this.cup) {
      this.cupPhase = {
        throwing: false,
        t0: performance.now(),
        lift0: this.cupState.lift,
        tip0: this.cupState.tip,
        tilt0: this.cupState.tilt,
      };
    }
    this.shakeDrive = null;
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
    // Beat 1 + the expression track: derived once, here, from the very frames
    // that are about to play. `classify` comes from the sim, so a chip can never
    // name a pose the collider wouldn't.
    const classify = (q) => {
      try {
        return this.sim.classify(q);
      } catch {
        return { pose: null, confidence: 0 };
      }
    };
    const analysis = list.map((rec, i) => analyzeRecording(rec, which[i], classify));
    this.playState = {
      list, which, from, to, dur,
      t0: performance.now(),
      total: LAUNCH_MS + dur + SETTLE_HOLD_MS,
      poses: pair
        ? [recs.pair.settledPose, recs.pair.settledPoseB]
        : [recs.a.settledPose, recs.b.settledPose],
      fallback: !pair && !!(recs.a.fallbackFrom || recs.b.fallbackFrom),
      analysis,
      // per-pig cursors into calls / expression track / contact events
      callIdx: [0, 0],
      trackIdx: [0, 0],
      evIdx: [0, 0],
      settledCalled: [false, false],
    };
    this.hideChips();
    this.faces('neutral');
    this.skip = false;
    this.cameraShake(0);
    // THE THROW. The cup is already up and rattling; tipping it toward the board
    // over the same window the pigs use to leave it is the windup the round-2
    // review found missing, and it is what makes LAUNCH_MS read as a release
    // rather than as a teleport. `cupPhase` then walks it back down to the felt.
    //
    // `from` above is a snapshot of wherever the pigs actually are, which since
    // must-fix 1 is INSIDE the cup — so LAUNCH_MS's blend into the recording's
    // first frame is the pour, with no extra machinery (SPEC allows ≤150 ms and
    // LAUNCH_MS is exactly 150).
    for (const pig of this.pigs) {
      pig.group.visible = true;
      pig.hideShadow = false;
      if (pig.shadow) pig.shadow.visible = true;
    }
    this.shakeDrive = null;
    this.cupPhase = { throwing: true, t0: performance.now(), tilt0: this.cupState.tilt };
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
    // Whatever got us here — the last frame, a skip tap, or the hidden-tab
    // deadline — both pigs must end up called. A silent delivery: the chips and
    // faces land, the settle audio does not (nobody wants a flurry of oinks
    // after a skip).
    this.deliverSettles(true);
    this.playState = null;
    this.mode = 'idle';
    // The cup's throw+return is driven by the RENDER loop, so a starved renderer
    // can leave it hanging in mid-air — MEASURED with the pane hidden: the toss
    // resolved and the shaker was still up and still tilted at `tilt` 1.0. If its
    // own wall-clock window has already elapsed, the frames it needed are never
    // coming; put it on the felt. A skip tap that lands INSIDE that window keeps
    // its animation, because there the frames are real.
    if (this.cupPhase && performance.now() - this.cupPhase.t0 > CUP_TIP_MS + CUP_HOME_MS) {
      this.cupHome();
    }
    this.dirty = true;
    const done = this._playDone;
    this._playDone = null;
    if (done) done({ poses: ps.poses, fallback: ps.fallback });
  },

  /** Fire any settle call that the replay clock never reached. */
  deliverSettles(silent = false) {
    const ps = this.playState;
    if (!ps) return;
    for (let i = 0; i < this.pigs.length; i++) {
      if (ps.settledCalled[i]) continue;
      const calls = ps.analysis[i].calls;
      for (let k = calls.length - 1; k >= 0; k--) {
        if (calls[k].kind !== 'settle') continue;
        this.emitSettle(i, calls[k], silent);
        break;
      }
      ps.callIdx[i] = calls.length;
    }
  },

  emitSettle(i, call, silent = false) {
    const ps = this.playState;
    if (ps) ps.settledCalled[i] = true;
    this.face(i, settleExpression(call.pose));
    if (!silent) {
      haptic('tick');
      // a pig that just scored is pleased about it (SPEC sound direction)
      if ((odds.POSES[call.pose]?.points ?? 0) > 0) {
        pigVoice('happy-oink', { gain: FACE.voiceGain, delay: 0.06 });
      }
    }
    if (this.onPigSettle) this.onPigSettle(i, call);
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
    // everything below is driven by the RECORDING clock, so a dropped frame
    // delays a beat but can never lose one
    if (!this.skip && e >= LAUNCH_MS) this.driveBeats((e - LAUNCH_MS) / 1000);
    if (e >= ps.total) this.finishReplay();
    return true;
  },

  /**
   * The presentation beats of the tumble, at replay time `t` seconds into the
   * recordings: contact audio + expression swaps + per-pig settle / bump calls.
   */
  driveBeats(t) {
    const ps = this.playState;
    for (let i = 0; i < this.pigs.length; i++) {
      const an = ps.analysis[i];

      // contact events → impact audio, scaled by impulse and coloured by region
      while (ps.evIdx[i] < an.events.length && an.events[ps.evIdx[i]].t <= t) {
        const ev = an.events[ps.evIdx[i]++];
        // don't replay the whole history after a long stall — only fresh hits
        if (t - ev.t < 0.25) impact(ev.impulse, ev.region);
      }

      // expression track (squint / ouch / dazed)
      let expr = null;
      while (ps.trackIdx[i] < an.track.length && an.track[ps.trackIdx[i]].t <= t) {
        expr = an.track[ps.trackIdx[i]++].expr;
      }
      if (expr && !ps.settledCalled[i]) this.face(i, expr);

      // settle / bump calls
      while (ps.callIdx[i] < an.calls.length && an.calls[ps.callIdx[i]].t <= t) {
        const call = an.calls[ps.callIdx[i]++];
        if (call.kind === 'settle') {
          this.emitSettle(i, call);
        } else {
          ps.settledCalled[i] = false;
          this.face(i, 'dazed');
          if (this.onPigBump) this.onPigBump(i);
        }
      }
    }
  },

  /* ------------------------------------------------------------ the reveal
   * SPEC "Presentation model" beat 3. On the round call the camera eases onto
   * the perpendicular of the pig-pig line, looking at their midpoint from a
   * distance that scales with how far apart they landed; it holds there with a
   * slow orbit drift, then eases back to the overview framing.
   *
   * The motion is an exponential GLIDE rather than a tween, which is what makes
   * it interruptible: a skip tap, a resize, or the Oinker burst can happen at
   * any instant and the camera still moves smoothly from wherever it is.
   * ---------------------------------------------------------------------- */

  /**
   * @param {{pigOut?:boolean, oinker?:boolean}} opts
   * @returns {Promise<void>} resolves when the camera is home again
   */
  startReveal(opts = {}) {
    if (!this.ready) return Promise.resolve();
    const { pigOut = false, oinker = false, hero = 0, celebrate = null, arrive = null } = opts;
    this.cameraShake(0);
    this.closeRig = this.computeCloseRig(hero, { needBoth: pigOut || oinker });
    this.reveal = {
      phase: 'in', t: 0, phaseAt: performance.now(), frameAt: 0,
      pigOut, oinker, burst: false, celebrate, arrive,
    };
    // the zoom-in interpolates ABSOLUTELY from here (see REVEAL's round-3 note)
    this.markRevealFrom();
    /* The cup is a TOSS prop, and the reveal camera has no idea it exists.
     * LIVE-TESTED: a close reveal put the camera behind the cup, which filled the
     * top third of the frame, cropped, and hid a pig. Teaching the fit test about
     * it would be the wrong fix — it would push every reveal further out to avoid
     * an object nobody is looking at. It just goes away for the duration; the cut
     * happens on the frame the camera starts moving, so it is invisible. */
    if (this.cup) this.cup.visible = false;
    if (this.cupShadow) this.cupShadow.visible = false;

    /* ROUND-3 REVIEW: "on the Oinker both chips render stacked 25 px apart at ~40%
     * opacity ('Side · dot 0 pts' twice), illegible — and pose chips are
     * meaningless on an Oinker anyway." Right on both counts: an Oinker is not a
     * pose result, its two labels are cosmetic, and the pigs are a touching heap
     * so the two chips are always on top of each other. The round call takes them
     * away, which also means beat 6 holds through the whole beat: one text layer
     * (the result card) over the felt. */
    if (oinker) this.hideChips();

    // beat 4: the failure blink starts with the camera move
    const groups = this.pigs.map((p) => p.group);
    if (pigOut) {
      blinkRed(groups, REVEAL_FX.pigOutBlinkMs);
    } else if (oinker) {
      blinkRed(groups, REVEAL.zoomInMs + REVEAL_FX.oinkerExplodeDelay * 1000);
    }

    this.mode = 'reveal';
    this.dirty = true;
    const total = REVEAL.zoomInMs + REVEAL.holdMs + REVEAL.zoomOutMs;
    return new Promise((resolve) => {
      this._revealDone = resolve;
      // rAF is dead in a hidden tab; the turn must still come back to life.
      // Through skipReveal, so a backgrounded Oinker still ends with the pigs
      // gone rather than sitting there in a heap.
      this._revealGuard = setTimeout(() => this.skipReveal(), total + 1200);
    });
  },

  /** PRD §8.3: a tap during the reveal jumps straight to the end state. */
  skipReveal() {
    const r = this.reveal;
    if (!r) return false;
    // an Oinker that hasn't popped yet still pops — the pigs bursting IS the
    // end state, and losing it would leave the score wipe unexplained
    if (r.oinker && !r.burst) {
      r.burst = true;
      this.burstPigsNow();
    }
    // …nor the result text, which a skip is explicitly asking to see NOW
    if (r.arrive) { const fn = r.arrive; r.arrive = null; fn(); }
    // a skip must not swallow the reward either — the celebration is the end
    // state of a scoring round exactly as the burst is the end state of an Oinker
    if (r.celebrate) {
      const c = r.celebrate;
      r.celebrate = null;
      this.celebrateScore(c.poses, c.points);
    }
    clearBlink();
    this.finishReveal();
    return true;
  },

  /**
   * How far up the frame the pigs have to sit so the result card cannot cover
   * them, as a fraction of the frame's HALF-height (which is what an NDC y is).
   *
   * The card is a lower-third band pinned to the canvas; anything the camera
   * aims at dead-centre projects to ndc y = 0, which is well inside the band on
   * a short canvas. Measuring the element rather than hard-coding a number is
   * what keeps this honest when the detail line wraps.
   */
  /**
   * Pitch a camera DOWN so its subject rides UP the frame by `bias` half-frames.
   *
   * A rotation about the camera's own X after it has been aimed, rather than a
   * shifted look-at point: that way the lift is exactly `bias` half-frames
   * however the camera is yawed and however far away it ended up. Shared by the
   * reveal rig and the overview rig so they compose identically.
   */
  aimDown(cam, bias) {
    if (!(bias > 0)) return;
    const tanHalf = Math.tan((cam.fov * 0.5 * Math.PI) / 180);
    cam.rotateX(-Math.atan(bias * tanHalf));
    cam.updateMatrixWorld();
  },

  /**
   * The band of the frame a pig is allowed to occupy, in NDC.
   *
   * The floor is measured off the LIVE result card, so it stays right when the
   * detail line wraps to a third line. Everything above it, out to `ndcLimit`, is
   * fair game. This replaces the old `cardBias` half-frame fudge: the fit test
   * wants a band, not a nudge, because a nudge cannot be checked.
   */
  frameBand() {
    const canvas = this.scene.renderer.domElement;
    const h = canvas.clientHeight || canvas.height || 1;
    const card = dom.resultCard;
    let floor = -REVEAL.ndcLimit;
    if (card && !card.hidden) {
      const need = card.getBoundingClientRect().height + REVEAL.cardPad;
      floor = Math.max(floor, -1 + (2 * need) / h);
    }
    // never let the card starve the band: a three-line card on a short canvas
    // would otherwise leave no room at all and every distance would "fail"
    return { lim: REVEAL.ndcLimit, floor: Math.min(floor, 0.10) };
  },

  /**
   * Aim `aim` from `pos` at `look`, then pitch it so the given world points sit
   * centred in the usable band — and report whether they actually FIT.
   *
   * Each point is treated as a sphere of `rad`, whose ndc radius is its world
   * radius over (view depth × the frame's half-extent). That is the whole reason
   * this is measured instead of modelled: the two pigs are at DIFFERENT depths
   * once the camera swings, so one closed-form "half separation" can never
   * describe both of them.
   *
   * ROUND-3: `pts` are now the pigs' eight ROTATED AABB CORNERS rather than their
   * two centres, and `rad` is a small pad rather than a whole pig. The corners are
   * exactly what a reviewer projects when asking "was it cropped", and they are
   * TIGHTER than a sphere that has to contain them: a single sphere around the COM
   * needs r = 0.723 (the far corner), which wastes 33% of the frame against a mesh
   * whose farthest vertex is 0.544 out and much less than that in most directions.
   * Fitting the corners is both the strict test and the close one.
   *
   * @param {?number} fixedBias  use this pitch instead of solving for one — the
   *   drift sweep has to be judged with the pitch the live camera will hold
   * @returns {{fits:boolean, bias:number}}
   */
  fitPose(aim, pos, look, pts, band, rad = REVEAL.pointPad, fixedBias = null) {
    const tanHalf = Math.tan((aim.fov * 0.5 * Math.PI) / 180);
    const aspect = Math.max(0.35, aim.aspect || 1);
    const v = this._proj;
    let bias = fixedBias == null ? 0 : fixedBias;
    let lo = 0, hi = 0, wide = 0;
    // Two passes: the first measures where the subject lands and derives the
    // pitch that centres it, the second verifies through the ROTATED camera —
    // aimDown is a rotation, so its effect on ndc y is not exactly a translation,
    // and assuming it was is what let the round-1 bias crop the pigs.
    const passes = fixedBias == null ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      aim.position.copy(pos);
      aim.up.set(0, 1, 0);
      aim.lookAt(look);
      aim.updateMatrixWorld();
      if (bias) this.aimDown(aim, bias);
      aim.updateProjectionMatrix();
      lo = Infinity; hi = -Infinity; wide = 0;
      for (const p of pts) {
        const depth = aim.position.distanceTo(p);
        v.copy(p).project(aim);
        if (v.z > 1) return { fits: false, bias };
        const rY = rad / Math.max(0.2, depth * tanHalf);
        const rX = rY / aspect;
        lo = Math.min(lo, v.y - rY);
        hi = Math.max(hi, v.y + rY);
        wide = Math.max(wide, Math.abs(v.x) + rX);
      }
      if (pass === 0 && fixedBias == null) {
        // centre [lo,hi] in [floor,lim]; a positive bias lifts the subject
        const want = (band.floor + band.lim) / 2 - (lo + hi) / 2;
        bias = clamp(want, 0, 0.85);
        if (!bias) break;
      }
    }
    return { fits: wide <= band.lim && lo >= band.floor && hi <= band.lim, bias };
  },

  /**
   * The closest camera that frames `pts` without cropping them, or null.
   * Binary search on distance (fit is monotone in distance) for each swing, then
   * keep the swing that got closest.
   */
  /**
   * The closest camera that frames `pts` without cropping them AND stands in
   * front of the hero pig's face, or null.
   *
   * The distance solve alone is not enough, and the first build of it proved why:
   * it produced a 4.7 m two-pig shot in which both pigs were seen from BEHIND.
   * A reveal whose entire purpose is an expression cannot pick its viewpoint
   * without asking where the snout is pointing. So the search covers all four
   * sign families of the axis (either perpendicular, swinging either way along
   * the pig-pig line), binary-searches the closest fitting distance in each, and
   * then scores the survivors on `front` — how much of the hero pig's snout
   * direction the camera is standing in — against a mild penalty for distance.
   *
   * @param {THREE.Vector3} snout unit +Z of the hero pig, in world space
   */
  solveRig(pts, mid, axis, band, maxDist, snout, heroAt) {
    const V = this.THREE.Vector3;
    const aim = this._camAim;
    aim.fov = this.scene.camera.fov;
    aim.aspect = this.scene.camera.aspect;
    aim.near = this.scene.camera.near;
    aim.far = this.scene.camera.far;
    const pos = new V();
    const toCam = new V();
    let sx = 1, sd = 1;
    // `sx` picks which perpendicular the camera stands on, `sd` which way it
    // swings along the pig-pig line. perp and line are orthonormal, so the sum is
    // already a unit vector for any phi. `spin` is the hold's orbit drift, applied
    // exactly the way closeRigPose applies it, so the search and the live camera
    // travel the same circle.
    const place = (phi, d, spin = 0) => {
      const c = Math.cos(phi) * sx, s = Math.sin(phi) * sd;
      let ux = axis.px * c + axis.lx * s;
      let uz = axis.pz * c + axis.lz * s;
      if (spin) {
        const co = Math.cos(spin), si = Math.sin(spin);
        const rx = ux * co - uz * si;
        uz = ux * si + uz * co;
        ux = rx;
      }
      pos.set(mid.x + ux * d, mid.y + d * REVEAL.heightRatio, mid.z + uz * d);
      return { nx: ux, nz: uz };
    };
    /* Does this distance hold for the WHOLE hold, not just its first frame?
     * See REVEAL.driftChecks. The drift is monotone in one direction and the fit
     * is not monotone in bearing, so the span is sampled rather than end-tested. */
    const span = revealDriftSpan();
    const driftFits = (phi, d) => {
      place(phi, d, 0);
      const first = this.fitPose(aim, pos, mid, pts, band);
      if (!first.fits) return false;
      // …and the rest of the sweep is checked with the ARRIVAL's bias, because
      // that is the pitch the live camera keeps for the whole hold (closeRigPose
      // hands back `rig.bias`). Re-optimising the lift per bearing would validate
      // a shot the game never renders.
      for (let k = 1; k < REVEAL.driftChecks; k++) {
        place(phi, d, (span * k) / (REVEAL.driftChecks - 1));
        if (!this.fitPose(aim, pos, mid, pts, band, REVEAL.pointPad, first.bias).fits) {
          return false;
        }
      }
      return true;
    };
    // Every fitting candidate first, then score them against each OTHER. The old
    // penalty was `hi / maxDist`, i.e. measured against the ceiling — so when the
    // pigs landed far apart and every candidate was near the ceiling, the penalty
    // was ~0.55 for all of them and `front` decided alone. Scoring against the
    // CLOSEST achievable distance is what makes "twice as far away" cost something.
    const cands = [];
    for (const side of [1, -1]) {
      for (const dir of [1, -1]) {
        sx = side; sd = dir;
        for (let s = 0; s < REVEAL.swingSteps; s++) {
          const phi = (REVEAL.swingMax * s) / (REVEAL.swingSteps - 1);
          let lo = REVEAL.minDist, hi = maxDist;
          if (!driftFits(phi, hi)) continue;
          for (let k = 0; k < REVEAL.distSteps; k++) {
            const m = (lo + hi) / 2;
            if (driftFits(phi, m)) hi = m; else lo = m;
          }
          const n = place(phi, hi);
          const { bias } = this.fitPose(aim, pos, mid, pts, band);
          // how frontal is this shot? 1 = nose straight at the camera
          toCam.subVectors(pos, heroAt).normalize();
          const front = snout ? clamp(toCam.dot(snout), -1, 1) : 0;
          cands.push({
            dist: hi, px: n.nx, pz: n.nz, swing: phi, bias, front,
            heroDepth: pos.distanceTo(heroAt),
          });
        }
      }
    }
    if (!cands.length) return null;
    /* SCALE FIRST, then the face — and in that order, because round 3's second
     * must-fix is that the reveal "never becomes the character shot the SPEC assigns
     * it". Scoring `front` against a distance penalty alone cannot deliver that: a
     * perpendicular shot sees the snout best and is ALSO the most expensive shot
     * there is (the whole pig-pig separation has to cross the frame's width), so it
     * won every time and the pigs came out 111 px wide with 13 px of eye.
     *
     * So the pool is filtered first by the SPEC's own promise — 20…33 px of eye —
     * expressed as the depth at which `FACE.eyeR` still projects `minEyePx`. That is
     * canvas-aware arithmetic, not a tuned metre count. Among shots that clear it,
     * the old score picks the most frontal (and the closest among equals). If none
     * clears it — the pigs are simply too far apart — every candidate competes as
     * before, and the closest still wins on the distance term. */
    const px = this.scene.renderer.domElement;
    const hpx = px.clientHeight || px.height || 600;
    const tanHalfV = Math.tan((aim.fov * 0.5 * Math.PI) / 180);
    const faceDepth = (2 * REVEAL.eyeR * (hpx / 2)) / (REVEAL.minEyePx * tanHalfV);
    const close = cands.filter((c) => c.heroDepth <= faceDepth);
    const pool = close.length ? close : cands;
    // `front` spans −1…1; the penalty is proportional to how much FURTHER than the
    // closest shot in the pool this one stands, so among shots of similar size the
    // frontal one wins, and a shot twice as far away has to be frontal against a
    // rear view to justify itself.
    const dMin = Math.min(...pool.map((c) => c.dist));
    let best = null;
    for (const c of pool) {
      c.score = c.front - (c.dist / dMin - 1) * REVEAL.frontWeight * 2.2;
      if (!best || c.score > best.score) best = c;
    }
    return best;
  },

  /**
   * Pig i's eight local-AABB corners in world space — the exact point set a
   * "was it cropped?" measurement projects. Cached per pig and refreshed in
   * place, because computeCloseRig runs on the frame a round is called.
   * @returns {THREE.Vector3[]}
   */
  pigCorners(i) {
    const V = this.THREE.Vector3;
    const pig = this.pigs[i];
    this._corners = this._corners || [[], []];
    const out = this._corners[i];
    let bb = null;
    pig.group.updateMatrixWorld(true);
    pig.group.traverse((o) => {
      if (!bb && o.isMesh && o.geometry) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        bb = { box: o.geometry.boundingBox, mesh: o };
      }
    });
    let k = 0;
    for (const x of [bb ? bb.box.min.x : -0.3, bb ? bb.box.max.x : 0.3]) {
      for (const y of [bb ? bb.box.min.y : -0.38, bb ? bb.box.max.y : 0.28]) {
        for (const z of [bb ? bb.box.min.z : -0.54, bb ? bb.box.max.z : 0.53]) {
          const v = out[k] || (out[k] = new V());
          v.set(x, y, z);
          if (bb) bb.mesh.localToWorld(v);
          k++;
        }
      }
    }
    out.length = k;
    return out;
  },

  computeCloseRig(hero = 0, { needBoth = false } = {}) {
    const V = this.THREE.Vector3;
    const cam = this.scene.camera;
    const p1 = this.pigs[0].p, p2 = this.pigs[1].p;
    const band = this.frameBand();
    // The subject is each pig's eight rotated AABB corners — see fitPose.
    const corners = [this.pigCorners(0), this.pigCorners(1)];
    const both = [...corners[0], ...corners[1]];

    const dx = p2[0] - p1[0], dz = p2[2] - p1[2];
    const sep = Math.hypot(dx, dz) || 1;
    const axis = { px: -dz / sep, pz: dx / sep, lx: dx / sep, lz: dz / sep };

    // Where the hero pig's nose points, in world space. `snout` is the pig's +Z
    // (SPEC: "+Z = snout direction"), pushed through its current rotation.
    const h0 = hero === 1 ? 1 : 0;
    const hp = this.pigs[h0];
    const snout = new V(0, 0, 1)
      .applyQuaternion(this._qb.set(hp.q[0], hp.q[1], hp.q[2], hp.q[3]));
    // Flattened to the ground plane: the reveal camera's elevation is fixed by
    // heightRatio, so only the compass bearing of the snout is a real choice.
    snout.y = 0;
    if (snout.lengthSq() < 1e-4) snout.set(0, 0, 1); else snout.normalize();
    const heroAt = new V(hp.p[0], hp.p[1], hp.p[2]);

    const mid = new V((p1[0] + p2[0]) / 2, REVEAL.midY, (p1[2] + p2[2]) / 2);
    // Hard ceiling: the reveal is not allowed to be a wide shot. Anything past
    // heroFrac of the overview distance loses to the hero shot on principle, not
    // on taste — see REVEAL.heroFrac.
    const ceiling = Math.min(REVEAL.maxDist, (this._overviewDist || REVEAL.maxDist) * REVEAL.heroFrac);
    const pack = (rig, pts, at) => ({
      mid: at, px: rig.px, pz: rig.pz, dist: rig.dist, bias: rig.bias,
      swing: rig.swing, hero: pts.length === corners[0].length, drift: 0, _pos: new V(),
    });
    /** Walk a solved rig outward until the ZOOM-IN fits too, or give up. */
    const repair = (rig, pts, at, limit) => {
      if (!rig) return null;
      const packed = pack(rig, pts, at);
      for (let k = 0; k <= REVEAL.pathRepairs; k++) {
        if (this.pathFits(pts, band, packed)) return packed;
        packed.dist *= REVEAL.pathStep;
        if (packed.dist > limit) return null;
      }
      return null;
    };
    /** The hero shot: the pig that earned the round, alone and close. */
    const solveHero = () => {
      const one = corners[h0];
      const solo = new V(hp.p[0], REVEAL.midY, hp.p[2]);
      const r = this.solveRig(one, solo, axis, band, REVEAL.maxDist, snout, heroAt);
      return repair(r, one, solo, REVEAL.maxDist);
    };
    /** px of eye this rig delivers on the hero pig — SPEC's own promise, measured. */
    const eyePxOf = (packed) => {
      if (!packed) return 0;
      const px = this.scene.renderer.domElement;
      const hpx = px.clientHeight || px.height || 600;
      const tanHalfV = Math.tan((this.scene.camera.fov * 0.5 * Math.PI) / 180);
      const depth = this.closeRigPose(packed).pos.distanceTo(heroAt);
      return (2 * REVEAL.eyeR * (hpx / 2)) / (Math.max(0.2, depth) * tanHalfV);
    };

    let out = repair(this.solveRig(both, mid, axis, band, ceiling, snout, heroAt),
                     both, mid, ceiling);
    /* The pair shot is preferred, and then the SCALE promise decides.
     *
     * ROUND-4, portrait: a Snouter + Sider 3.4 m apart on a 351x548 canvas can be
     * framed as a pair — at 8.3 m, which is 14.8 px of eye against this file's
     * promise of 20. That is the round-2 failure again ("the reveal is just a slightly
     * lower overview"), arrived at from the other direction. When the pair cannot pay
     * for a face, the hero shot can: one pig, close, and the partner's chip hides
     * itself under beat 6.
     *
     * EXCEPT when both pigs ARE the result. A Pig Out means "these two are opposite
     * sides" and an Oinker means "these two are touching"; a close-up of one pig
     * cannot say either, so those rounds keep the pair shot at whatever scale it
     * costs. `needBoth` is passed down from startReveal. */
    const pairEye = eyePxOf(out);
    if (!needBoth && pairEye < REVEAL.minEyePx) {
      const solo = solveHero();
      // …and only if it is a real gain, so a marginal pair shot is not thrown away
      if (solo && eyePxOf(solo) > pairEye * 1.25) out = solo;
    }
    if (!out) out = solveHero();
    // Last resort: nothing fit anywhere. Keep the pair's geometry at the ceiling —
    // a wide shot is a bad reveal, an un-aimed camera is a broken one.
    if (!out) {
      out = pack({ dist: ceiling, px: axis.px, pz: axis.pz, swing: 0, bias: 0 }, both, mid);
    }
    return out;
  },

  closeRigPose(rig) {
    const cos = Math.cos(rig.drift), sin = Math.sin(rig.drift);
    const rx = rig.px * cos - rig.pz * sin;
    const rz = rig.px * sin + rig.pz * cos;
    rig._pos.set(
      rig.mid.x + rx * rig.dist,
      rig.mid.y + rig.dist * REVEAL.heightRatio,
      rig.mid.z + rz * rig.dist
    );
    return { pos: rig._pos, look: rig.mid, bias: rig.bias || 0 };
  },

  /**
   * ROUND-3, and this is the other half of "the camera never arrived".
   *
   * The phase clock used to be `r.t += dt`, a sum of frame deltas that `step()`
   * clamps to 0.1 s so one late frame cannot teleport a pig. That clamp is right
   * for the pigs and wrong for a beat: on a renderer painting at 1 Hz — which is
   * what a hidden/automated browser tab actually does, MEASURED here: `setTimeout`
   * is throttled to ~1000 ms and rAF stops entirely — the 1.3 s zoom-in needs 13
   * REAL seconds, while `_revealGuard` (total + 1200 ms of wall clock) cuts the
   * whole reveal off at 6.4 s. The reveal was being truncated less than halfway in,
   * and every frame sampled inside it caught a camera in transit.
   *
   * Both clocks are the wall clock now, so they cannot disagree: `zoomInMs` after
   * the round is called the camera is on the rig, whether that took 78 frames or
   * one. The orbit drift uses the real inter-frame delta for the same reason
   * (clamped, since a 5 s gap must not spin the camera round the board).
   */
  stepReveal() {
    const r = this.reveal;
    if (!r) { this.mode = 'idle'; return false; }
    const now = performance.now();
    if (!r.phaseAt) r.phaseAt = now;
    const dt = Math.min((now - (r.frameAt || now)) / 1000, 0.25);
    r.frameAt = now;
    r.t = (now - r.phaseAt) / 1000;
    const nextPhase = (name) => { r.phase = name; r.phaseAt = now; r.t = 0; };
    let arrived = false;
    if (r.phase === 'in') {
      if (r.t >= REVEAL.zoomInMs / 1000) {
        nextPhase('hold');
        arrived = true;
      }
    } else if (r.phase === 'hold') {
      // …never past the span solveRig actually tested (REVEAL.driftChecks): a
      // starved renderer arrives with a big frame delta, and one over-long step
      // must not walk the camera to a bearing nobody checked for a crop.
      this.closeRig.drift = Math.min(
        revealDriftSpan(),
        this.closeRig.drift + REVEAL.holdOrbit * dt,
      );
      if (r.oinker && !r.burst && r.t >= REVEAL_FX.oinkerExplodeDelay) {
        r.burst = true;
        this.burstPigsNow();
      }
      if (r.t >= REVEAL.holdMs / 1000) {
        // the way OUT starts from wherever the camera actually is
        this.markRevealFrom();
        nextPhase('out');
      }
    } else if (r.t >= REVEAL.zoomOutMs / 1000) {
      this.finishReveal();
      return true;
    }
    this.glideCamera(r.phase);
    /* ROUND-2 REVIEW: "the scoring celebration is a scatter of brown-olive dust
     * across the whole arena … on screen a +20 Combo produces dozens of 1-2 px
     * specks." A big part of that measurement was WHEN, not what: the burst used
     * to be spawned by revealResult, i.e. while the camera was still 21 m out at
     * the overview, and its 1.15 s life was two thirds spent before the 1.3 s
     * zoom-in even arrived. It fires on the frame the camera lands instead.
     *
     * ROUND-3: and it fires AFTER glideCamera, not before, so "the frame the
     * camera lands" is literally true — the camera is on the rig for this frame
     * before any spark exists. Firing it above meant the burst was spawned one
     * frame ahead of the arrival it was waiting for, which on a starved renderer
     * was the whole zoom-in. */
    if (arrived) {
      /* The RESULT TEXT lands here too, on the same frame as the reward and for
       * the same reason — see revealResult's round-3 note. Announcing it at the
       * round call meant the headline and the score had been readable for the whole
       * 1.3 s zoom-in, so the reveal was showing the player something they had
       * already been told. */
      if (r.arrive) { const fn = r.arrive; r.arrive = null; fn(); }
      if (r.celebrate) {
        const c = r.celebrate;
        r.celebrate = null;
        this.celebrateScore(c.poses, c.points);
      }
    }
    return true;
  },

  /**
   * The reveal camera's target pose for the close rig, written into the scratch
   * aim camera (so nothing is allocated per frame).
   * @returns {{pos:THREE.Vector3, quat:THREE.Quaternion}}
   */
  closeTarget() {
    return this.closeRigPose(this.closeRig);
  },

  /**
   * Point the real camera at `look` from `pos`, pitched down by `bias` half-frames
   * (the composition lift that keeps the pigs clear of the result card).
   */
  aimCamera(pos, look, bias) {
    const cam = this.scene.camera;
    cam.position.copy(pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(look);
    this.aimDown(cam, bias);
    cam.updateMatrixWorld();
  },

  /**
   * The point a camera is actually looking AT, on the plane the reveal aims in.
   *
   * Needed because the reveal interpolates its look point rather than its
   * quaternion — see glideCamera. Reading it back off the camera means the pose at
   * u = 0 reproduces the camera EXACTLY (its forward ray passes through the point
   * by construction), so no phase can start with a snap.
   */
  lookPointOf(cam, out) {
    const fwd = out.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const dy = cam.position.y - REVEAL.midY;
    // a downward-looking camera hits the plane; a level one gets a point ahead
    const t = fwd.y < -0.02 ? dy / -fwd.y : 12;
    return out.multiplyScalar(clamp(t, 1.5, 40)).add(cam.position);
  },

  /** Remember where a phase is moving FROM, so its interpolation is absolute. */
  markRevealFrom() {
    const cam = this.scene.camera;
    const r = this.reveal;
    if (!r) return;
    const V = this.THREE.Vector3;
    r.fromPos = (r.fromPos || new V()).copy(cam.position);
    r.fromLook = this.lookPointOf(cam, r.fromLook || new V());
    // the bias is already baked into the pose `fromLook` was read out of
    r.fromBias = 0;
  },

  /**
   * Move the camera for this frame.
   *
   * ABSOLUTE interpolation from the pose the phase started at (see REVEAL's
   * round-3 note), and it interpolates the LOOK POINT rather than the quaternion.
   * That second part is not a detail: MEASURED on the first build of the absolute
   * transport, with position lerped and rotation slerped, at u = 0.83 of the
   * zoom-in the hero pig sat at ndc y −2.61…−1.26 — a whole frame-height below the
   * bottom edge — because a straight-line dolly and a great-circle rotation do not
   * agree about where they are pointing in between. Interpolating (position, look
   * point, bias) instead means the camera is aimed at a point that travels from the
   * board's centre to the pigs' midpoint, so the subject is inside the frame for
   * every frame of the move, not just at both ends. `lookPointOf` recovers the
   * start point from the live camera, so u = 0 is exactly the pose it began in.
   */
  glideCamera(phase) {
    const r = this.reveal;
    if (!r) return;
    if (!r.fromPos) this.markRevealFrom();
    if (phase === 'out') {
      const u = ease(clamp(r.t / (REVEAL.zoomOutMs / 1000), 0, 1));
      // bias 0 at BOTH ends: each end's own lift is already baked into the look
      // point it was read out of, so adding it again would double-pitch the camera
      this.arcTo(r.fromPos, r.fromLook, this._overviewPos, this.overviewLook(), u, 0);
    } else {
      const t = this.closeTarget();
      if (phase === 'in') {
        const u = ease(clamp(r.t / (REVEAL.zoomInMs / 1000), 0, 1));
        this.arcTo(r.fromPos, r.fromLook, t.pos, t.look, u, t.bias * u);
      } else {
        // hold: `in` guaranteed arrival, so track the drifting rig exactly
        this.aimCamera(t.pos, t.look, t.bias);
      }
    }
  },

  /**
   * Move the camera along an ARC around its subject: interpolate the look point,
   * the horizontal DISTANCE to it, the BEARING around it and the height — not the
   * camera's xyz.
   *
   * ROUND-3, third and last thing wrong with the transport. With the look point
   * interpolated but the position lerped in a straight line, MEASURED at u = 0.83
   * of the zoom-in on a 3.33 m spread: the hero pig sat at ndc y −1.16…−0.06 and its
   * partner at 0.62…1.13, i.e. both clipped, even though the arrival frame and the
   * whole 3 s hold were comfortably inside. The reason is that a chord cuts inside
   * the arc — the straight line from a 17 m top-down overview to a 5 m low reveal
   * passes much nearer one pig than either endpoint does, so the pair's angular
   * spread OVERSHOOTS the final framing partway through and the frame cannot hold
   * it. Interpolating the polar coordinates keeps the distance monotone between the
   * two shots, and the fit is monotone in distance, so if the destination fits,
   * every frame on the way in fits too.
   */
  /**
   * The pose `u` of the way along that arc, written into scratch vectors.
   *
   * Split out of arcTo so the SOLVE can ask the same question the render asks:
   * "where exactly will the camera be partway through this move?" — see pathFits.
   * @returns {{pos:THREE.Vector3, look:THREE.Vector3}} reused scratch
   */
  arcPose(fromPos, fromLook, toPos, toLook, u) {
    const V = this.THREE.Vector3;
    this._glideLook = this._glideLook || new V();
    this._glidePos = this._glidePos || new V();
    const polar = (p, l) => ({
      d: Math.hypot(p.x - l.x, p.z - l.z),
      a: Math.atan2(p.z - l.z, p.x - l.x),
      y: p.y - l.y,
    });
    const A = polar(fromPos, fromLook), B = polar(toPos, toLook);
    let da = B.a - A.a;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const d = A.d + (B.d - A.d) * u;
    const ang = A.a + da * u;
    const y = A.y + (B.y - A.y) * u;
    const look = this._glideLook.lerpVectors(fromLook, toLook, u);
    this._glidePos.set(look.x + Math.cos(ang) * d, look.y + y, look.z + Math.sin(ang) * d);
    return { pos: this._glidePos, look };
  },

  arcTo(fromPos, fromLook, toPos, toLook, u, bias) {
    const p = this.arcPose(fromPos, fromLook, toPos, toLook, u);
    this.aimCamera(p.pos, p.look, bias);
  },

  /**
   * Does the camera hold its subject for every frame of the WAY IN as well?
   *
   * ROUND-4, and this is the last place a crop was hiding. The drift fix above made
   * the hold safe and the arc was ASSUMED safe: SPEC argued "the distance is monotone
   * between the two shots and the fit is monotone in distance, so if the destination
   * fits, every frame on the way in fits". The distance half is true; the BEARING half
   * is not. `arcPose` also sweeps the bearing from the overview's to the rig's, and at
   * an intermediate bearing the pair's projected spread can exceed what the frame holds
   * at that intermediate distance. MEASURED, portrait 375x812 (canvas 351x548), a
   * Snouter + Sider: the destination at 8.82 m sat at worst |ndc| 0.84 and the whole
   * 3 s hold stayed under it — while the zoom-in passed through 1.014, 1.076, 1.133 and
   * **1.159** on its way there, i.e. a pig fully off-canvas mid-move, with the chip
   * correctly hiding itself and nothing to hide behind.
   *
   * So the path is sampled too, with the SAME interpolated bias the render uses
   * (`t.bias * u`). It is checked on the winner rather than inside the binary search
   * because the fix for a failure is more distance, and the intermediate distances grow
   * monotonically with the destination's — so a short outward walk repairs it.
   */
  pathFits(pts, band, rig) {
    const cam = this.scene.camera;
    const aim = this._camAim;
    aim.fov = cam.fov; aim.aspect = cam.aspect;
    aim.near = cam.near; aim.far = cam.far;
    const V = this.THREE.Vector3;
    this._pathFrom = this._pathFrom || new V();
    this._pathLook = this._pathLook || new V();
    const fromPos = this._pathFrom.copy(cam.position);
    const fromLook = this.lookPointOf(cam, this._pathLook);
    const t = this.closeRigPose(rig);
    // the destination's own pose is verified by the solve; these are the frames in
    // between, at the same four points the eye actually notices a clipped pig
    for (const u of REVEAL.pathChecks) {
      const p = this.arcPose(fromPos, fromLook, t.pos, t.look, u);
      if (!this.fitPose(aim, p.pos, p.look, pts, band, REVEAL.pointPad, t.bias * u).fits) {
        return false;
      }
    }
    return true;
  },

  /** Where the overview rig is looking — cached, it only moves on a re-frame. */
  overviewLook() {
    if (!this._overviewLook) {
      this._overviewLook = new this.THREE.Vector3();
      this._camAim.position.copy(this._overviewPos);
      this._camAim.quaternion.copy(this._overviewQuat);
      this.lookPointOf(this._camAim, this._overviewLook);
    }
    return this._overviewLook;
  },

  /**
   * The reward beat (SPEC "Presentation model"; round-1 review: "doubles /
   * snouter / jowler need particles, a camera punch, a scale pop on the scoring
   * pig, and a gold burst scaled to the points").
   *
   * Only the pigs that actually SCORED get a burst and a pop — on a
   * "Razorback + Trotter Combo" both fire, on a plain Trotter beside a Sider only
   * one does, and that asymmetry is information: it shows the player which pig
   * earned the points. The camera punch is one shared shove, sized by the round.
   *
   * @param {string[]} poses the two settled poses, in pig order
   * @param {number} points what the round scored
   */
  celebrateScore(poses, points) {
    if (!this.ready || !points) return;
    const at = [];
    const groups = [];
    poses.forEach((pose, i) => {
      if ((odds.POSES[pose]?.points ?? 0) <= 0) return;
      const pig = this.pigs[i];
      if (!pig) return;
      at.push({ x: pig.p[0], y: pig.p[1] + 0.10, z: pig.p[2] });
      groups.push(pig.group);
    });
    // A Sider is one point and no pig scored on its own — celebrate at the pair's
    // midpoint rather than nowhere, so even the smallest win has a spark.
    if (!at.length) {
      const [a, b] = this.pigs;
      at.push({
        x: (a.p[0] + b.p[0]) / 2,
        y: Math.max(a.p[1], b.p[1]) + 0.14,
        z: (a.p[2] + b.p[2]) / 2,
      });
      groups.push(a.group, b.group);
    }
    cheer(at, points);
    popPigs(groups, points);
    this.cameraPunch(points);
    this.dirty = true;
  },

  /**
   * A short, decaying shove on the camera, scaled by what the round was worth.
   *
   * Reuses the shake machinery but on its own clock: `cameraShake` is a steady
   * sinusoid driven by the hold, and a punch has to spend itself. It is applied
   * inside stepReveal so it rides on top of whatever the reveal glide is doing.
   */
  cameraPunch(points = 5) {
    if (!this.ready || reducedMotion) return;
    const mag = clamp(0.012 + points * 0.0032, 0.012, 0.075);
    // wall-clock, like the reveal's own clock: a punch that ages on frame deltas
    // leaves the camera shoved for seconds on a starved renderer
    this.punch = { t: 0, born: performance.now(), mag, ms: 380 };
  },

  /** Take last frame's shove back OFF the camera, so the offset can never
   *  accumulate and the reveal glide always reads a clean position. Called at
   *  the top of every frame, before anything moves the camera. */
  unpunch() {
    if (!this._punchOn) return;
    this.scene.camera.position.sub(this._punchOff);
    this._punchOn = false;
  },

  stepPunch() {
    const p = this.punch;
    if (!p) return false;
    p.t = (performance.now() - p.born) / 1000;
    const f = Math.min(1, (p.t * 1000) / p.ms);
    if (f >= 1) { this.punch = null; return false; }
    const off = this._punchOff || (this._punchOff = new this.THREE.Vector3());
    const a = p.mag * (1 - f) * Math.sin(f * Math.PI * 5.5);
    off.set(a, a * 0.7, a * 0.35);
    const cam = this.scene.camera;
    cam.position.add(off);
    this._punchOn = true;
    cam.updateMatrixWorld();
    return true;
  },

  /** The Oinker exit: chips away, pigs pop, particles fly. */
  burstPigsNow() {
    this.hideChips();
    this.faces('panic');
    burstPigs(
      this.pigs.map((p) => p.group),
      this.pigs.map((p) => ({ x: p.p[0], y: p.p[1], z: p.p[2] }))
    );
    this.dirty = true;
  },

  finishReveal() {
    clearTimeout(this._revealGuard);
    const had = !!this.reveal;
    /* LAST LINE OF DEFENCE for the deferred result text. Every path into the reveal
     * either arrives or is skipped, and both fire `arrive` — but if any future path
     * ever ends a reveal without doing so, the player would be left looking at an
     * invisible result card, which is a worse failure than showing it a beat late. */
    if (this.reveal && this.reveal.arrive) {
      const fn = this.reveal.arrive;
      this.reveal.arrive = null;
      fn();
    }
    this.reveal = null;
    if (this.cup) this.cup.visible = true;
    if (this.cupShadow) this.cupShadow.visible = true;
    if (this.mode === 'reveal') this.mode = 'idle';
    if (this.ready) {
      // the punch is a camera offset; drop it before homing, or the next frame's
      // unpunch() would subtract it from the overview rig
      this.unpunch();
      this.punch = null;
      // home the camera exactly, so the next toss starts from the overview
      const cam = this.scene.camera;
      cam.position.copy(this._overviewPos);
      cam.quaternion.copy(this._overviewQuat);
      cam.updateMatrixWorld();
      this.dirty = true;
    }
    const done = this._revealDone;
    this._revealDone = null;
    if (done) done();
    return had;
  },

  /**
   * No-tumble presentation: Quick Toss, prefers-reduced-motion, and the §6.3
   * fallback. The pigs are placed in the poses the draw already produced, so
   * the pen still agrees with the scoreboard — it just skips the flight.
   */
  showInstant(outcome, displayPoses = null) {
    if (!this.ready) return;
    this.resetPresentation();
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

const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * One of index.html's drawn glyphs, as an element.
 *
 * SPEC "art direction": there are no emoji in this build. Anything game.js paints
 * into the DOM that needs a mark uses a `<symbol>` from `#icon-defs` — same 24×24
 * grid, same stroke weight, colour inherited from the text it sits in — so a
 * scoreboard marker and a headline glyph cannot drift apart, and neither of them
 * changes shape between an iPhone and a Pixel the way an emoji font does.
 */
function icon(name, px = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', px);
  svg.setAttribute('height', px);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

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
  inputHint: $('inputHint'),
  poseLabels: [$('poseLabel0'), $('poseLabel1')],
  chips: [$('pigChip0'), $('pigChip1')],
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
  // device-motion opt-in (SPEC "Shake interaction" 3). Hidden by default in the
  // markup; game.js unhides it only where DeviceMotionEvent actually exists.
  motionRow: $('motionRow'),
  motionToggle: $('motionToggle'),
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
  remove.append(icon('close', 15));
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
    // the drawn pig mark, not the platform emoji (SPEC "art direction")
    if (i === state.currentIndex && state.screen === 'game') marker.append(icon('pig', 19));

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

/* The card is now the ONLY thing game.js paints over the felt besides the
 * per-pig chips (round-1 review, UI/layering: four text layers could stack on
 * the board at once). The reveal camera reads its live height through
 * adapter.cardBias() and composes the pigs above it, so keep it short — a card
 * that grows taller pushes the pigs further up the frame. */
/**
 * @param {object} [o]
 *   pending — lay the card out but keep it INVISIBLE (`.pending`), for a result
 *     whose reveal has not arrived yet. It must still occupy its box: both
 *     frameBand() (the reveal's fit) and projectChips() (the chip clamp) measure
 *     this element live to keep the pigs and their labels out of its band, so a
 *     card that is display:none until the camera lands would let the solve frame
 *     the pigs exactly where the card is about to appear.
 *   icon — an inline-SVG glyph id from ICONS, drawn before the headline.
 */
function setResultCard(tone, headline, detail, o = {}) {
  // a fresh className drops `arrive` too, so the entrance re-plays per result
  dom.resultCard.className = 'result-card' + (tone ? ` ${tone}` : '') +
    (o.pending ? ' pending' : '');
  dom.resultHeadline.textContent = '';
  if (o.icon) dom.resultHeadline.append(icon(o.icon, 22));
  dom.resultHeadline.append(document.createTextNode(headline));
  dom.resultDetail.textContent = detail || '';
  dom.resultCard.hidden = false;
}

/** Un-hide a card that was set `pending` — the frame the reveal camera lands.
 *  `.arrive` plays the entrance (a rise, or a shake on the two failure tones). */
function showResultCard() {
  dom.resultCard.classList.remove('pending');
  /* An entrance animation does not ADVANCE while the document is hidden: it starts,
   * pins at its 0% keyframe and stays there. MEASURED here — with the card's
   * appearance carried by a transition, and then by a fill-less animation, the
   * computed opacity was still 0 five seconds after the camera had landed. A hidden
   * tab therefore gets the arrived state directly; nobody is watching the flourish,
   * and an invisible result is a real failure. */
  if (!document.hidden && !reducedMotion) dom.resultCard.classList.add('arrive');
}

function clearResultCard() {
  dom.resultCard.hidden = true;
  dom.resultCard.classList.remove('pending', 'arrive');
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
  if (!pose) return '—';
  return POSE_LABELS[pose] ?? odds.POSES[pose]?.label ?? pose;
}

/* These two spans are the screen-reader mirror of the projected chips — the same
 * words, in a live region, with nothing painted on the felt. They were a visible
 * chip row until the round-1 review pointed out it duplicated the chips verbatim
 * while showing "Ready" during the shake and "…" during flight. Placeholders are
 * now the empty string: a live region should announce the pose or say nothing. */
function setPoseLabel(i, label) {
  if (dom.poseLabels[i]) dom.poseLabels[i].textContent = label ?? '';
}

function setPoseLabels(labelA, labelB) {
  setPoseLabel(0, labelA);
  setPoseLabel(1, labelB);
}

/* -------------------------------------------------------------------------
 * Per-pig settle calls (SPEC "Presentation model" beat 1). The adapter watches
 * the replay clock and reports each pig the moment IT stops — its pen label and
 * its floating chip land right then, without waiting for the other pig. A
 * settled pig that gets bumped goes back to "resettling…" and the round waits.
 * ---------------------------------------------------------------------- */

adapter.onPigSettle = (i, call) => {
  const pts = odds.POSES[call.pose]?.points ?? 0;
  setPoseLabel(i, poseLabel(call.pose));
  adapter.showChip(i, `${poseLabel(call.pose)} <small>${pts} pts</small>`);
};

adapter.onPigBump = (i) => {
  setPoseLabel(i, 'resettling');
  adapter.showChip(i, 'resettling… <small>got bumped</small>', { resettling: true });
};

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
  clearBlink();
  adapter.hideChips();
  setPoseLabels('', '');
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

/* -------------------------------------------------------------------------
 * The round call, in two halves.
 *
 *   revealResult()  — what the player learns: labels, card, score, audio,
 *                     the pigs' faces. Fires the instant the round is called.
 *   concludeToss()  — what the player may do next: buttons back on, or the
 *                     pass-the-pigs beat. Fires AFTER the camera reveal, so the
 *                     next toss can't start while the camera is still close in.
 *
 * Splitting them is what lets beat 3 exist: the reveal is 5.2 s of camera work
 * between "here is your result" and "your move".
 * ---------------------------------------------------------------------- */

/** Faces at the round call (SPEC "Character & expressions"): the outcome
 *  overrides whatever each pig wore when it settled. */
function setRoundFaces(outcome, result) {
  if (!adapter.ready) return;
  if (outcome.oinker) { adapter.faces('panic'); return; }
  if (result.type === 'pigout') { adapter.faces('sad'); return; }
  if (result.type === 'double') { adapter.faces('wink'); return; }
  [outcome.a, outcome.b].forEach((pose, i) => adapter.face(i, settleExpression(pose)));
}

let oinkerStingTimer = null;
/** The Oinker sting, timed so its pop lands on the frame the pigs burst. */
function scheduleOinkerSting(delayMs) {
  clearTimeout(oinkerStingTimer);
  if (delayMs <= 0) { sadness('oinker'); return; }
  oinkerStingTimer = setTimeout(() => {
    oinkerStingTimer = null;
    sadness('oinker');
  }, delayMs);
}
function fireOinkerStingNow() {
  if (!oinkerStingTimer) return;
  clearTimeout(oinkerStingTimer);
  oinkerStingTimer = null;
  sadness('oinker');
}

/**
 * Everything the player sees once the pigs have stopped moving.
 * `played` is what the adapter actually replayed, or null on the no-tumble
 * paths (Quick Toss, reduced motion, resume).
 *
 * ROUND-3 REVIEW: "the result card headline and the THIS TURN score both fire the
 * instant the round resolves, ~1.3 s before the camera arrives and before any
 * celebration … the text spoils the outcome before the reveal plays, which is
 * exactly the reasoning SPEC applies to celebrateScore — it just wasn't applied to
 * the card or the score."
 *
 * So this function now splits along the same seam celebrateScore already used. The
 * MODEL is committed here, always and immediately — points, `pending` cleared,
 * `saveGame()` — because Approach B requires that a reload can never duck a result.
 * The two things that ANNOUNCE it, the card's text and the turn-total counter, are
 * deferred into `showdown`, which the reveal fires on the frame the camera lands
 * (and which a skip tap fires too, for the same reason the Oinker still pops on a
 * skip). With no reveal to wait for — Quick Toss, reduced motion, a resumed page —
 * it runs here.
 *
 * The card is still SET here, as `pending`: invisible, but laid out, because the
 * reveal's own fit test measures its box to keep the pigs out of its band.
 *
 * @returns {{kind:'oinker'|'pigout'|'score', result:object|null, showdown:Function}}
 */
function revealResult(outcome, played = null, { instant = false } = {}) {
  state.tossedThisTurn = true;
  // fired on the reveal's arrival, or right here when there is no reveal
  let showdown = () => {};
  const announce = (fn) => {
    showdown = () => { showdown = () => {}; fn(); };
    if (instant || reducedMotion || !adapter.ready) showdown();
  };

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
    setResultCard(
      'awful',
      'Oinker!!',
      `The pigs are touching — ${player.name} back to zero.`,
      { pending: true, icon: 'oinker' },
    );
    announce(() => {
      renderTurnBanner();
      renderScoreboard();
      showResultCard();
    });
    setRoundFaces(outcome, { type: 'oinker' });
    // The sting's pop is the sound of the pigs bursting, so on the full reveal
    // it waits for them; with no reveal there is nothing to wait for.
    scheduleOinkerSting(instant
      ? 0
      : REVEAL.zoomInMs + REVEAL_FX.oinkerExplodeDelay * 1000 - OINKER_POP_S * 1000);
    revealToss({ ...outcome, type: 'oinker', points: 0, headline: 'Oinker!!' });

    setTurnState('resolved');
    setActionsEnabled({ toss: false, stop: false, quick: false });
    return { kind: 'oinker', result: null, showdown: () => showdown() };
  }

  const result = odds.scoreToss(outcome.a, outcome.b);
  setPoseLabels(poseLabel(outcome.a), poseLabel(outcome.b));
  setRoundFaces(outcome, result);

  if (result.type === 'pigout') {
    state.turnTotal = 0;
    state.pending = null;
    state.turnEndPending = true;
    saveGame();
    setResultCard('bad', result.headline, result.detail, { pending: true, icon: 'oinker' });
    announce(() => {
      renderTurnBanner();
      showResultCard();
    });
    sadness('pigout');
    revealToss({ ...outcome, ...result });

    setTurnState('resolved');
    setActionsEnabled({ toss: false, stop: false, quick: false });
    return { kind: 'pigout', result, showdown: () => showdown() };
  }

  state.turnTotal += result.points;
  state.pending = null;
  saveGame();

  const tone = result.type === 'double' ? 'big' : 'good';
  // No "Turn total: N." — the header pill carries the running total and now BUMPS
  // on the same frame as the card (see odds.js's round-3 copy note).
  setResultCard(tone, result.headline, result.detail, {
    pending: true,
    icon: result.type === 'double' ? 'trophy' : null,
  });
  announce(() => {
    renderTurnBanner();
    bumpTurnPoints();
    renderScoreboard();
    showResultCard();
  });
  if (result.type === 'double') celebrate('double');
  revealToss({ ...outcome, ...result });
  // The VISUAL payoff — gold burst, scale pop, camera punch — scaled to the
  // round. Round-1 review: this was missing entirely, so the game punished with
  // spectacle and rewarded with silence.
  //
  // ROUND-2 REVIEW: it is now HANDED to the reveal instead of fired here, so it
  // lands on the frame the close camera arrives (adapter.stepReveal). Firing it
  // here meant a burst seen from 21 m that was mostly over before the zoom-in
  // finished. With no reveal to wait for, it still fires immediately below.
  const cheerWith = { poses: [outcome.a, outcome.b], points: result.points };
  if (instant || reducedMotion || !adapter.ready) adapter.celebrateScore(cheerWith.poses, cheerWith.points);

  setTurnState('resolved');
  setActionsEnabled({ toss: false, stop: false, quick: false });
  return {
    kind: 'score', result, celebrate: cheerWith, hero: heroIndex(outcome),
    showdown: () => showdown(),
  };
}

/** Which pig earned the round — the one a hero close-up should frame. */
function heroIndex(outcome) {
  const pa = odds.POSES[outcome.a]?.points ?? 0;
  const pb = odds.POSES[outcome.b]?.points ?? 0;
  return pb > pa ? 1 : 0;
}

/** Beat 3 — the camera choreography, skipped entirely on the no-tumble paths
 *  and under prefers-reduced-motion (SPEC beat 5: the reveal collapses to the
 *  result text, which revealResult has already shown). */
async function runRevealBeats(desc, { instant }) {
  if (instant || reducedMotion || !adapter.ready) return;
  await adapter.startReveal({
    pigOut: desc.kind === 'pigout',
    oinker: desc.kind === 'oinker',
    hero: desc.hero || 0,
    celebrate: desc.celebrate || null,
    // the card's text and the turn counter, held back until the camera lands
    arrive: desc.showdown || null,
  });
}

/** What the player may do next, once the reveal is over. */
function concludeToss(desc) {
  if (desc.kind === 'oinker') {
    scheduleTurnEnd(reducedMotion ? 500 : 900);
    return;
  }
  if (desc.kind === 'pigout') {
    scheduleTurnEnd(reducedMotion ? 500 : 800);
    return;
  }
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

/* A one-shot outcome override for the NEXT toss, set only from the dev handle
 * (`hogwild.force({ a:'side-blank', b:'side-dot' })` / `{ oinker:true }`). It
 * exists because a Pig Out is a 1-in-5 wait and an Oinker a 1-in-260 one, and
 * the reveal beats for both have to be verifiable on demand. It does not weaken
 * Approach B: the outcome is still fixed before any search or animation runs. */
let forcedOutcome = null;
function takeForcedOutcome() {
  const o = forcedOutcome;
  forcedOutcome = null;
  return o;
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
  clearBlink();
  adapter.hideChips();
  setPoseLabels('', '');

  // Approach B (SPEC.md): draw the outcome FIRST, independent of hold
  // duration/shake — those only affect how the toss looks.
  const outcome = takeForcedOutcome() ?? odds.drawToss();
  // Oinker flavor poses are chosen here so the pen and the labels agree even
  // on the instant path.
  state.oinkerShown = outcome.oinker ? [pickDisplayPose(), pickDisplayPose()] : null;
  state.pending = outcome;
  saveGame();

  // prefers-reduced-motion makes the no-tumble path the default (PRD §7.4)
  const instant = quick || reducedMotion || !adapter.ready;
  try {
    const played = await playToss(outcome, { instant });
    setTurnState('settling');
    const desc = revealResult(outcome, played, { instant });
    await runRevealBeats(desc, { instant });
    concludeToss(desc);
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
  concludeToss(revealResult(outcome, null, { instant: true }));
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
 * Shake input — ONE pipeline, three sources
 * (SPEC "Shake interaction" must-fixes 2 and 3)
 *
 * Mobile: hold anywhere in the pen. Desktop: hold the Go Hog Wild button or
 * hold Space. Opt-in: shake the phone itself. Min hold 250 ms so a stray tap
 * doesn't toss. Release outside the pen still throws.
 *
 * ------------------------------------------------------------------------
 * THE MOBILE BUG (owner, real phone: "one tick of shake sound, no ongoing
 * shake animation, no toss") AND ITS ROOT CAUSE.
 *
 * It was `window.addEventListener('pointercancel', cancelHold)`.
 *
 * A hold-to-shake gesture IS a long press, and a long press is a gesture the
 * platform wants for itself: on Android Chrome and iOS Safari a press held past
 * ~500 ms starts text selection / the callout menu, and the browser takes the
 * pointer away by firing `pointercancel` — after which NO `pointerup` for that
 * pointer ever arrives. The old code treated that as "the player let go with no
 * intention to throw" and ran `cancelHold`, which stopped the rattle, tweened
 * the pigs back and set `holdActive = false`. The finger was still on the glass.
 * When it finally lifted, `endHold` early-returned on `!holdActive`, so there
 * was no toss. That is the reported triad exactly, and it reproduces to the
 * millisecond — MEASURED in Chrome mobile emulation on the pre-fix build,
 * pointerdown → 'shaking', 500 ms later a `pointercancel` → 'ready', and a
 * `pointerup` 900 ms after that → still 'ready', turn total unchanged.
 *
 * `touch-action: none` was NOT the missing piece and never could have been —
 * it was already on `.pen-wrap` (verified in the computed style), and
 * touch-action governs panning and pinch-zoom, not the long-press gesture.
 *
 * The fix is four things, and all four are load bearing:
 *
 *   1. STOP PROVOKING IT. `user-select: none` + `-webkit-touch-callout: none`
 *      on the pen, its children and the hold button, plus a `contextmenu`
 *      preventDefault on both shake targets, so the platform has no selection or
 *      callout gesture to claim. (MEASURED before: the pen computed
 *      `user-select: auto`, and the most selectable thing on the felt was the
 *      result card's own text.)
 *   2. A `pointercancel` IS NOT A RELEASE. It orphans the gesture instead: the
 *      rattle, the cup and the haptics keep running, and the shake resolves as a
 *      THROW — either when a real release signal finally shows up, or after
 *      `ORPHAN_GRACE_MS`. A player who shook the pigs gets a toss. What is
 *      forbidden is the silent nothing.
 *   3. `setPointerCapture`, so a finger that drifts off the pen onto the result
 *      card or the action bar keeps feeding the same gesture.
 *   4. redundant release signals (`touchend`/`touchcancel`, `blur`, hidden
 *      document) and a hard `HOLD_CAP_MS`, because the one thing worse than a
 *      shake that dies early is a shake that never ends.
 * ==================================================================== */

const MIN_HOLD_MS = 250;
const RAMP_MS = 1000;
/** A pointercancel is not a release, but it is also not forever: this is how
 *  long the orphaned gesture keeps rattling before it resolves as a throw. */
const ORPHAN_GRACE_MS = 900;
/** No gesture legitimately lasts this long; something ate the release event. */
const HOLD_CAP_MS = 12000;
/** Haptic pulse cadence — slow at rest, fast flat out, so the phone buzzes for
 *  the WHOLE hold instead of once (must-fix 2: "haptic pulse run CONTINUOUSLY"). */
const HAPTIC_GAP_IDLE_MS = 260;
const HAPTIC_GAP_FULL_MS = 95;

/** Fallback pump period. See `beginShake`. */
const SHAKE_PUMP_MS = 60;

const shake = {
  active: false,
  source: null,          // 'touch' | 'key' | 'motion'
  t0: 0,
  ramp: 0,
  raf: null,
  timer: null,
  pointers: new Set(),   // every pointer currently down on a shake target
  orphanAt: 0,           // when a pointercancel left us holding nothing
  hapticAt: 0,
  tosses: 0,             // dev/test counters
  cancels: 0,
  orphans: 0,
};

function shakeVisualsOff() {
  dom.hogWildBtn.classList.remove('holding');
  dom.holdFill.style.transform = 'scaleX(0)';
}

/**
 * Start a shake from `source`, or return false if now is not the moment.
 * Everything a shake needs to be CONTINUOUS is set up here and torn down in
 * exactly one place (`stopShake`).
 */
function beginShake(source) {
  if (shake.active) return false;
  if (state.turnState !== 'ready') return false;
  if (dom.body.classList.contains('mode-quick-only')) return false;
  shake.active = true;
  shake.source = source;
  shake.t0 = performance.now();
  shake.ramp = 0;
  shake.orphanAt = 0;
  shake.hapticAt = 0;
  setTurnState('shaking');
  initAudio();
  dom.hogWildBtn.classList.add('holding');
  // the gesture always works (PRD §7.3/§7.4) but prefers-reduced-motion means
  // it must not start a rattle
  if (!reducedMotion) adapter.startShake();
  // the cup rattle: intensity is fed the same 0..1 ramp the fill bar and the
  // pigs use, so what you HEAR is how hard they are being shaken (PRD §11)
  shakeLoop(0);
  /* TWO pumps, and the second one is not belt-and-braces.
   *
   * requestAnimationFrame is the right clock for the RENDER, and it is the wrong
   * clock for a gesture: a throttled or occluded renderer stops it dead. MEASURED
   * in this browser with the pane hidden — the touch was down, `turnState` stayed
   * "shaking", and `ramp` sat at 0.00 for 27 SECONDS: no audio ramp, no haptics,
   * and `HOLD_CAP_MS` never fired either, so the gesture could not even
   * self-rescue. That is the same lesson SPEC's round-3 reveal notes learned about
   * phase clocks, applied to input. The interval keeps the STATE MACHINE — audio
   * intensity, haptic cadence, the orphan grace, the cap, the motion release — on
   * the wall clock whatever the compositor is doing; rAF just makes it smooth
   * when frames are actually being painted. `pumpShake` derives everything from
   * `performance.now()`, so running it twice in a frame costs nothing.
   */
  shake.raf = requestAnimationFrame(shakeFrame);
  shake.timer = setInterval(() => {
    if (shake.active) pumpShake(performance.now());
  }, SHAKE_PUMP_MS);
  // …and only THEN pump frame zero. If this first pump decides the shake is
  // already over, `stopShake` has to be able to find both pumps to clear them;
  // pumping before they exist leaks the interval onto a dead gesture.
  pumpShake(shake.t0);
  return shake.active;
}

function shakeFrame(now) {
  if (!shake.active) return;
  shake.raf = requestAnimationFrame(shakeFrame);
  pumpShake(now);
}

/**
 * One frame of a live shake: intensity → audio + pen + fill bar + haptics, then
 * the release checks that no event is going to deliver for us.
 *
 * This is deliberately the ONLY place the ramp is computed. The touch ramp and
 * the device-motion EMA are two ways of answering the same question, and the
 * whole point of must-fix 3's "drives the SAME shake pipeline" is that after
 * this line nothing downstream knows which one it got.
 */
function pumpShake(now) {
  const elapsed = now - shake.t0;
  const ramp = shake.source === 'motion'
    ? motionIntensity()
    : Math.min(1, elapsed / RAMP_MS);
  shake.ramp = ramp;
  dom.holdFill.style.transform = `scaleX(${ramp})`;
  shakeLoop(ramp);
  adapter.setShakeIntensity(ramp);
  if (now >= shake.hapticAt) {
    shakePulse(ramp);
    shake.hapticAt = now
      + HAPTIC_GAP_IDLE_MS + (HAPTIC_GAP_FULL_MS - HAPTIC_GAP_IDLE_MS) * ramp;
  }

  if (shake.source === 'motion') {
    stepMotionShake(now);
    return;
  }
  // A gesture whose release event never came. Both of these END it as a throw:
  // the player did shake the pigs, and swallowing that is the bug.
  if (shake.orphanAt && now - shake.orphanAt >= ORPHAN_GRACE_MS) { endShake(true); return; }
  if (elapsed >= HOLD_CAP_MS) endShake(true);
}

/** Tear down everything `beginShake` started. Says nothing about the outcome. */
function stopShake() {
  shake.active = false;
  shake.source = null;
  shake.orphanAt = 0;
  shake.pointers.clear();
  if (shake.raf) cancelAnimationFrame(shake.raf);
  shake.raf = null;
  if (shake.timer) clearInterval(shake.timer);
  shake.timer = null;
  stopShakeLoop();
  adapter.setShakeIntensity(null);
  shakeVisualsOff();
}

/**
 * Finish a shake. `toss` false — or a hold too short to have been meant —
 * puts the pigs back; otherwise the pigs fly.
 */
function endShake(toss) {
  if (!shake.active) return;
  const heldMs = performance.now() - shake.t0;
  const wasMotion = shake.source === 'motion';
  stopShake();
  // the sustain window belongs to the gesture that just ended (see onDeviceMotion)
  if (wasMotion) motion.aboveMs = 0;
  if (!toss || heldMs < MIN_HOLD_MS) {
    shake.cancels++;
    adapter.cancelShake();
    setTurnState('ready');
    return;
  }
  shake.tosses++;
  if (wasMotion) { motion.throws++; motion.lastThrow = performance.now(); }
  haptic('toss');
  performToss();
}

/** For every caller that used to say `cancelHold()`. */
function cancelShakeInput() { endShake(false); }

/* -------------------------------------------------------------- touch/mouse */

function onShakeDown(e) {
  // a right-click or a stylus barrel press is not a hold
  if (typeof e.button === 'number' && e.button > 0) return;
  if (e.pointerId != null) shake.pointers.add(e.pointerId);
  // a finger came back: the gesture is no longer orphaned
  shake.orphanAt = 0;
  // Capture, so a finger that slides off the pen onto the card or the action
  // bar still belongs to this gesture. Not fatal if the browser refuses.
  try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  e.preventDefault();
  if (!shake.active) beginShake('touch');
}

function onPointerRelease(e) {
  if (e?.pointerId != null) shake.pointers.delete(e.pointerId);
  if (!shake.active || shake.source !== 'touch') return;
  if (shake.pointers.size) return;   // another finger is still holding
  endShake(true);
}

/**
 * `pointercancel` — the platform taking the pointer away, NOT the player letting
 * go. See the block comment at the top of this section: treating these as
 * releases is the whole mobile bug. Keep shaking; `pumpShake` resolves it.
 */
function onPointerCancel(e) {
  if (e?.pointerId != null) shake.pointers.delete(e.pointerId);
  if (!shake.active || shake.source !== 'touch') return;
  if (shake.pointers.size) return;
  if (!shake.orphanAt) {
    shake.orphanAt = performance.now();
    shake.orphans++;
  }
}

for (const target of [dom.penWrap, dom.hogWildBtn]) {
  target.addEventListener('pointerdown', onShakeDown);
  // With capture in place these fire on the TARGET, not on window — but the
  // window listeners below stay, because capture can be refused and a release
  // outside the pen must still throw.
  target.addEventListener('pointerup', onPointerRelease);
  target.addEventListener('pointercancel', onPointerCancel);
  // No long-press menu on either shake target, ever — not just while a shake is
  // running, because the menu is raised by the press that STARTS one. Together
  // with the CSS (`user-select`/`-webkit-touch-callout` on .pen-wrap and
  // .hold-btn) this leaves the platform no gesture here to claim, which is the
  // only way to stop the pointercancel rather than merely survive it.
  target.addEventListener('contextmenu', (e) => e.preventDefault());
}
window.addEventListener('pointerup', onPointerRelease);
window.addEventListener('pointercancel', onPointerCancel);
/* Touch events are the redundant channel. If the pointer stream was cancelled
 * but the underlying touch still reports its end, that is a REAL release and the
 * throw should not wait out the grace period. */
window.addEventListener('touchend', () => {
  if (shake.active && shake.source === 'touch' && shake.orphanAt) endShake(true);
}, { passive: true });
window.addEventListener('touchcancel', () => {
  if (shake.active && shake.source === 'touch' && !shake.orphanAt) {
    shake.orphanAt = performance.now();
    shake.orphans++;
  }
}, { passive: true });
/* A shake nobody can see must not decide a turn. The interval pump means an
 * abandoned gesture WOULD eventually resolve itself through HOLD_CAP_MS — but it
 * would resolve as a throw, and coming back to a spent turn you never saw is
 * worse than coming back to the one you left. Cancel, explicitly. */
window.addEventListener('blur', () => { if (shake.active) cancelShakeInput(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && shake.active) cancelShakeInput();
});

/* =========================================================================
 * Device-motion shake (PRD §7.3 decision D3, SPEC "Shake interaction" 3)
 *
 * Opt-in, because a page that grabs the accelerometer unasked is rude and on
 * iOS is not even allowed. The toggle hides itself where `DeviceMotionEvent`
 * does not exist, and on iOS 13+ it goes through `requestPermission()` from
 * inside the change event — which is a user gesture, which is the only place
 * that call is permitted.
 *
 * The signal: |acceleration| with gravity removed, smoothed into an EMA whose
 * weight is normalised per sample interval so a 30 Hz sensor and a 60 Hz one
 * behave the same. `acceleration` is already gravity-free where the platform
 * provides it; where it does not, `gravity` below is a slow low-pass of the raw
 * vector, subtracted — which is the same thing computed by hand.
 *
 * The gesture: cross `on` and the pigs start rattling immediately at an
 * intensity that tracks how hard you are shaking. Stay above threshold for
 * `sustainMs` and then DROP below `off` and it is a throw. Drop before that and
 * it was a bump, not a shake, so it cancels. `debounceMs` then locks the sensor
 * out, so one enthusiastic shake is one toss and not five.
 * ==================================================================== */

const MOTION = {
  on: 6.0,           // m/s² of gravity-free acceleration that reads as shaking
  off: 3.2,          // …and what a release has to fall below (hysteresis)
  full: 18.0,        // EMA that maps to intensity 1
  alpha: 0.30,       // EMA weight per 60 Hz sample (~55 ms time constant)
  sustainMs: 400,    // SPEC: sustained, THEN a drop, is a throw
  debounceMs: 1500,  // …and one shake is one toss
  staleMs: 350,      // no devicemotion this long = the phone stopped moving
};

const MOTION_KEY = 'hogwild.shakeMotion';

const motion = {
  supported: typeof window !== 'undefined' && typeof window.DeviceMotionEvent === 'function',
  enabled: false,
  listening: false,
  ema: 0,
  aboveMs: 0,
  lastSample: 0,
  lastEvent: 0,
  lastThrow: 0,
  gravity: { x: 0, y: 0, z: 0 },
  throws: 0,
  blocked: 0,      // bursts rejected by the debounce — the test page asserts on it
  events: 0,
};

function motionIntensity() {
  return clamp(motion.ema / MOTION.full, 0, 1);
}

/** |acceleration| in m/s², gravity removed whichever channel the platform gives. */
function motionMagnitude(e) {
  const a = e.acceleration;
  if (a && (a.x != null || a.y != null || a.z != null)) {
    return Math.hypot(a.x || 0, a.y || 0, a.z || 0);
  }
  const g = e.accelerationIncludingGravity;
  if (!g) return 0;
  const k = 0.08;   // slow: it must track gravity, not the shake
  motion.gravity.x += ((g.x || 0) - motion.gravity.x) * k;
  motion.gravity.y += ((g.y || 0) - motion.gravity.y) * k;
  motion.gravity.z += ((g.z || 0) - motion.gravity.z) * k;
  return Math.hypot(
    (g.x || 0) - motion.gravity.x,
    (g.y || 0) - motion.gravity.y,
    (g.z || 0) - motion.gravity.z,
  );
}

function onDeviceMotion(e) {
  const now = performance.now();
  /* A GAP IS NOT A DURATION. `aboveMs` is integrated from these samples, so the
   * first sample after an idle sensor must not be credited with however long the
   * sensor was idle — MEASURED against dev/shake-test.html's "too-short shake"
   * check, where one stale 200 ms dt put `aboveMs` at 249 ms after 66 ms of real
   * shaking and a 220 ms jolt sailed past the 400 ms sustain gate. A gap longer
   * than `staleMs` means the phone was NOT moving, so the stream restarts. */
  if (motion.lastSample && now - motion.lastSample > MOTION.staleMs) {
    motion.lastSample = 0;
    motion.aboveMs = 0;
    motion.ema = 0;
  }
  const dt = motion.lastSample ? clamp(now - motion.lastSample, 1, 60) : 16.7;
  motion.lastSample = now;
  motion.lastEvent = now;
  motion.events++;

  const mag = motionMagnitude(e);
  const a = 1 - Math.pow(1 - MOTION.alpha, dt / 16.7);
  motion.ema += (mag - motion.ema) * a;

  if (motion.ema >= MOTION.on) {
    motion.aboveMs += dt;
  } else if (motion.ema < MOTION.off && !(shake.active && shake.source === 'motion')) {
    // The reset is gated on "no motion shake is running", and that gate is
    // load bearing. Without it the very samples that REPORT the drop wipe the
    // sustain they are supposed to be measured against, so `stepMotionShake`
    // always saw aboveMs = 0 and every shake cancelled instead of throwing.
    // (Caught by dev/shake-test.html's third check, which is why it exists.)
    motion.aboveMs = 0;
  }

  if (!motion.enabled) return;
  // A touch hold outruns the sensor: the player has their thumb on the glass and
  // the phone is moving because of it. Don't fight the gesture that is already
  // running (must-fix 3: "Must coexist with touch-hold").
  if (shake.active) return;
  if (motion.ema < MOTION.on) return;
  if (now - motion.lastThrow < MOTION.debounceMs) { motion.blocked++; return; }
  if (state.turnState !== 'ready') return;
  beginShake('motion');
}

/**
 * The release half of the motion gesture, run from `pumpShake` so it is on the
 * same wall clock as everything else and cannot be missed just because the
 * sensor went quiet.
 */
function stepMotionShake(now) {
  const stale = now - motion.lastEvent > MOTION.staleMs;
  if (!stale && motion.ema >= MOTION.off) return;   // still shaking
  if (motion.aboveMs >= MOTION.sustainMs) endShake(true);
  else endShake(false);
}

function syncMotionToggle() {
  if (!dom.motionRow || !dom.motionToggle) return;
  dom.motionRow.hidden = !motion.supported;
  dom.motionToggle.checked = motion.enabled;
}

function saveMotionPref(on) {
  try { localStorage.setItem(MOTION_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
function loadMotionPref() {
  try { return localStorage.getItem(MOTION_KEY) === '1'; } catch { return false; }
}

/**
 * @param {boolean} on
 * @param {boolean} [ask] true when a user gesture is driving this, which is the
 *   only time iOS will honour requestPermission()
 * @returns {Promise<boolean>} whether motion shaking is on afterwards
 */
async function setMotionEnabled(on, ask = false) {
  if (!motion.supported) return false;
  if (on) {
    const req = window.DeviceMotionEvent.requestPermission;
    if (typeof req === 'function') {
      if (!ask) { syncMotionToggle(); return false; }   // never prompt on boot
      let granted = false;
      try {
        granted = (await req.call(window.DeviceMotionEvent)) === 'granted';
      } catch (err) {
        console.warn('[hog-wild] motion permission request failed', err);
      }
      if (!granted) {
        motion.enabled = false;
        saveMotionPref(false);
        syncMotionToggle();
        return false;
      }
    }
    motion.enabled = true;
    if (!motion.listening) {
      window.addEventListener('devicemotion', onDeviceMotion);
      motion.listening = true;
    }
  } else {
    motion.enabled = false;
    if (motion.listening) {
      window.removeEventListener('devicemotion', onDeviceMotion);
      motion.listening = false;
    }
    motion.ema = 0;
    motion.aboveMs = 0;
    if (shake.active && shake.source === 'motion') cancelShakeInput();
  }
  saveMotionPref(motion.enabled);
  syncMotionToggle();
  return motion.enabled;
}

if (dom.motionToggle) {
  dom.motionToggle.addEventListener('change', (e) => {
    setMotionEnabled(e.currentTarget.checked, true);
  });
}
syncMotionToggle();
// A stored opt-in re-arms itself on load — except on iOS, where the permission
// call needs a gesture, so the toggle simply comes back unchecked there.
if (motion.supported && loadMotionPref()) setMotionEnabled(true, false);

/* PRD §8.3 — SKIP. A tap during the tumble jumps to the end of it; a tap during
 * the camera reveal jumps to the end state of that. Neither touches the result:
 * the outcome was drawn before the throw, the recording still lands on its real
 * final frame, and an Oinker still pops.
 *
 * The listener is on the window, not the pen, because the reveal covers the
 * whole screen's attention — but taps on the chrome (mute, rules, scoreboard,
 * the panels themselves) are their own intent and must not double as a skip. */
function requestSkipAll() {
  if (state.turnState === 'tossing') {
    adapter.requestSkip();
    return true;
  }
  if (adapter.reveal) {
    fireOinkerStingNow();
    return adapter.skipReveal();
  }
  return false;
}

window.addEventListener('pointerdown', (e) => {
  if (state.screen !== 'game') return;
  const t = e.target;
  if (t instanceof Element && t.closest('.slide-panel, .icon-btn, .action-bar')) return;
  requestSkipAll();
});

let spaceHeld = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault(); // must not scroll the page
    if (!spaceHeld) {
      spaceHeld = true;
      // Space is the desktop tap: mid-toss or mid-reveal it skips (PRD §8.3),
      // and only otherwise does it start a hold
      if (!requestSkipAll()) beginShake('key');
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
    // only OUR key hold ends here: a Space release must not stop a phone shake
    if (shake.source === 'key') endShake(true);
  }
});

dom.stopBtn.addEventListener('click', () => bankPoints());

dom.quickTossBtn.addEventListener('click', () => {
  if (state.turnState !== 'ready') return;
  cancelShakeInput();
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
  // drawn glyphs, not emoji (SPEC "art direction")
  dom.muteBtn.replaceChildren(icon(muted ? 'muted' : 'sound', 20));
  dom.muteBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
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
  clearTimeout(oinkerStingTimer);
  oinkerStingTimer = null;
  stopShakeLoop();
  adapter.finishReveal?.();
  clearBlink();
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
      // a drawn medal, tinted per place (SPEC "Iconography"): no emoji font, so the
      // podium looks the same on every platform
      if (i < 3) {
        marker.classList.add(`p${i + 1}`);
        marker.append(icon('medal', 19));
      }
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
  clearTimeout(oinkerStingTimer);
  oinkerStingTimer = null;
  stopShakeLoop();
  adapter.finishReveal?.();
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
 * actually is. Kept live so a resized window says the right thing.
 *
 * This copy used to float on the FELT, above the result card, as a third text
 * layer over the board (round-1 review, UI/layering). It now lives under the
 * action bar, beside the controls it is describing — where the desktop build was
 * already saying the same thing in its own line. */
const desktopQuery = window.matchMedia('(min-width: 900px)');
function renderInputHint() {
  if (!dom.inputHint) return;
  dom.inputHint.textContent = desktopQuery.matches
    ? 'Hold the button (or Space) to shake · Enter to stop'
    : 'Hold anywhere in the pen to shake, then let go';
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
  renderInputHint();
  syncScoreboardPanel();
});

async function boot() {
  dom.body.classList.toggle('reduced-motion', reducedMotion);
  renderInputHint();
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
  /** Force the NEXT toss's outcome — see takeForcedOutcome(). Dev only. */
  force: (outcome) => { forcedOutcome = outcome; },
  skip: () => requestSkipAll(),
  reveal: { REVEAL, SETTLE, FACE, REVEAL_FX },
  /* The shake pipeline, read-only, for dev/shake-test.html. It asserts on
   * intensity, on the animation state, on the throw and on the debounce, and
   * none of those are inspectable from the outside otherwise. */
  shake: {
    MOTION,
    CUP_SHAKE,
    get state() {
      return {
        active: shake.active,
        source: shake.source,
        ramp: shake.ramp,
        tosses: shake.tosses,
        cancels: shake.cancels,
        orphans: shake.orphans,
        turnState: state.turnState,
        mode: adapter.mode,
        cupTilt: adapter.cupState?.tilt ?? 0,
        pigsVisible: (adapter.pigs || []).every((p) => p.group.visible),
      };
    },
    get motion() {
      return {
        supported: motion.supported,
        enabled: motion.enabled,
        listening: motion.listening,
        ema: motion.ema,
        intensity: motionIntensity(),
        aboveMs: motion.aboveMs,
        events: motion.events,
        throws: motion.throws,
        blocked: motion.blocked,
        debounceLeftMs: Math.max(
          0, MOTION.debounceMs - (performance.now() - motion.lastThrow),
        ),
      };
    },
    enableMotion: (on) => setMotionEnabled(on, true),
  },
};
