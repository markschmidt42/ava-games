# Hog Wild 3D — Build Spec (module contracts)

Companion to [PRD.md](PRD.md). PRD says *what*; this says *how the modules fit*.
Every agent working on this game follows these contracts exactly. If a contract
must change, change this file in the same commit.

## Files & ownership

| File | Purpose |
| --- | --- |
| `index.html` | Markup, all CSS, screen containers, importmap, boot script |
| `game.js` | State machine, turn logic, players, persistence, wake lock, UI wiring |
| `odds.js` | Probability model + scoring. **Zero dependencies.** Shared by game, Quick Toss, harness |
| `physics.js` | cannon-es world, pig compound collider, headless sim, trajectory recording/search/cache, pose classification |
| `pig.js` | Three.js pig mesh + materials + scene helpers (board, lights, camera) |
| `replay.js` | Recording playback math: interpolates a 120 Hz Recording to any display refresh. **Zero dependencies.** Shared by game.js and the replay test |
| `fx.js` | Reveal sequence, particles, audio (WebAudio), haptics |
| `vendor/` | Pinned three.module.js, three.core.js, cannon-es.js — never edit |
| `dev/` | Test/dev pages: collider-lab.html, pig-viewer.html, odds-harness.html, *-test.mjs node scripts, grounding.mjs (+ three-hook/three-loader, which map the bare `three` specifier for node) |

Import style: ES modules, importmap in index.html maps `"three"` →
`./vendor/three.module.js` and `"cannon-es"` → `./vendor/cannon-es.js`.
Node dev scripts import `../vendor/cannon-es.js` directly.

## Shared vocabulary

Pose keys (exact strings, match the odds table in PRD §5.1):

```
'side-blank'  0 pts   P=.349
'side-dot'    0 pts   P=.302
'razorback'   5 pts   P=.224
'trotter'     5 pts   P=.088
'snouter'    10 pts   P=.030
'jowler'     15 pts   P=.007
```

Doubles: razorback 20, trotter 20, snouter 40, jowler 60, matching sides = Sider 1pt.
Opposite sides = Pig Out (turn → 0). Oinker P=.0038 (score → 0), drawn independently.

## odds.js — exports

```js
export const POSES;                      // { key: {points, p, label} }
export const OINKER_CHANCE;              // 0.0038
export function drawToss(rng=Math.random);
// → { oinker:true } | { a:poseKey, b:poseKey }
export function scoreToss(a, b);
// → { type:'sider'|'pigout'|'double'|'mixed', points, headline, detail }
//   (port headline/detail copy from the 2D game, git show 7be8349:hog-wild/index.html)
export function verifyDistribution(n, rng); // harness helper → tally object
```

## physics.js — exports

```js
export const POSE_UP;   // poseKey → local axis facing world-up when settled
export class PigSim {
  constructor()                          // builds world + 2 pig bodies on the BOARD
  simulateOne(poseless_initial_conditions) // headless, fixed dt=1/120, → Recording
  classify(quaternion)                   // → { pose:poseKey, confidence:0..1 }
  findRecording(targetPose, {maxSims})   // per-pig search → SingleRecording|null
  findOinker({maxSims})                  // joint search, ends in contact → PairRecording|null
}
export class TrajectoryCache {
  prefill(budgetMs)   // call during idle/shake; fills per-pose pools (≥2 each)
  take(targetPose)    // → SingleRecording (pops from pool, triggers refill)
  takeOinker()
}
export const BOARD = { greenR: 2.7, roughR: 3.9, stopR: 4.6, ... }; // see below
export function withinBoard(p);          // COM position still on the board?
export function withinHalf(p, side);     // ...and in its own semicircle?
export function boardZone(p);            // 'green' | 'rough' | 'fringe' | 'off'
```

**Recording format** (the only thing crossing physics→render):

```js
{ dt: 1/120, frames: [ { p:[x,y,z], q:[x,y,z,w] }, ... ], settledPose: poseKey }
// PairRecording: frames have p1,q1,p2,q2; used for Oinker only.
```

Two independent single recordings are replayed together for normal tosses —
pig A confined to the left semicircle of the board, pig B the right, so replayed
paths can't intersect. `findRecording` rejects candidates leaving their half.
Mirror augmentation allowed (the board is a disc): a recording may be reflected
across x = 0 to double pool variety.

**Coordinates:** Y up, floor plane y=0, board centered on origin, camera looks
down the −Z. Pitch is chosen by aspect in game.js (`adapter.applyFraming`):
**52° on desktop, 64° in portrait** — at 52° the play volume projects nearly
square, which on a phone leaves the top ~40% of the canvas as empty felt.

**Framing volume:** the camera frames the *reachable* volume, not the whole
board. RE-MEASURED on the zoned board over 144 recordings (six poses × both
lanes): no COM travels past |x| = 3.29, y = 1.89, or z outside −2.28…2.68, and
rests reach |x| = 3.27. (The walled pen was narrower in x — 2.45 — because the
walls bounced the pigs back; with no walls a hard throw slides further out.) The
focus box is therefore `x ±3.42, y −0.05…1.70, z −2.50…4.95`: wide enough in x
that a rest can never be cropped, deliberately short in y so the top of the
release arc clips rather than pushing the camera back every toss, and deep enough
in z to contain the cup at rest (z 4.35) and hovering (z 2.42) plus the whole
green (r 2.7).

**The overview cannot show a face, and that is arithmetic, not a bug.** A 6.8 m
wide volume in a 351 CSS-px viewport puts the camera 23 m out. No fov and no
pitch changes that — angular size is the ratio of subject to framed width, so the
pig is ~1/7 of the frame's width whatever the lens. MEASURED at the shipped
framing: pig 24 × 39 px, `FACE.eyeR` projecting 4.1 px. So the division of labour
is explicit: **the overview is the table shot, the reveal is the character shot.**
The round-2 review's "the face is delivered at 4.4 CSS pixels" is answered by the
reveal (below: 20–33 px of eye), not by moving the play camera.

What the play camera IS responsible for is not framing a void. MEASURED before
the round-2 fixes: 26.8% of the portrait viewport was black. That was never sky —
the camera's topmost ray lands on the **table** about 9 m behind the board — it
was the cloth rendering at luminance 36 against a page background of 31 because
every felt material set both `color` and a `map` painted in the same tone, i.e.
the albedo squared. See "Table and backdrop".

**Approach B invariants (PRD §6.3):** outcome is drawn from odds.js BEFORE the
search; hold duration/shake NEVER feeds the outcome; search runs during shake
and from the idle prefill cache; on cache miss + search timeout, fall back to
nearest achievable pose and `console.warn` in dev.

