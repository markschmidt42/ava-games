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
| `pig.js` | Three.js pig mesh + materials + scene helpers (pen, lights, camera) |
| `fx.js` | Reveal sequence, particles, audio (WebAudio), haptics |
| `vendor/` | Pinned three.module.js, three.core.js, cannon-es.js — never edit |
| `dev/` | Test/dev pages: collider-lab.html, pig-viewer.html, odds-harness.html, *-test.mjs node scripts |

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
  constructor()                          // builds world + 2 pig bodies, pen size PEN
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
export const PEN = { w: 5.4, d: 7.4, wallH: 0.85 }; // meters-ish, portrait aspect
```

**Recording format** (the only thing crossing physics→render):

```js
{ dt: 1/120, frames: [ { p:[x,y,z], q:[x,y,z,w] }, ... ], settledPose: poseKey }
// PairRecording: frames have p1,q1,p2,q2; used for Oinker only.
```

Two independent single recordings are replayed together for normal tosses —
pig A confined to left half spawn/landing zone, pig B right half, so replayed
paths can't intersect. `findRecording` rejects candidates leaving their half.
Mirror augmentation allowed (pen is symmetric): a recording may be reflected
across the pen's long axis to double pool variety.

**Coordinates:** Y up, floor plane y=0, pen centered on origin, camera looks
down the −Z with pitch ≈ 52° for portrait framing.

**Approach B invariants (PRD §6.3):** outcome is drawn from odds.js BEFORE the
search; hold duration/shake NEVER feeds the outcome; search runs during shake
and from the idle prefill cache; on cache miss + search timeout, fall back to
nearest achievable pose and `console.warn` in dev.

**Board design (owner decision — supersedes the walled pen):** NO WALLS. Walls
create lean-against-wall rests that are none of the six named poses, forcing
re-tosses. Instead the board is a putting green of concentric zones:

| Zone | Radius (start values) | Behavior |
| --- | --- | --- |
| Green | r ≤ 2.1 | Hard and lively — friction .7, restitution .4, exactly the current feel |
| Rough ("frog fur") | 2.1 < r ≤ 3.4 | Deadened: per-step velocity damping ≈ .965 while grounded, upward rebound squashed ~55% |
| Fringe | 3.4 < r ≤ 4.5 | Motion just dies: damping ≈ .85/step, rebound squashed ~85% |

Grounded = y below ~0.6; zones never grab an airborne pig. A hard invisible
backstop beyond the fringe (radial position clamp) guarantees nothing escapes,
but must be practically unreachable. Implementation reference (working code):
`_watch/arena.html` — zone damping applied post-step, single floor plane, no
geometry seams. `PEN {w,d,wallH}` is superseded by `BOARD {greenR, roughR,
stopR}` — update SPEC, physics.js, and pig.js buildPen → buildBoard (three
concentric felt discs, subtle boundary rings) together, and keep the half-lane
spawn discipline (now semicircular halves). This lands in the WF-B realism
pass alongside leg asymmetry and the jowler attitude fix; WF-A integrates
against the interim walled pen. All six poses must re-verify on the zoned
board, and recordings must respect the new bounds (settle on green or rough;
fringe settles are valid but should be rare — tune throw ranges so ~90%+ of
settles happen on green/rough).

**Throw realism (owner note):** unconstrained center-aimed throws make the pigs
touch at rest far too often vs. real life (real Oinker ≈ 0.38%). The half-pen
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

## Geometry realism (owner requirement — applies to BOTH collider and visual pig)

The pig's shape must track the real pig in the reference photos
(`../reference-images/pass-the-pigs/`): leg placement, ear placement, head/snout
proportions, and back shape should all be recognizably the same animal.

**Leg asymmetry is mandatory and is the real side-bias mechanism.** On the real
pig the legs sit closer to / angled toward the *blank* flank, so resting on the
blank flank is propped and tippy — which is why "dot up" is the rarer Sider
(30.2% vs 34.9%). Implement this in `PIG_TUNING`/`makeParts`: per-side leg X
offset and/or splay (e.g. `legLeanX`), signs chosen so the emergent split
matches reality's **direction** (blank-up more common than dot-up). The ears
must NOT be the primary source of the side split — after the change, verify by
zeroing the leg lean in a scratch run and confirming the side split collapses
toward even.

Emergent percentages still don't need to match the table exactly (Approach B),
but mechanism and direction must be real. All six poses must stay stable and
searchable after the change (re-run collider-test + search-test).

**Jowler attitude:** the Leaning Jowler is a *Snouter with a lean*, not a
side-lie — snout planted, rump up, body pitched nose-down like the snouter,
rolled only far enough for the ear tip to touch (roll ≈ 25–40° from upright;
≥55° reads as lying down and is wrong — see the scoring-card photo in the
reference images). Achieve this with ear geometry: the closer the ear tip sits
to the head's side plane (and the higher it is), the smaller the roll at
contact. After tuning, print the jowler rest's roll angle in collider-test.mjs
and assert it ≤ 45°.

Known deliberate deviation, keep it: the real pig can jowler on either ear; our
collider's second ear is swept forward so only one jowler equilibrium exists,
because a mirror-jowler would be a seventh pose the classifier can't name. Both
ears still exist and look symmetric visually; only the collider sweep differs.

The visual pig in pig.js must share the collider's silhouette — same leg
positions and lean, same ear placement, same head/snout proportions (read
`PIG_TUNING` from physics.js and derive placements from it where practical, so
the two can't drift apart).

## pig.js — exports

```js
export function buildPig()        // → THREE.Group, ~unit 1 = 1 pen-meter,
                                  //   body length ≈ 1.0, origin at collider COM,
                                  //   +Z = snout direction, +Y = up when trotting
export function buildPen()        // board group — see "Board design": three
                                  // concentric felt discs, NO walls (interim
                                  // walled pen acceptable until WF-B realism pass)
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
"blank pig" in any UI — they are interchangeable. COM-frame conversion for the
dot position: see `_watch/arena.html` (getting this wrong leaves the dot
floating off the body).

Look: charming, stylized, modern mobile-game quality (Monument Valley/Nintendo
bar, NOT photoreal). Reference photos: `../reference-images/pass-the-pigs/`.
Soft pink body #f0a3b5-ish with subtle SSS-feel (physical material, sheen),
blush snout/trotters, tiny tail.
ACESFilmic tone mapping, soft shadows (one directional + hemisphere + env),
contact shadow under pigs, felt table with subtle procedural texture.

## game.js — state machine

States: `setup → ready → shaking → tossing → settling → resolved → (ready | turnEnd) → win`
(PRD §7.1). Persistence (PRD §9): localStorage key `hogwild.v1`, saved AFTER each
resolution, auto-resume, cleared on win/new-game. Wake lock per PRD §10 —
acquire on game start, re-acquire on visibilitychange, release on win/setup.

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
node hog-wild/dev/collider-test.mjs    # six-pose stability + emergent frequencies
node hog-wild/dev/search-test.mjs      # trajectory search: finds every pose, timing
```

Browser pages under http://localhost:4173/hog-wild/ (python http.server, no build).