**Board design (owner decision — supersedes the walled pen):** NO WALLS. Walls
create lean-against-wall rests that are none of the six named poses, forcing
re-tosses. Instead the board is a putting green of concentric zones. SHIPPED as
`BOARD` in physics.js (the owner's start radii were 2.1 / 3.4 / 4.5; the built
board uses the `_watch/arena.html` prototype's 2.7 / 3.9 / 4.6):

| Zone | Radius | Behavior |
| --- | --- | --- |
| Green | r ≤ 2.7 | Hard and lively — friction .7, restitution .4, exactly the old feel |
| Rough ("frog fur") | 2.7 < r ≤ 3.9 | Deadened: velocity ×.965 per grounded step, upward rebound ×.45 |
| Fringe | 3.9 < r ≤ 4.6 | Motion just dies: ×.85 per step, rebound ×.15 |

Grounded = y below 0.6; zones never grab an airborne pig. A hard invisible
backstop at r = stopR + 0.8 (radial position clamp) guarantees nothing escapes;
it is practically unreachable — a candidate that even reaches stopR is rejected
by the search first. Implementation reference (working code):
`_watch/arena.html` — zone damping applied post-step (`PigSim.zoneDamp`), single
infinite floor plane, no geometry seams. `PEN {w,d,wallH}` is gone, and with it
`withinPen` (now `withinBoard`) and the walled `buildPen` (now `buildBoard`:
three concentric felt discs, tinted progressively darker outward, with a faint
ring on each boundary). The half-lane spawn discipline survives as semicircular
halves.

MEASURED after the change, over 4000 uniform tosses: 92.7% settle on the green,
7.3% on the rough, 0% on the fringe or off the board (SPEC wanted ≥90% on
green+rough; collider-test now asserts it). Removing the walls also cut the
ambiguous-rest rate from 6.1% to 4.6% — more than half of the old ambiguous
rests were pigs propped against a wall.

**Throw realism (owner note):** unconstrained center-aimed throws make the pigs
touch at rest far too often vs. real life (real Oinker ≈ 0.38%). The half-board
lane discipline is the primary control; additionally the initial-condition
sampler should randomize release height, speed, and spread within ranges tuned
so throws look varied and lively but lane-keeping (mild inward drift only).
Higher/faster releases with less sideways drift read as more natural AND
collide less.

**Optional polish (v2, not required):** normal-toss recordings never interact
mid-air (separate lanes), which sacrifices the occasional harmless mid-flight
"clack" of real pigs. If wanted later: for common outcome pairs only
(side/side, side/razorback — cheap joint probability), occasionally run a JOINT
sim and accept if both final poses match the drawn outcome and the pigs are NOT
touching at rest. Gives authentic pig-on-pig contact without touching the odds.

## Presentation model (owner-designed in `_watch/arena.html` — the reference implementation)

The demo arena evolved into the approved presentation design. fx.js / game.js
must reproduce these beats (constants in one editable block each):

1. **Per-pig settle calls.** Each pig is classified the moment IT settles
   (per-pig thresholds ≈ speed<0.08, spin<0.18 rad/s held ~0.1s; engine sleep
   assist) — label chip + scorecard row appear immediately, before the second
   pig stops. A settled pig that gets bumped (>3.5cm, >4°, or speed again)
   flips to "resettling…" and the round waits. Round finalizes when both hold.
2. **Round classification names:** matching siders → "Sider" (1pt, never
   "Double Sider"); sider + scorer → named by the scorer ("Trotter");
   two different scorers → "Trotter + Razorback Combo"; matching scorers →
   "Double Trotter Bonus"; "Pig Out"; "Oinker!". scoreToss headlines in
   odds.js should adopt this vocabulary.
3. **Camera reveal:** on round call, ease in ~1.3s to frame both pigs (camera on
   the perpendicular of the pig-pig line, looking at their midpoint, shortest-side
   choice) → hold ~3.0s with slow orbit drift (~0.1 rad/s) → ease out ~0.9s →
   next action. Exponential glide, so any interruption (player input) pulls out
   smoothly. Chips re-project every frame.

   **Distance is MEASURED, not modelled** (`REVEAL` in game.js). Two earlier
   attempts both failed the same way and the reason is worth keeping: a closed-form
   estimate in metres (first `sep × 1.5 + 2.1`, then half-separation over a tangent)
   cannot know whether its answer fits, so when the answer exceeded `maxDist` it
   silently clamped — and a clamp is a crop. MEASURED in the round-2 build: pigs at
   x ±2.79 asked for 6.71 m, were clamped to 6.4, and the outer pig's far edge sat
   at ndc x 1.07, sliced by the canvas.

   The solve is now a **fit test wrapped in a search**:

   - `fitPose()` puts a scratch PerspectiveCamera at a candidate position, aims it
     at the subject's midpoint, projects each pig as a **bounding sphere**
     (`REVEAL.pigR`, ndc radius = world radius / (view depth × the frame's
     half-extent)) and checks containment. Two pigs are at different depths once
     the camera swings, which is exactly what one "half separation" number can
     never describe.
   - the **composition band** replaces the old half-frame bias fudge. `frameBand()`
     measures the LIVE result card and returns the ndc window above it; `fitPose`
     centres the subject in that window and then RE-PROJECTS through the rotated
     camera before passing, because `aimDown` is a rotation and not an ndc
     translation. The lift is therefore inside the fit, which is what finally makes
     "it can never crop what it is revealing" true.
   - distance is binary-searched (fit is monotone in distance) for each of 13
     swings × 4 axis sign families, and the winner is scored on `front` — the
     camera's alignment with the hero pig's snout — minus `dist/maxDist ×
     frontWeight`. **A reveal that cannot see a face is a failed reveal:** the first
     build of the exact-fit solve produced a beautifully framed 4.7 m two-pig shot
     of two RUMPS.
   - `swingMax` is 88°, not 52°. Near 90° the camera looks down the pig-pig line and
     the separation costs the frame's width nothing.
   - **Hero fallback.** If no pair shot fits inside `maxDist` — or inside
     `heroFrac × overviewDist`, the invariant that stops the reveal being a wider
     shot than the overview — the camera frames the pig that earned the round
     ALONE. A real close-up of one pig beats a cropped wide of two; the other pig's
     chip hides itself under the beat-6 rule below.

   **ROUND-3: the fit was innocent and the TRANSPORT was broken.** The review
   measured "across ALL 5 sampled reveal frames neither pig was inside NDC ±1 …
   REVEAL.maxDist is 9.6 yet the camera sits at 12.4–12.5 m", and reproduced it on a
   second outcome. Instrumented live, the rig for that round SOLVED to 5.37 m, well
   inside its ceiling — the camera simply never got there. Three separate faults, all
   of them about time and path rather than about the solve:

   - the **phase clock** was `r.t += dt` where `dt` is the frame delta the render
     loop clamps to 0.1 s. On a renderer painting at 1 Hz — which is what a hidden or
     automated browser tab does; MEASURED here, `setTimeout` throttles to ~1000 ms
     and rAF stops entirely — a 1.3 s zoom-in needs 13 REAL seconds, while
     `_revealGuard` (wall clock, `total + 1200 ms`) cuts the reveal off at 6.4 s. The
     beat was being truncated less than halfway in. Phases now run on the WALL CLOCK,
     so the two can no longer disagree, and `zoomInMs` after the call the camera is on
     the rig whether that took 78 frames or one. Same fix for the camera punch and for
     every particle/blink/pop in fx.js (`stepVisualFx` ages effects by `now − born`),
     which is also why the felt no longer has an Oinker's smoke still sitting on it
     three beats later.
   - the **motion** was an exponential glide, `k = 1 − exp(−rate·dt)`, a fixed
     fraction of the REMAINING distance per frame. That has no arrival, only an
     asymptote, so with few frames it lands anywhere. Each phase now captures the pose
     it starts from and interpolates absolutely on `ease(t / duration)`: at `t =
     duration` the factor is exactly 1. It stays interruptible because `out` captures
     wherever the camera actually is.
   - the **path**. Interpolating position linearly and rotation by slerp puts the
     subject outside the frame in the MIDDLE of the move even when both ends are
     perfect (MEASURED at u = 0.83 on a 3.33 m spread: hero pig at ndc y −1.16…−0.06,
     partner at 0.62…1.13). A chord cuts inside the arc, so the pair's angular spread
     overshoots the destination's partway through. `arcTo` interpolates the LOOK POINT,
     the horizontal distance to it, the bearing around it and the height, so the
     camera orbits in instead of cutting across: the distance is monotone between the
     two shots and the fit is monotone in distance, so if the destination fits, every
     frame on the way in fits.

   **What the subject IS.** `REVEAL.pigR` was a guessed 0.58. The mesh's farthest
   vertex is 0.544 from the origin, so it did contain the pig — but a review measures
   the projected 8-corner AABB, whose far corner is 0.723 out, and empty box corner
   outside the frame is indistinguishable from a cropped pig in a measurement. The fit
   now tests each pig's eight ROTATED AABB CORNERS (`pigCorners`), padded by
   `REVEAL.pointPad`. That is both the strict test and the TIGHTER one: a single
   sphere big enough to contain those corners wastes 33% of the frame.

   **And scale is now a constraint, not a hope.** Round 3's second must-fix is that
   the reveal "never becomes the character shot the SPEC assigns it". Scoring `front`
   against a distance penalty could not deliver it, because the perpendicular shot
   both sees the snout best and is the most expensive shot there is (the whole
   separation crosses the frame's width), so it won every time — 111 px of pig, 13 px
   of eye. `solveRig` now filters candidates FIRST by this file's own promise (20 px
   of eye, expressed as the depth at which `FACE.eyeR` still projects `REVEAL
   .minEyePx` on the live canvas — canvas-aware arithmetic, not a tuned metre count)
   and only then picks the most frontal among them; the distance term is measured
   against the closest candidate in the pool rather than against the ceiling, so
   "twice as far away" costs something.

   MEASURED after all of the above, desktop 1280×860 (canvas 654×551), a 4.21 m
   spread — WIDER than the round-3 review's 3.89 m case: rig 5.97 m, swing 73°, hero
   pig 288 × 229 px with 21.4 px of eye, partner 108 × 141 px. Every one of the 8
   corners of BOTH pigs stayed inside |ndc| ≤ 0.86 for every frame of the whole beat,
   zoom-in included. On a 3.33 m spread: 5.20 m, hero pig 172 × 304 px, eye 25 px,
   worst |ndc| 0.87. Against 4.1 px of eye at the overview.

   Earlier measurement, kept for the record (portrait 375×812, canvas 351×546, a
   2.8 m spread): 5.66 m, near pig 170 × 186 px, eye 20.2 px.

   **Timing of the reward.** `celebrateScore` is handed to `startReveal` and fires
   on the frame the camera ARRIVES, not when the result is computed. Firing it early
   spawned the burst while the camera was still 23 m out, and two thirds of its
   1.15 s life was over before the 1.3 s zoom-in finished. A skip tap fires it too,
   for the same reason the Oinker still pops on a skip.
4. **Failure feedback:** Pig Out → both pigs blink red (~180ms cadence, ~2.4s).
   Oinker → blink red until ~1.2s after the camera settles, then the pigs
   squash-pop away and burst — gone until the next toss brings them back.

   **A particle burst is not a particle system.** ROUND-2 REVIEW: "90 particles per
   pig at size 0.15 (≈3.6 CSS px) … already spanning 3.6 m per pig by t=0.35 s, with
   no core flash, no sprite falloff, no smoke, no glow, no ring. The event that
   zeroes a player's entire score is visually indistinguishable from a rendering
   artifact." The shape of the effect, not just its constants:

   - FEWER, MUCH BIGGER sparks (54/pig at 0.34 m) with a hot-core falloff sprite.
     A 3-px speck is noise however many of them there are.
   - `burstDrag` bounds the cloud. Speed × life with nothing bleeding it is what put
     particles at x −4.33…4.85, wider than the board.
   - `REVEAL_FX.groundY` — **the felt is solid.** MEASURED before: particles reached
     y −1.03, a metre under the table. They land, skip once, and die on the cloth.
   - a core **FLASH** (additive sprite, ~0.3 s), an expanding shock **RING** on the
     felt, and a non-additive **SMOKE** puff that outlives the sparks. Additive
     sparks can only ever add light, so the instant they fade the felt looks
     untouched; the smoke is what says something was destroyed here.
   - `ringOpacity` is 0.40, not 0.9: the reveal camera is LOW, so a bright flat ring
     is seen almost edge-on and reads as a horizontal light bar.
   - gains are tuned against the SATURATED sum, not the palette. 0.5 was invisible,
     0.82 clipped overlapping sprites back to white; the burst runs at 0.55.

   **ROUND-3: "giant pale-green soap bubbles", and round 2 had made it worse.** The
   review measured the smoke from the live scene: "a Points with color #bfd0c6 (pale
   grey-GREEN), size: 1 (one full board-metre per sprite), NormalBlending, opacity
   0.9, and only 14 particles … 4-6 overlapping translucent discs with VISIBLE HARD
   CIRCULAR RIMS covering most of the board … A pale green puff over green felt cannot
   say 'something was destroyed here' — it says lens smudge." Five separate mistakes,
   and every one of them is a rule worth keeping:

   - a sprite one board-metre across, growing ×3.4, is THREE PIG-LENGTHS of dust per
     particle. `smokeSize` 0.34, `smokeGrow` 1.4.
   - big-and-few is what makes a rim resolvable at all. 30 sprites, not 14.
   - `smokeOpacity` 0.34, not 0.9: a non-additive sprite at 0.9 is a paint layer.
   - the puff sprite's own alpha was still 0.32 at r = 0.45 and only reached 0 at
     r = 1.0 — nearly constant across most of its area, i.e. a disc with an edge. The
     falloff is front-loaded now: small bright core, long thin tail.
   - `smokeColor` #cdbfae. #bfd0c6 is the felt's own hue lightened, which is the
     definition of a smudge; warm neutral dust is the one hue the board does not
     contain.
   - and the FLASH counted as a bubble too ("gold flash sprites at scale 2.21 and
     1.47"). A flash is the hottest, smallest thing in the frame; a 2.2 m additive disc
     on a 5.4 m-wide shot is a wash. `flashR1` 1.15 and `cheerFlashR1` 0.72, i.e.
     about one pig-length at the top tier.

   **And an effect's LIFETIME is wall clock, not summed frame deltas.** The other half
   of the bubble report — "on the Oinker the entire board is bubbles with a pig sitting
   untouched in the middle" — was a pig that had already come back for the NEXT toss.
   The blink always ran on the wall clock; everything else aged on the caller's `dt`,
   which the game clamps to 0.1 s so one slow frame cannot teleport a pig. On a
   renderer painting at 1 Hz that clamp turns a 1.15 s puff into twelve real seconds,
   and every screenshot in between catches it near t = 0 at full size. `stepVisualFx`
   now ages every burst, decal and pop by `now − born` and integrates positions with a
   clamped step, so a starved renderer sees FEWER frames of an effect rather than a
   slow-motion one that never ends.
5. **Reward feedback, and it must match beat 4 for loudness.** The first juice
   review found the game "punishes with spectacle and rewards with silence": a
   Double Trotter was gold text on a dark slab with two motionless pigs, while a
   Pig Out got a blink, a squash-pop and a particle burst. Every scoring round now
   fires `fx.cheer()` (a gold fountain, particle count and speed scaled by the
   round's points), `fx.popPigs()` (a damped squash-and-stretch), and
   `adapter.cameraPunch()` — and only on the pigs that actually scored, so a
   Trotter beside a Sider celebrates on one pig and a Combo on both. `fx.celebrate`
   remains audio-only; the visuals live in game.js because it owns the positions
   and the camera.

   **"Must match beat 4" is a checkable claim, and round 1 failed it.** ROUND-2
   REVIEW: "3 Points systems, 65 particles each, size 0.13 with sizeAttenuation
   (≈3.6 CSS px), and the per-vertex colours are #836e26, #734727, #a06337, #796523
   — khaki and brown, not gold. Spread x −4.33…4.85 and z −3.27…5.12, wider than the
   entire board, and y down to −1.03 so particles fall through the table. It reads as
   sensor noise, not reward." Three separate faults: the KHAKI was `cheerGain: 0.62`
   multiplying a pale palette down before the additive blend (0.62 × gold is olive);
   the SPECKS were `cheerSize` at a third of what a spark needs; the board-wide
   SPREAD was speed × life with no drag. Fixed by a saturated palette at gain 0.95,
   size 0.30, `cheerDrag`, harder gravity, the shared ground clamp — and the same
   flash and ring the failure beat gets, both scaled by the tier, because parity of
   loudness means parity of MECHANISM. MEASURED after: colours #ffae17 / #fff33d /
   #ffe11e / #ffbb19, y never below 0.03, each cloud ≈ 1 m across.
6. **One text layer at a time over the felt.** Only the projected per-pig chips
   (which carry a leader pointing at their pig, and hide rather than clamp when
   the PIG leaves frame) and the lower-third result card. The old top-of-canvas
   pose-label row is a screen-reader live region now — it duplicated the chips
   verbatim — and the hold-to-shake hint moved under the action bar, beside the
   control it describes.

   **A chip's own box is clamped to the container, always.** "Hide when the pig
   leaves frame" and "keep the label inside the canvas" are different questions and
   both have to be answered. The round-2 review measured a chip spanning page
   x 703–821 against a canvas edge of 810 — 11 px of live text sliced — with the
   pig fully in frame, so the hide rule never fired. The clamp had been using a
   CONSTANT (`CHIP_EDGE × 2` = 48 px) as a stand-in for the chip's half width;
   "Trotter 5 pts" is 95 px and just fit, "Razorback 5 pts" is 117 px and did not.
   `projectChips` now clamps against the chip's measured `offsetWidth/Height`, and
   when the clamp moves a chip the CSS leader slides with it (`--lead`, and
   `.below` flips the notch for a chip that had to drop onto its pig) so it never
   lies about where the pig is.

   **ROUND-3, three more ways a chip can name nothing, and all three are now
   answered by measurement rather than by a constant:**

   - "the Trotter chip rendered … fully inside the canvas — while its pig's entire
     8-corner bounding box was at ndc x >= 1.060. So the 'hide rather than clamp when
     the PIG leaves frame' rule never fires; the game labels empty felt." The hide test
     allowed the pig's COM to be `CHIP_EDGE` = 24 px OUTSIDE the canvas — and a COM
     24 px out means the whole pig is out. Visibility is decided against the pig's
     PROJECTED SIZE now: at least half of its bounding disc has to be on canvas (with
     the disc capped, so a hero close-up cannot hide its own chip).
   - "the 'Snouter 10 pts' chip is clamped directly ON TOP OF the result card,
     overlapping the headline … two text layers over the felt, which beat 6 explicitly
     forbids." The clamp knew about the canvas and not about the card. A chip is now
     pushed clear above the card's measured top edge, and a pig that is itself behind
     the card loses its chip — a leader pointing into an opaque panel is the same lie
     as one pointing off-canvas.
   - "both chips render stacked 25 px apart at ~40% opacity ('Side · dot 0 pts'
     twice), illegible — and pose chips are meaningless on an Oinker anyway." Both
     true. Two chips are de-collided against each other, and `startReveal` hides them
     outright on an Oinker: an Oinker is not a pose result, its two labels are
     cosmetic, and the pigs are a touching heap so the chips are always on top of each
     other. That also means beat 6 holds through the whole Oinker beat — one text
     layer over the felt.
   - the leader itself existed but was invisible: a 6 px triangle in the chip's own
     near-black fill against dark felt. It is 9 px, drawn in the chip's BORDER colour,
     and carries a hairline stem down to the pig across the gap the chip's negative
     margin leaves.

7. **The cup, and the anticipation.** The hold gesture has a diegetic object:
   `buildCup()` in pig.js, driven from game.js. Idle — on the felt at `CUP_REST`
   (z 4.35, on the fringe, clear of every rest at z ≤ 2.68). Hold — it lifts to
   `CUP_HOLD` and rattles at the pigs' own amplitude while they are scooped INTO it
   and hidden past `CUP_SWALLOW` (the mouth is 1.24 m and a pig is 1.0 m long, so
   two pigs cannot both sit at the rim without interpenetrating — and you cannot see
   dice inside a shaker either). Release — it TIPS `CUP_TIP_RAD` toward the board
   over `CUP_TIP_MS` while the pigs fly out, then walks back down over
   `CUP_HOME_MS`. Cancel — back down with no tip, because nothing was thrown. The
   cup obeys the same `SHADOW.liftOff` rule as the pigs: no hard map shadow once it
   is off the felt, only the contact patch.

## Character & expressions (owner direction for the juice phase)

The pigs must be characters, not props. Requirements for pig.js + fx.js:

**Faces.** Give the pigs proper eyes (they currently have a sleepy painted eye —
upgrade to eyes that can change state) and an expression system with a small
set of states, swapped by texture/UV offset or morphing eyelid geometry —
whichever stays cheap on a Pixel.

**Face layout (owner art direction, 2026-08-11, from an annotated screenshot —
supersedes conflicting placement notes):**
- **Eyes sit HIGH on the head** — upper half of the head mass, forward of the
  ear, roughly level with the snout's TOP edge. NOT low by the jaw where the
  2026-08-11 build has them. Classic cartoon pig: eye up near the brow line.
- **The snout must get SMALLER.** The current disc dominates the face and
  crowds out eyes and mouth; shrink its diameter noticeably so the face reads
  eyes-first, snout-second. The only physics coupling: the visual snout's
  LOWER rim must still reach the collider's snouter/jowler contact plane —
  shrink upward (keep the bottom edge, pull the top profile down), and
  re-verify grounding in pig-viewer poses 5 and 6 (flush on felt, no hover).
- The freed-up face area is where the mouth and blush live — the fix for
  "mouth renders below the visible face" is this layout change, not a nudge.

**Scale is the requirement, not a detail.** The first juice review's verdict was
that the pigs had "no readable face at any scale the game ever shows": the whole
face was one dark almond ~10 px wide, the ear paddle sat on top of it, and seven
of the eight states were indistinguishable. `FACE.eyeR` in pig.js is therefore
0.052 board-metres — a sixth of the pig's length, Nintendo-scale — with a dark
iris, a large catchlight, a near-opaque brow and lid, a mouth line and a cheek
blush, all drawn in ONE anchor frame so the carved atlas window can be sized from
a single known ink bounding box. The eye also moved forward onto the cheek and the
visual ear sweeps rearward at the tip.

**The lens is FOUR separable values, or it is a hole.** ROUND-2 REVIEW: "the eye is
an amorphous black void with two catchlights … a large white catchlight at
bottom-left AND a grey one at top-right — two bright dots in one eye read as two
pupils / wall-eyed. There is no iris ring, no lid line, no lash, and the outline is
soft-edged so it merges into a dark smear at the lower-rear." `eyeLens()` draws a
crisp `INK.rim` outline, a dark-but-not-black `INK.iris`, a true-black `INK.pupil`
with an `INK.irisRing` limbal edge, and **exactly one** catchlight. Two highlights
in one eye is a bug, not richness. `eyeSocket`'s lower contact shadow also came down
from 0.30 to 0.16 alpha: at 0.30 it blurred into the lens's own lower-rear edge,
which was the other half of "a dark smear".

**The ear must not cross the eye, and the EYE is what moves.** ROUND-2 REVIEW: the
ear's placement is load-bearing for the 37° jowler roll, so it is off limits — but
the ear's *silhouette* is not. MEASURED in the COM frame: the paddle's widest station
sat at y −0.005 spanning z 0.185…0.313 against a lens starting at z 0.266, i.e. the
ear covered the eye's rear 47%. Three moves close it, and each one's budget is set
by hard geometry: `eyeZ` 0.318 → 0.328 (it cannot go much further — the forward ink
reach is `inkReach × eyeR` = 73 mm and past z ≈ 0.395 the body rings are the nose
tip, where a carved window pinches to nothing), `eyeU` 0.202 → 0.183 (down onto the
cheek, which is also where the reference photos put the painted dot), and
`earSamples()` CLAMPS the paddle's leading edge to `EAR_LEAD` with `EAR_CHORD`
narrowing it enough that the clamp does not push the trailing edge onto the neck.
Visual only: the tip's x and y are untouched, so the roll collider-test asserts
cannot move.

Every state must change the eye's OUTLINE, not just a couple of alphas:
- `neutral` (default), `squint` (while tumbling fast — airborne + high spin),
- `ouch` (hard impact — big contact impulse; briefly held),
- `dazed` (long wobble before settling; maybe spiral or blinking),
- `smug`/`smirk` (settled in a scoring pose; bigger smug for snouter/jowler),
- `wink` (its own double or a Leaning Jowler call),
- `sad` (Pig Out), `panic` (Oinker, just before the reveal).

**Physics-driven reactions.** Recordings carry contact events, recorded during
the sim. Format (extends the Recording, additive — replay.js ignores it):

```js
{ dt, frames: [...], settledPose,
  events: [ { t, impulse, region } ] }
// region: 'snout' | 'head' | 'back' | 'rump' | 'belly' | 'legs' | 'side'
// derived from the deepest contact point expressed in the body frame.
// impulse: normal impulse magnitude, so consumers can scale reactions.
// Only events with impulse above a noise floor are recorded (~0.5), and events
// within 50ms merge keeping the max impulse.
```

Face-first hits vs rump-first hits vs belly-flops get different expressions
and different sounds. fx.js maps events → expression swaps + audio at replay
time using event t against the replay clock.

**Sound direction (extends PRD §11):** oinks/squeals/grunts —
impact-magnitude-scaled: soft "ugh" on small bumps, indignant squeal on hard
face-plants, low "oof" on rump hits, happy oink on a scoring settle, sad
descending oink on Pig Out, panicked squeal cut short by the pop on Oinker.
WebAudio-synthesized or tiny embedded samples; no external fetches.

**Leg/hoof color (owner):** the current hoof color (#ad3a63) reads BROWN under
scene lighting. Hooves and leg shading must stay in the pink/magenta family —
brighter, closer to the reference photos' pink trotters (photo hooves are a
vivid pink #d94f8a-ish). No browns anywhere on the pig.

This is about RENDERED pixels, not palette hexes. The compliant-looking #e05a97 /
#c93f83 pair still measured #ad757a / #c2576c / #37181a on screen — dusty mauve —
because a 45% mix into `skinShade` on an undercarriage the key light never reaches
bottoms out almost black. Three things together fix it and all three are load
bearing: saturated source hexes (`hoof` #ff62ac, `hoofTip` #f53d97), a much gentler
shading mix in the leg ramp, and real fill under the pig — buildScene's `under`
light plus a far lighter HemisphereLight GROUND colour, which is what lights every
downward-facing surface on the model. VERIFY BY MEASUREMENT: readPixels over the
pig at rest and bucket the hues. Currently 39,846 of 39,855 pig pixels land outside
the brown band (hue 14–48°); the darkest leg pixel is #6a1938 at hue 337°, and the
most saturated is #6f193b at 77% saturation.

## Geometry realism (owner requirement — applies to BOTH collider and visual pig)

The pig's shape must track the real pig in the reference photos
(`../reference-images/pass-the-pigs/`): leg placement, ear placement, head/snout
proportions, and back shape should all be recognizably the same animal.

**Leg asymmetry is mandatory and is the real side-bias mechanism.** On the real
pig the legs sit closer to / angled toward the *blank* flank, so resting on the
blank flank is propped and tippy — which is why "dot up" is the rarer Sider
(30.2% vs 34.9%). SHIPPED as `PIG_TUNING.legLeanX` (0.019: all four legs shifted
toward +X, the blank flank) and `legLeanSplay` (5°: the same extra lean angle on
all four, so the +X pair splays wider and the -X pair tucks under). Both are
applied with the same sign to every leg in `makeParts`, which is the only
deliberate left/right asymmetry in the collider's undercarriage.

MEASURED, 4000 uniform tosses: side-blank 36.9%, side-dot 28.5%, razorback
23.7%, trotter 8.3%, snouter 2.5%, jowler 0.16% (real game: 34.9 / 30.2 / 22.4 /
8.8 / 3.0 / 0.7). **Zero-lean collapse check** (the proof the ears are not the
bias source): set `legLeanX` and `legLeanSplay` to 0 and re-measure — the split
goes to 26.4 / 26.5, a gap of -0.1pp against +7.4pp with the lean on. The ears
are now exact mirrors in position, size and droop; only their sweep differs.

Emergent percentages still don't need to match the table exactly (Approach B),
but mechanism and direction must be real. All six poses must stay stable and
searchable after the change (re-run collider-test + search-test).

**Jowler attitude:** the Leaning Jowler is a *Snouter with a lean*, not a
side-lie — snout planted, rump up, body pitched nose-down like the snouter,
rolled only far enough for the ear tip to touch (roll ≈ 25–40° from upright;
≥55° reads as lying down and is wrong — see the scoring-card photo in the
reference images). Roll is defined as the roll-then-pitch decomposition of the
rest: `asin(|up.x|)` where `up` is world-up in the body frame — yaw-invariant,
so it is a property of the pose. dev/collider-test.mjs prints it for both
nose-down rests and asserts the jowler's is ≤ 45° (and that poseQuaternion
agrees with what the sim settles into, which also catches a stale POSE_UP).

SHIPPED at **37.0°** (was 66.5°), achieved entirely by moving the ear. The
mechanism is geometric and worth writing down, because the intuition in the
first draft of this section had it backwards: the jowler's support plane runs
through the snout rim, the +X front foot and the ear's outer tip, so the roll is
`asin(d / R)` where d is the ear tip's height *above the snouter support plane*
and R its distance from the snout-to-foot pivot line. The old ear (high on the
head, swept back) sat almost directly above the front foot — d/R ≈ .91, i.e. a
side-lie. The fix is to bring the tip DOWN and FORWARD onto the cheek, which
shrinks d while leaving R alone; moving it closer to the head's side plane
would have shrunk R and made the roll worse. The new ear is a wide paddle on the
front of the cheek that flares out and droops 42.7°, which is also what the
reference photos show.

Known deliberate deviation, keep it: the real pig can jowler on either ear; our
collider's second ear is swept ~27° further forward than the first, which lifts
its tip off the mirror-image jowler plane so only one jowler equilibrium exists
— a mirror-jowler would be a seventh pose the classifier can't name. (The leg
lean helps but is NOT sufficient on its own: with perfectly mirrored ears the -X
lean is a real equilibrium with a .04 support margin. Verified by enumerating
the support faces of the pig's *mirror image*, which turns the -X lean into a
jowler face the analysis can see; there is no such face for ear2Sweep anywhere
in [-40°, -25°].) Both ears still exist and look symmetric visually — pig.js
builds both from the +X collider ear — and now they also match in position,
size and droop; only the collider sweep differs.

The visual pig in pig.js must share the collider's silhouette — same leg
positions and lean, same ear placement, same head/snout proportions (read
`PIG_TUNING` from physics.js and derive placements from it where practical, so
the two can't drift apart).

## pig.js — exports

```js
export function buildPig()        // → THREE.Group, ~unit 1 = 1 board-meter,
                                  //   body length ≈ 1.0, origin at collider COM,
                                  //   +Z = snout direction, +Y = up when trotting
                                  //   NO options: there is only one kind of pig
export function buildBoard()      // board group — see "Board design": table +
                                  // three concentric felt discs + boundary
                                  // rings + backdrop/wall-foot/stage-pool,
                                  // NO walls
export function buildCup()        // → THREE.Group, the shaker. Upright, BASE at
                                  //   the group origin (so game.js sets position
                                  //   to a felt point and rotation.x to tip it,
                                  //   about the same pivot a real cup tips on).
                                  //   userData { height, mouthR }.
export function buildScene(canvas)// renderer, scene, camera, lights, resize → handles
```

Pig visual origin/axes MUST match the collider in physics.js — same origin, same
axes, so recording quaternions apply directly to the mesh group.

**The two pigs are identical, and BOTH carry the painted dot** (owner
correction; see reference photos — the dot is what tells a Sider from a Pig
Out). The dot is **black**, a flat flush disc on the pig's **right flank**
(the -X flank: snout is +Z, up is +Y). This is anatomically correct AND matches
the collider: POSE_UP['side-dot'] has -X facing up, so the visible dot faces up
exactly when the classifier says 'side-dot'. Never label the pigs "dot pig" /
"blank pig" in any UI — they are interchangeable, and `buildPig()` takes no
argument so there is nothing to label. The dot is painted into the shared skin
texture through pig.js's `flank(u, z, side, draw)` helper, which maps world
units on a flank into texture space — that is the COM-frame conversion (a disc
placed by eye in UV space ends up floating off the barrel of the body).

The visual ear profile is likewise derived from `PIG_TUNING`: `EAR_KEYS` was
drawn against `EAR_REF` and every sample is rescaled by the collider ear's
current half-extents, so a retuned ear moves the silhouette with it instead of
silently detaching the visual pig from the thing the physics rests on.

Look: charming, stylized, modern mobile-game quality (Monument Valley/Nintendo
bar, NOT photoreal). Reference photos: `../reference-images/pass-the-pigs/`.
Soft pink body #f0a3b5-ish with subtle SSS-feel (physical material, sheen),
blush snout/trotters, tiny tail.

**Glossy vinyl, not matte clay — and the gloss lives in the clearcoat.** ROUND-2
REVIEW: "at maximum magnification with the 2.3-intensity key light there is not one
specular hotspot anywhere on the body." A `clearcoat` of 0.16 blurred to
`clearcoatRoughness` 0.62 cannot make a hotspot: the coat is 16% present and its
lobe is smeared over most of the hemisphere. Real painted vinyl is a diffuse
pigment layer under a thin HARD lacquer, so the body stays soft (roughness ~0.52)
and the coat is nearly full strength with a tight lobe: **0.85 / 0.16**. Plus
microsurface breakup — `microSurface()` builds one tiled noise sheet used as
`clearcoatRoughnessMap` and, differentiated, as a shallow `normalMap` — because an
un-broken hotspot is an airbrushed blob, and the reference photos are full of mould
seams, polish variation and grime.
ACESFilmic tone mapping, soft shadows (one directional + hemisphere + env),
contact shadow under pigs, felt table with subtle procedural texture.

**Silhouette (first juice review, must-fix).** The body read as "a moulded soap bar
with a cylinder glued on the front" and the legs as spider legs. What the fixes turn
on, so they are not undone by accident:

- The superellipse exponent `n` in `BODY_KEYS` was the flat plateau and the crisp
  bevel crease down each side; it is capped at 2.04 now. Softening it is FREE: a
  Side rest's tangency is at theta = 90°, where the ring passes through `rx` exactly
  whatever n is, so the pig cannot lift off its own flank.
- `crest()`'s falloffs were narrow enough to make the razorback ridge a flat-topped
  mesa with a hard shoulder — the other half of the "flat back". Broadened; the
  razorback contact is only ever the crest's apex at u = 0.5, which still reaches
  `yRidgeTop`.
- `BELLY_DROP` deepens the visual barrel below the collider's torso box (the belly
  is a contact surface in NO pose) with the back pinned in place. It rounds the
  barrel AND swallows the top third of every leg, which is what turns four tapered
  tubes into short nubs. Thicker shanks and a blunt bulbous hoof do the rest.
- `legDrop()` is DERIVED (`legHX · tan|splay|`), not a constant. The old single
  0.0072 was right for the two legs leaning 8° and 9 mm short for the two leaning
  18°, so half the hooves hovered in every trotter.

**ROUND-3, and round 2 had been fixing the wrong term.** "The torso is a flat-topped
rounded BOX with a continuous specular crease line running its full length along the
top-side transition, a near-vertical front wall at the shoulder, and a flat rear wall
at the rump. The head is a separate smaller cylinder in front of that wall with a
visible circular seam and no neck taper … capping the superellipse n at 2.04 and
broadening crest() did not remove the plateau or the shoulder. The reference pig is
an egg."

All four clauses were true, and the plateau's cause was `crest()` carrying the whole
54 mm between the barrel's round top and the collider's ridge. A 54 mm step raised
over a fixed angular window IS a plateau with a shoulder, and BROADENING the window
widens the plateau and slides the shoulder onto exactly the top-side transition where
the review measured the crease. Height, not width, was the problem. So:

- the arc moved INTO the profile. `BODY_PROFILE` is written as a BACK line and a
  BELLY line (`bodyKeys()` converts to centre+radius) because every silhouette note
  three reviews running has been about one of those two curves and neither is legible
  as `yc ± ry`. The back is now one convex curve peaking at `yRidgeTop + CREST_BITE −
  CREST_H`, and `crest()` is a 16 mm spine hint on top of it.
- the RUMP taper starts at the hip (z −0.29) instead of holding 96% of full width to
  within 30 mm of the end and then collapsing.
- the NECK is a waist (23 mm) rather than a step (36 mm), and the back descends
  continuously from the crown through it onto the skull, so the head is the front of
  one egg instead of a bolted-on drum.

Grounding is unchanged by the reshape: all six poses still land in −5.4…+0.9 mm, and
the razorback still touches at +0.9 (see `CREST_BITE` — the crown sits a whisker proud
of the collider's ridge for the same reason every other pose does).

**Ambient occlusion, because a 12k-triangle model was still reading as assembled
primitives.** ROUND-3: "Zero ambient occlusion anywhere on the pig — grep confirms no
aoMap in pig.js. Leg/belly junctions, the ear/head crease, under the jaw, between the
front legs: none have any contact darkening, so every part is separately lit and reads
as glued on. This is the single biggest reason a 12,224-triangle model looks like
assembled primitives … Cheap fix relative to its impact: a baked AO map, or vertex AO,
or even a darkened cavity term in the skin texture at the known joint locations."

VERTEX AO, the review's second option, for a concrete reason: an aoMap needs a second
uv channel and a bake, and the parts that read worst (legs, ears, tail) do not sample
the sheet at all — they point at one white texel and carry their colour per vertex. A
cavity term evaluated in the BUILD frame (`ao(p)`, `AO_SITES`) reaches all of them
with one function, costs nothing at runtime, and because `Builder.add` hands the
colour callback the FINAL build-frame position, both sides of every join darken by the
same amount — which is what actually welds them visually. Every site is a junction of
the collider's own parts, derived from `PIG_TUNING`, so a retuned pig keeps its
creases. The ear/head site is deliberately the WEAKEST of them: round 3 also reports
the ear reading as a hole, and a strong cavity term at its root is the fastest way to
make that worse.

**The ear was reading as a hole because of its SHADING, not its shape** (its
placement is load-bearing for the 37° jowler and stays untouched). The old ramp mixed
toward `skinDeep` on the sweep parameter alone, so everything away from the root went
dark — including the whole UNDERSIDE, which is the face the camera sees of the FAR ear
once it clears the head's silhouette. A dark oval with a lit rim inside a head outline
is a socket. The ear is lit like a thin lobe instead: `u` runs around the paddle's
section against `ey = −Y`, so `cos(2πu)` is +1 on the top face and −1 underneath — the
top takes light, the underside deepens mildly, the tip carries the last of the
shading.

**Grounding must be measured, not eyeballed.** "The pigs are never planted" was
literally true: transform every visual vertex by `posePlacement()` and take the
minimum world y. Before, the two Side rests — 65% of all tosses — floated 8.6 mm and
6.4 mm above the felt and the snouter 4.9 mm. All six poses now land in
−5.4…+0.9 mm. Errs toward touching: a hoof pressed a few mm into felt is invisible,
a gap of light under it is not.

**Table and backdrop.** The table plane must NOT be `--bg-1` — that is the page
token behind the canvas, and painting the table in it left the board floating in a
void with no floor and no horizon. `PALETTE.table` is its own visibly lighter tone
with its own tiled texture, and `buildBackdrop()` adds an unlit gradient cylinder
so the felt always meets a wall. The pen also carries a CSS `.pen-vignette` so the
disc fades into the panel edge instead of being sliced by it.

**NEVER set both `color` and a `map` painted in that colour.** This is the rule the
round-1 world fix was missing and it cost a whole review cycle: the hexes were
right, the pixels were not, because the albedo was the tone SQUARED. MEASURED on
the shipped build — `PALETTE.table` at luminance 72 rendering at **36**, five
levels off a page background of 31. Every felt material (table, green, rough,
fringe) now passes `color: 0xffffff` and lets its own canvas sheet carry the tone.
MEASURED after: cloth 100–117, green 124, rough 101, fringe 68, i.e. the zones
finally read progressively darker outward the way "Board design" always claimed,
and the dead-black share of the portrait viewport is **0%**.

**ROUND-3: not one of those four numbers reproduced, and the ordering was reversed
at the board's edge.** RE-MEASURED radially (median over 48 bearings per radius,
desktop overview): green centre 128 falling to **84** at its own rim, ROUGH 84–99,
FRINGE 54–60, and the CLOTH OUTSIDE THE BOARD 113–127 — brighter than everything on
the board except its very middle, so the eye was pulled to the empty table. Three
root causes, and only one of them was a zone tone:

- the GREEN was fading to the rough's tone all by itself. `noiseCanvas`'s
  `vignette` — which the green sheet alone uses, across the whole r = 2.7 disc —
  ended at 0.60 alpha of near-black. No re-tinting of the other zones could have made
  that boundary read. A putting green is evenly lit; the falloff belongs at the
  board's outer edge, not across the target the player aims at. It is a whisper now
  (0.05).
- the FRINGE was a near-black moat at 54. The rough and fringe sheets are re-picked
  against rendered numbers again.
- the CLOTH was too bright, and most of the excess was `stagePool` — a 12.5 m pool
  whose inner two thirds land on cloth rather than on the 4.6 m board, so every point
  of its alpha brightened the surround. Pulled back, plus `PALETTE.table` down a
  step.

**The edge is a ramp now, not a cliff.** Round 3: "MEASURED at the same buffer row on
both sides: left column L130 → L74 across 4px, right column L127 → L81 → L64 across
8px. A 66-level drop in 4 pixels reads as a punched hole in the table … Needs a soft
radial falloff / ambient gradient at the fringe-to-cloth transition, the way
buildWallFoot does for the wall join." `buildBoardFoot()` is that, and it takes TWO
decals because the cliff has two sides and the felt geometry is between them: a
`halo` on the CLOTH under the discs, darkest at the rim and releasing over 1.55 m,
and a `lip` ON TOP of the fringe, transparent until past the rough, shading the
felt's rolled outer edge. `zoneRing` also stopped being a mint hairline doing a
tone's job: with real steps between the zones it is what a stacked felt disc
actually shows — a thin edge shadow just outside the boundary and a thin highlight
just inside.

MEASURED after, desktop overview, median luminance per radius:

| radius | zone | before | after |
| --- | --- | --- | --- |
| 0.5–2.6 | green | 128 → 84 | 126 → 107 |
| 2.9–3.8 | rough | 84–99 | 98–99 |
| 4.0–4.55 | fringe | 54–60 | 67–77 |
| 4.7–6.2 | cloth | 113–127 | 65 → 92 |

…i.e. strictly progressive outward, the board's own centre is the brightest felt in
frame, and the buffer row across the rim reads 67, 70, 60, 59, **57**, 61, 64, 70,
69, 73, 73 — a soft groove where there used to be a 66-level step. Portrait
(351×546) agrees: green 105–124, rough 97–98, fringe 66–73, cloth 69–90, dead-black
share 0.3%.

Three more things the round-2 review caught in this area, all of them about
rendered pixels:

- the backdrop was radius 26 × height 22 — 5.6× the board — so no shot ever
  contained the JOIN between cloth and wall, which is the only part of a backdrop
  that does any work. It is `WALL_R` 13.5 × `WALL_H` 9.5 now, close enough that the
  low reveal camera frames its base and short enough that its top stays out of
  frame. `buildWallFoot()` adds the ambient gradient where the two meet.
- **any radial-gradient decal must be a CircleGeometry, not a PlaneGeometry.** On a
  square plane the gradient's outermost stop covers the square's corners too, so the
  darkening ships with a straight-edged silhouette — a faceted quadrilateral over
  the far felt, which is the "hard geometric cliff" the backdrop was supposed to
  remove. Applies to `buildWallFoot` and `stagePool`.
- the cloth is **not** a shadow receiver. The key's ortho frustum is fitted to
  `BOARD_BOX` (±4.8 m) and outside a shadow camera the depth lookup clamps to the
  border texel, painting a hard-edged shadowed region on the cloth just past the
  felt. Nothing can cast there anyway — the pigs cannot leave the board.
- a tiled cloth texture must have **no corner-to-corner gradient**: with one, every
  tile is a light-to-dark ramp and the repeat shows up as a checkerboard of squares
  across the whole surround. Flat tone, grain and fibres only.

**Shadows: crisp at rest, soft in flight — the two systems were inverted.** At
y = 1.4 the 2048 map shadow was still razor-sharp and fully opaque, offset far
down-left, reading as a detached third pig with splayed leg claws, while the soft
blob that should have carried the height had already faded to its floor. The pig
mesh's `castShadow` is now switched off above `SHADOW.liftOff` (a shadow map cannot
be faded per-object, and at that height it is a lie anyway) and the contact patch
grows and softens to take over. `buildContactShadow`'s gradient is front-loaded —
two thirds of its darkness inside the first 35% of the radius — so at rest it reads
as contact rather than haze.

## replay.js — exports

```js
export function isPair(rec);                 // PairRecording? (Oinker)
export function frameCount(rec);
export function duration(rec);               // seconds
export function sampleAt(rec, t, out, which=0);
//   out = { p:[3], q:[4] } — reused, never allocated per frame.
//   which: 0 single · 1 pair pig A · 2 pair pig B
//   Before t=0 it holds frame 0; past the end it holds the final rest, which is
//   how the shorter of two recordings waits for the longer one.
export function firstState(rec, out, which=0);
export function lastState(rec, out, which=0);
export function tweenInto(out, from, to, f); // cup -> release, and cancel-return
export function slerpInto(out, qa, qb, f);
export function lerpInto(out, pa, pb, f);
export function ease(t);                     // smoothstep
export function makeState();                 // -> { p:[0,0,0], q:[0,0,0,1] }
```

Why it exists: the sim is a fixed 1/120 s and displays are 60/120/144 Hz, so every
frame the game shows is an interpolation. Keeping that math dependency-free is
what lets `dev/replay-test.mjs` verify it headlessly against real recordings —
sampling at a frame time returns that frame exactly, and no sampled step ever
outruns two physics frames of real motion (i.e. the pigs cannot teleport).

## game.js — state machine

States: `setup → ready → shaking → tossing → settling → resolved → (ready | turnEnd) → win`
(PRD §7.1). Persistence (PRD §9): localStorage key `hogwild.v1`, saved AFTER each
resolution, auto-resume, cleared on win/new-game. Wake lock per PRD §10 —
acquire on game start, re-acquire on visibilitychange, release on win/setup.

**Order of a toss (not negotiable, it is what keeps Approach B honest and the
reveal a surprise):** `drawToss()` → persist it as `pending` → take recordings →
replay → *only then* labels, result card, score, `fx.revealToss`. The save
carries `pending` so a reload mid-flight resumes straight into that result
(no tumble): the outcome was committed before the pigs were in the air, so a
refresh can never be used to duck a Pig Out.

**Pen pose labels:** both Side poses are labelled `Sider` in odds.js, which is
right for scoring copy but leaves "Sider / Sider → Pig Out!" unexplained in the
pen, so the two pen labels read `Side · blank` / `Side · dot`. That names the
POSE, never the pig — the pigs stay identical and interchangeable.

**Replay lifetime:** the replay is driven by requestAnimationFrame, which does
not run in a hidden tab, so `play()` also arms a wall-clock deadline
(`total + 900 ms`) that lands the pigs on their real final frames and resolves
the turn. Without it, switching apps mid-toss leaves the turn stuck in
`tossing` with every control disabled. A skip tap (PRD §8.3) goes through the
same path (`adapter.requestSkip()`) so it works regardless of frame throttling.

UI copy: port from the 2D game (`git show 7be8349:hog-wild/index.html`) — the
rules table, headlines, button labels ("Go Hog Wild" / "Stop" per PRD §4).

## Design tokens (CSS + 3D must agree)

```
--felt-1 #2f6b52  --felt-2 #245240   (table)
--bg-1  #14231c  --bg-2  #0d1712    (page behind canvas)
--panel #1e3a2e  --panel-2 #27473a
--ink   #f4fbf7  --ink-dim #a9c9b8
--gold  #ffd54a  --pink  #f291ac  --danger #ff5c7a  --good #5ddb92
Font: system stack, headings 800 weight. Rounded 16px panels, soft shadows.
```

## Verification commands

```
node hog-wild/dev/odds-test.mjs        # odds distribution vs PRD §5, 400k draws
node hog-wild/dev/collider-test.mjs    # six-pose stability + emergent frequencies,
                                       # jowler roll <= 45 deg, >=90% of settles on green/rough
node hog-wild/dev/search-test.mjs      # trajectory search: finds every pose, timing
node hog-wild/dev/replay-test.mjs      # integration: drawn outcome -> recording -> screen

# and the visual pig's grounding (SPEC "Grounding must be measured"), which needs a
# resolver for the bare `three` specifier the browser gets from the importmap:
cd hog-wild && node --import ./dev/three-hook.mjs dev/grounding.mjs
```

`grounding.mjs` is not one of the four gates — it needs pig.js, which the gates
deliberately do not — but re-run it after ANY change to `BODY_PROFILE`, `crest()`, the
legs, the ear, the snout or `PIG_TUNING`. It prints the lowest visual vertex per pose
and fails outside ±6 mm.

Browser pages under http://localhost:4173/hog-wild/ (python http.server, no build).
