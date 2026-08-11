# Hog Wild — 3D Pig Toss

**Product Requirements Document**
Status: Draft for review · Last updated 2026-08-10 · Owner: Ava (with Dad)

---

## 1. What this is

A 3D, physics-driven dice game where the "dice" are two little rubber pigs. You
hold to shake them in a cup, let go, and they tumble into a walled pen and
bounce to a stop. However they land determines your points.

It's a push-your-luck game: you keep tossing to stack points up within a turn,
but one bad landing wipes the turn — and one *really* bad landing wipes your
whole score. You choose when to stop and lock it in.

This is a reimagining of the classic rubber-pig tossing game, renamed **Hog
Wild** so it stands on its own.

### Why 3D

The 2D version already in `hog-wild/index.html` works and is genuinely fun, but
the pigs just snap into a pose. The whole appeal of the real thing is the
*tumble* — the anticipation while they're still rolling, and the little gasp when
one wobbles and settles wrong. That's a physics problem, and physics is what
makes it worth building in 3D.

**The 3D version replaces the 2D one, which is deleted** (decision D2, §13).
There is exactly one Hog Wild when this ships. Before it goes, the 2D version's
scoring logic, rule copy, and win/setup flow should be lifted into the 3D build
rather than rewritten — they're already correct and playtested.

The 2D game stays playable only until 3D reaches M4, purely so there's no gap
where Ava has nothing to play. Removal is a required deliverable, not a
nice-to-have — see M5 in §12 for the checklist.

---

## 2. Goals

1. **The toss feels real.** Rigid-body physics, rubbery bounce, pigs that
   clatter off the walls and each other. Not a canned animation.
2. **The odds are honest.** Landing frequencies match published real-world
   tallies (see §5). A Leaning Jowler must feel like the rare miracle it is.
3. **Mobile-first.** Designed for a phone held in one hand. Hold-to-shake,
   release-to-toss. **The screen must never dim or lock while the game is open** —
   a game gets passed around a table and sits idle between turns.
4. **The payoff pops.** Points animate in with real weight. Doubles feel like an
   event. An Oinker feels like a disaster.
5. **Multiplayer around one device.** Pass the phone. Any number of players.
6. **Runs on GitHub Pages.** No server, no build step if avoidable.

## 3. Non-goals (for v1)

- Online / networked multiplayer
- Computer opponent
- Accounts, leaderboards, or cross-device sync
- Photorealistic rendering
- Replacing the 2D version — see the open question in §13

---

## 4. Core loop

```
Setup ──► Player's turn ──► hold to shake ──► release ──► pigs tumble
             ▲                                                │
             │                                                ▼
             │                                        physics settle
             │                                                │
             │                                                ▼
             │                                       classify + score
             │                                                │
             │              ┌──── Pig Out / Oinker ───────────┤
             │              │                                 │
             │              ▼                                 ▼
             └──────── turn ends                    keep going? ──► toss again
                                                          │
                                                          ▼
                                                    "Stop" ──► bank points
                                                                    │
                                                          reached target? ──► Win
```

### Turn actions

The active player has exactly two choices at all times:

| Action | Label | Effect |
| --- | --- | --- |
| Toss | **Go Hog Wild** | Shake and throw the pigs. Adds to the turn total. |
| Bank | **Stop** | Lock the turn total into the player's score, pass to next player. |

**Stop** is disabled until the player has tossed at least once in the turn — you
can't bank nothing.

---

## 5. Probability model

This is the part that has to be right, so it's specified numerically rather than
left to the physics engine to decide (see §6.3).

### 5.1 Single pig

Measured relative frequencies from a standardized rolling rig, n = 11,954:

| Position | Probability | Points |
| --- | --- | --- |
| Side, no dot | 34.9% | 0 |
| Side, dot up | 30.2% | 0 |
| Razorback (on its back) | 22.4% | 5 |
| Trotter (standing on all fours) | 8.8% | 5 |
| Snouter (on snout + front feet) | 3.0% | 10 |
| Leaning Jowler (on snout, ear, one foot) | 0.6% | 15 |

> Note: the two "side" results are distinguished by whether the pig's painted
> dot faces up. This matters — it's the only thing separating a 1-point Sider
> from a turn-ending Pig Out.

### 5.2 Both pigs

An **Oinker** (the pigs coming to rest touching each other) is a joint event, so
it gets its own independent draw at **0.38%**. Everything else is two
independent single-pig draws.

Derived two-pig odds, with published observed values as a cross-check:

| Result | Derived | Observed | Points |
| --- | --- | --- | --- |
| Pig Out (opposite sides) | 21.08% | ~21.3% | **turn total → 0** |
| Sider (matching sides) | 21.30% | — | 1 |
| Double Razorback | 5.02% | — | 20 |
| Double Trotter | 0.774% | — | 20 |
| Double Snouter | 0.090% | ~0.096% | 40 |
| Double Leaning Jowler | 0.0036% | ~0.0048% | 60 |
| Oinker | 0.38% | ~0.38% | **whole score → 0** |
| Any mixed pair | remainder | — | sum of both pigs |

Derived and observed agree closely, which is good evidence that treating the two
pigs as independent is sound.

### 5.3 Scoring rules

- **Mixed positions** score the plain sum of the two pigs. A pig on its side
  contributes 0, so Razorback + Side = 5.
- **Matching positions** score a double bonus (above), which is always more than
  twice the single value.
- **Pig Out** zeroes the *turn* total and passes the pigs.
- **Oinker** zeroes the player's *entire game score* and passes the pigs.

### 5.4 Expected value (design reference)

Roughly **4.7 points per toss** gross, against a **21.1%** chance of losing the
turn and a **0.38%** chance of losing everything. This is the tuning knob for
how tense the game feels — if playtesting says turns end too abruptly, the fix
is the target score (§9), not the odds.

---

## 6. Physics

### 6.1 The pen

A shallow open-topped box: floor plus four low walls, so pigs can ricochet but
can't escape. Camera looks down at a slight angle so all resting poses are
readable. Walls should be visually low or semi-transparent so they never hide a
pig.

### 6.2 Materials

The real pigs are soft rubber — some bounce, but they deaden fast rather than
pinging around like dice.

| Property | Starting value | Notes |
| --- | --- | --- |
| Pig restitution | ~0.4 | Bouncy but not rubber-ball springy |
| Pig ↔ table friction | ~0.7 | Rubber on felt; they scuff, don't slide far |
| Pig ↔ pig friction | ~1.0 | The "grab" — see below |
| Angular damping | moderate | They must settle within ~2s, not spin forever |
| Wall restitution | ~0.25 | Walls absorb; they don't launch pigs back |

**The "grab" behavior.** Rubber pigs don't stick together, but they do catch on
each other and stop dead instead of glancing off. Model this as high pig-to-pig
friction plus a small damping boost while the two are in contact. This is also
what makes Oinkers physically plausible rather than a coin flip bolted on.

### 6.3 The central tension: real physics vs. correct odds ⚠️

**These two goals fight each other, and this is the biggest decision in the
document.**

Real rigid-body physics on a pig-shaped collider will produce *some* distribution
of resting poses — but almost certainly not 22.4% Razorback and 0.6% Leaning
Jowler. Those numbers come from the specific mass distribution and geometry of a
real injection-molded pig. Matching them by tuning a collider is a research
project with no guarantee of success, and it would be brittle against any later
art change.

Four options:

**A. Pure emergent physics.** Simulate honestly, take whatever comes out.
*Pro:* simplest, unimpeachably "real." *Con:* the odds will be wrong, possibly
badly — a pose might be effectively impossible, which breaks the game's whole
risk/reward balance.

**B. Outcome-first with a real physics trajectory. ← recommended**
Draw the result from the weighted table in §5, then find a real throw that
produces it: run fast headless simulations with randomized initial conditions
(seeded and deterministic) until one settles into the target pose, then replay
that exact trajectory on screen.
*Pro:* exact odds *and* genuine physics — every tumble the player sees is a real
simulation, nothing is faked mid-flight. *Con:* more machinery; needs the
collider to be *capable* of all six poses; needs a search budget cap and a
fallback.

**C. Tune geometry until emergent odds match.** *Pro:* purest. *Con:* likely
weeks, may never converge, breaks whenever the model changes.

**D. Emergent physics with invisible re-rolls.** Statistically muddy and can
introduce bias. Not recommended.

**Decision: B** (D1, §13). It's the approach dice-rolling apps use precisely
because it gives you both properties. Note that B has a hard prerequisite: **the
pig collider must have six genuinely stable resting configurations.** Proving that
is the goal of milestone M0 (§12) — if a shape can't rest on its snout, no amount
of trajectory search will find a Snouter.

Two rules follow from choosing B, and they are not negotiable:

- **The search must be invisible.** If it can't find a matching trajectory within
  its budget, it must never stall the game — fall back to the nearest achievable
  pose and log it, rather than dropping a frame.
- **The player must never be able to influence the outcome.** Hold duration,
  shake vigor, and device motion all affect how the toss *looks*, never what it
  *scores*. Any coupling between input and result would be a bug.

### 6.4 Collider design

A single convex hull will **not** work — hulling a pig fills in the space between
the legs and under the snout, destroying exactly the delicate poses (Snouter,
Leaning Jowler) that make the game interesting. Use a **compound collider**:
body ellipsoid, four leg capsules, snout cylinder, ear wedge. Center of mass
placement is what makes Razorback common and Jowler rare.

### 6.5 Settle detection & classification

1. Consider a pig at rest when linear and angular velocity stay below a
   threshold for ~15 consecutive frames.
2. Classify by comparing the pig's local axes to world up — each pose has a
   characteristic local "up" vector; take the nearest match by dot product.
3. Require a minimum confidence margin. An ambiguous rest (leaning on a wall,
   balanced on an edge) triggers a **re-toss** with a brief "let's try that
   again" beat, rather than scoring a wrong guess.
4. Check pig-to-pig contact *before* classifying — an Oinker overrides both
   individual poses.

Under approach B the expected pose is already known, so classification doubles as
a **verification step**: if the sim disagrees with the intended outcome, that's a
bug worth logging in dev builds.

---

## 7. Interaction: shake and toss

The signature gesture. Must feel good on a phone.

### 7.1 States

| State | What the player sees | Input |
| --- | --- | --- |
| **Ready** | Cup at rest, subtle idle bob, "Hold to shake" | press anywhere in the pen |
| **Shaking** | Cup shakes, pigs rattle visibly inside, sound builds, slight camera shake | hold |
| **Released** | Cup tips, pigs fly out and tumble | release |
| **Settling** | Pigs bounce, roll, come to rest | none (locked) |
| **Resolved** | Pose labels appear, points pop in | Go Hog Wild / Stop |

### 7.2 Details

- **Hold anywhere** in the pen area, not a small button — thumb-friendly.
- **Shake intensity ramps** over the first ~1s: starts as a jiggle, builds to a
  vigorous rattle. Gives the hold a sense of charging up.
- **Throw force scales with hold duration**, clamped. Longer hold = harder throw
  = more chaotic tumble. This is *feel only* — under approach B it must not
  change the outcome distribution, which stays fixed at §5. Worth being explicit
  about: the player's hold does not make good results more likely. It just looks
  cooler.
- **Minimum hold** of ~250ms so a stray tap doesn't toss.
- **Release outside the pen** still throws — no accidental cancel.

### 7.3 Real accelerometer shake (opt-in)

Physically shaking the phone works as an alternative to holding (decision D3).
Rules:

- **Strictly additive.** Hold-to-shake always works. Device motion is a bonus
  path, never the only way to play.
- **Opt-in.** iOS requires a `DeviceMotionEvent.requestPermission()` user
  gesture. Ask once, from an obvious "Shake to roll" toggle in settings — never
  as an unprompted popup on load. If declined or unsupported, the toggle
  disappears and nothing else changes.
- Shake magnitude drives the on-screen shake intensity, and crossing a threshold
  then dropping below it triggers the throw.
- Needs a debounce so a single enthusiastic shake doesn't fire three tosses.

### 7.4 Quick Toss (accessibility floor)

A plain always-available **Quick Toss** button that skips the gesture and the 3D
reveal entirely and shows the result immediately (decision D4).

- **Identical odds.** It draws from the same model in §5 — it is a presentation
  shortcut, not a different game mode, and must never be framed as an easier or
  worse way to play.
- Covers three real needs at once: motor accessibility (hold-and-release is a
  genuine physical requirement), `prefers-reduced-motion`, and the repeat player
  on their fortieth toss who just wants the number.
- When `prefers-reduced-motion` is set, Quick Toss becomes the **default** action
  and the gesture is the secondary option, not the reverse.

---

### 7.5 Orientation & desktop

**Mobile is portrait-only** (decision D7). Portrait is how a phone gets passed
around a table, and locking it means one layout to design, one camera framing to
tune, and no mid-toss reflow. If the device rotates, keep rendering portrait
rather than reflowing.

**Desktop is supported as a real mode, not an afterthought.** Same game, same
odds, different input:

| | Mobile (portrait) | Desktop |
| --- | --- | --- |
| Toss | Hold anywhere in the pen, release | Hold the **Go Hog Wild** button (mouse) or hold **Space** |
| Device shake | Opt-in (§7.3) | Not applicable — hide the toggle entirely |
| Stop | Button | Button or **Enter** |
| Layout | Single column, pen fills the width | Wider pen, scoreboard can sit alongside rather than below |

Desktop notes:

- Hold-to-shake still applies — the charge-up is half the fun, and a plain click
  would feel flat. Press-and-hold on a button works fine with a mouse.
- **Keyboard must be fully sufficient.** Space to toss, Enter to stop, Tab to
  reach everything. Hold-Space needs `keydown`/`keyup` rather than the OS key
  repeat, and must not scroll the page.
- Don't show mobile-only copy ("Hold to shake") on desktop; say what the actual
  input is.

## 8. Animation & feedback

The user's explicit priority: *"just kind of have fun with the animation."*

### 8.1 The reveal sequence

Beats matter more than duration. Rough timing:

1. **Settle** (~0.1s pause after rest) — a beat of silence. Let it land.
2. **Spotlight** each pig briefly, in order, with its pose name rising above it.
3. **Points fly in per pig** — `+5` `+5` popping over each pig with a scale
   overshoot, staggered ~150ms apart, each with its own sound.
4. **Sum lands** in the turn total with a bump animation and a counting tick.
5. **Bonus overlay** for a double: the two `+5`s slide together and *merge* into a
   single golden `20`, with a bigger sound. This is exactly the "Razorback 5,
   double bonus" idea — the player watches the math happen.

### 8.2 Special results

- **Double anything** — golden burst, screen-wide shimmer, escalating chime by
  rarity. A Double Leaning Jowler (1 in 28,000) deserves genuine fanfare:
  confetti, held note, something Ava will remember seeing.
- **Pig Out** — pigs flop, color drains toward grey, turn total visibly shatters
  or drops to 0, descending buzzer, short camera shake.
- **Oinker** — the worst outcome should feel worst. Pigs are visibly tangled, a
  slow zoom onto the heap, low descending tone, the *entire score* spins down to
  zero digit by digit. Brief, but it should sting.
- **Near miss** — if a pig wobbles a long time before settling, let it. Don't cut
  the tension short; that wobble is free drama.

### 8.3 Restraint

Every animation needs a skip. Tapping during any reveal jumps to the end state.
Repeat players will toss dozens of times a game and must never feel held up.

---

## 9. Player system & setup

### Setup screen

- **Players:** add/remove rows, name each. Minimum 2. Names persist for "play
  again."
- **Target score:** default **100**. Presets for a quick and a long game, plus a
  custom entry.
- **Start** begins with the first player listed.

### During play

- Scoreboard always visible: every player, current score, active player marked.
- Active player's name and running turn total prominent.
- Turn total visually distinct from banked score — the whole tension is "this
  number is not yours yet."

### Winning

- First player to **reach or exceed** the target when they **Stop** wins.
  Reaching it mid-turn does *not* win — you must bank it. This preserves the
  push-your-luck decision right to the last point.
- Win screen: winner, final standings, play again (same players) / change
  players.

### Saving an in-progress game

The whole game state survives a reload (decision D6). Someone will drop the
phone, hit refresh, or get a browser update mid-game, and losing a 90-point game
to that is the kind of thing that ends game night.

Persist to `localStorage`: player names, every score, whose turn it is, the
current turn total, and the target score. On load, **auto-resume** — no "restore
game?" prompt, since an accidental reload should be invisible. **New Game** is
already the obvious way out for anyone who wants a fresh start.

One rule that matters: **write the save after every scoring event resolves**, not
before. If the save happened first, a player could reload to undo a Pig Out or an
Oinker, and someone absolutely will figure that out. Clear the save when a game
is won or abandoned.

---

## 10. Technical architecture

### Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Rendering | Three.js | Mature, well documented |
| Physics | Rapier (WASM) or cannon-es | Rapier is faster and deterministic — determinism is a hard requirement for approach B |
| Language | Vanilla ES modules | Matches the repo: no framework |
| Build | None if possible | See open question on vendoring |

### Constraints from this repo

Every existing game is a single self-contained `index.html` with inline CSS and
JS, served straight off GitHub Pages with no build step. A 3D game with two
WASM/JS dependencies can't quite fit that, so this game will need:

Since the 3D version replaces the 2D one, it takes over the existing
`hog-wild/` directory and menu entry — no rename, no second entry, and existing
links keep working:

- `hog-wild/index.html` — markup and UI (replaces the 2D game at M4)
- `hog-wild/game.js` — game logic, scoring, state machine
- `hog-wild/physics.js` — pen, colliders, trajectory search, classification
- `hog-wild/pig.js` — mesh and material
- `hog-wild/odds.js` — the §5 probability model, shared by the 3D game, Quick Toss, and the M2 test harness
- `hog-wild/vendor/` — pinned Three.js + physics engine

Keeping `odds.js` as one module used by all three consumers is what makes the
"Quick Toss has identical odds" guarantee structural rather than something we
have to remember to maintain in two places.

**Vendoring is recommended over a CDN.** The site must work offline (it has a web
manifest), and a CDN outage would break Ava's game. Pinned local copies also mean
it can't spontaneously break from an upstream release.

### Performance budget

**Target device: Google Pixel** (decision D5). Tune against a real Pixel, not a
throttled desktop profile — desktop throttling emulates CPU but not the GPU,
thermal behavior, or the resolution the phone actually renders at.

- **60fps during the tumble** on the target Pixel. This is the one moment that
  must not stutter.
- Android/Chrome makes this easier in one way and harder in another: WASM physics
  and `wakeLock` are well supported, but Pixels downclock aggressively when warm,
  so test after a few minutes of continuous play rather than on the first toss.
- Two rigid bodies is a trivial physics load; the risk is render cost. Keep the
  pig mesh low-poly, bake shadows or use a single cheap contact shadow.
- **Trajectory search must stay off the main thread's critical path.** Budget
  ~50ms; run candidate sims during the shake (which lasts ≥250ms and usually
  ~1s), so the answer is ready before the player releases. This hides the search
  entirely.

### Pig model

Reference photos of the real pigs are in
[`reference-images/pass-the-pigs/`](../reference-images/pass-the-pigs/) — the two
pigs from several angles plus the original scoring card. Use them for proportions
and the pink/magenta color, but a slightly stylized, chunky low-poly pig will
read better at phone size than an accurate replica.

### Keeping the screen awake

The phone must not dim or auto-lock while the game is open. This game has long
idle stretches by design — the device gets passed around, players argue about
whether to push their luck, someone gets a drink — and having the screen die
mid-game and demand a passcode would be genuinely infuriating.

Use the **Screen Wake Lock API**:

```js
const lock = await navigator.wakeLock.request("screen");
```

Implementation requirements:

- **Acquire on game start**, not page load. It needs a visible document, and
  holding a lock on the setup screen is pointless battery drain.
- **Re-acquire on `visibilitychange`.** The browser silently releases the lock
  whenever the tab is hidden and does *not* restore it on return. Without a
  re-acquire handler the lock dies the first time the player switches apps, which
  is the single most common way to get this wrong.
- **Release deliberately** on the win screen and when returning to setup. Don't
  hold a lock on a finished game.
- **Feature-detect and degrade silently.** Wrap in a `try`/`catch` and check for
  `navigator.wakeLock` — the request can reject for reasons outside our control
  (low battery, OS power saving). A failed lock must never block play or surface
  an error; the game just behaves as it does today.
- **Requires a secure context.** Fine here: GitHub Pages is HTTPS, and
  `localhost` counts as secure for development.

Support is good on current iOS Safari and Chrome. Notably, **do not** reach for
the old looping-hidden-`<video>` trick as a fallback — it burns battery, can
break audio, and the graceful degradation above is the honest behavior.

Worth verifying on a real device during M5, since this is exactly the kind of
thing that works in a desktop browser and fails on the phone that matters.

---

## 11. Audio & haptics

- **Shake:** building rattle, pitch and rate rising with hold duration.
- **Impacts:** physics-driven — collision impulse maps to volume, so a hard wall
  hit is loud and a final settling nudge is soft. Distinct pig-on-pig sound.
- **Scoring:** per-pig pips, ascending; doubles get a fuller chord.
- **Failure:** descending buzzer (Pig Out), lower and longer (Oinker).
- **Haptics:** `navigator.vibrate` on landing and on failure, where supported.
- **Mute toggle,** persisted. Audio must never autoplay before first interaction.

---

## 12. Milestones

| # | Milestone | Exit criteria |
| --- | --- | --- |
| **M0** | **Physics spike** | A pig collider that demonstrably rests stably in all six poses. **This gates everything** — if it fails, §6.3 needs rethinking. |
| M1 | Toss loop | Hold, shake, release, tumble, settle, classify. One player, no scoring. |
| M2 | Odds harness | Headless runner does 100k tosses and reports the distribution against §5, within tolerance. Runs in CI or as a dev page. |
| M3 | Scoring & players | Full turn logic, multiplayer, banking, win condition. |
| M4 | Juice | The §8 reveal sequence, audio, haptics. |
| M5 | Polish & cleanup | Accessibility, reduced motion, perf pass on a real phone, offline check, **wake lock verified on a real device**, and the 2D-removal checklist below completed. |

### M5 removal checklist (decision D2)

The 2D version is not "deprecated," it's gone. Done means all of:

- [ ] 2D `index.html` deleted (3D build occupies `hog-wild/index.html`)
- [ ] Exactly one Hog Wild entry in `games.json`
- [ ] Matching single entry in the `FALLBACK_GAMES` array in the root `index.html`
- [ ] No leftover links, toggle, or "classic version" escape hatch anywhere
- [ ] Root menu verified against both `games.json` and the fallback path

M2 before M4 is deliberate: prove the game is *correct* before making it
*pretty*, because discovering the odds are wrong after building the animation
means rebuilding the animation.

---

## 13. Decisions

| # | Decision | Resolution |
| --- | --- | --- |
| **D1** | Odds vs. physics | **Outcome-first with a real physics trajectory** (§6.3 option B). Exact odds, genuine simulation on screen. |
| **D2** | Fate of the 2D version | **Deleted.** 3D takes over the `hog-wild/` directory and menu entry. The 2D game is removed from the repo at M5 — one game, one entry, no toggle. It stays recoverable from git history. |
| **D3** | Accelerometer shake | **Yes, opt-in** (§7.3). Additive only; hold-to-shake always works. |
| **D4** | Quick Toss | **Yes** (§7.4). Same odds, becomes the default under `prefers-reduced-motion`. |
| **D5** | Target device | **Google Pixel** (§10). Perf tuned on real hardware, warm. |
| **D6** | Persistence | **Full game state persists** across reload, auto-resumed (§9). Save written after each result resolves. |
| **D7** | Orientation | **Portrait-only on mobile**, plus a proper button/keyboard desktop mode (§7.5). |
| **D8** | Position names | **Keep the original names** — Sider, Razorback, Trotter, Snouter, Leaning Jowler, Pig Out, Oinker. They're what people actually call these, and substitutes would make the game harder to explain to anyone who's played the real thing. (They do originate with the commercial product, but they describe gameplay outcomes rather than branding — a materially different use from the product name, which is why the game itself is called Hog Wild. Worth a fresh look only if this ever ships commercially.) |

## 14. Still open

1. **Does the reveal sequence need a "history" view?** Some players like seeing
   the last few tosses. Probably a v2 idea, noted so it isn't lost.

Everything else is decided (§13). The next action is **M0** — prove a pig collider
can rest stably in all six poses. Nothing else should start until it does, because
the whole odds approach (D1) depends on it.

---

## Appendix: sources

- [Pig Data and Bayesian Inference on Multinomial Probabilities](https://jse.amstat.org/v14n3/datasets.kern.html) — Kern, *Journal of Statistics Education* 14(3), the standard reference dataset
- [Pig Data and Bayesian Inference (full article)](https://www.tandfonline.com/doi/full/10.1080/10691898.2006.11910593)
- [Analytics, Pedagogy and the Pass the Pigs Game](https://pubsonline.informs.org/doi/pdf/10.1287/ited.1120.0088) — *INFORMS Transactions on Education*
- [Pass the pigs — ad (almost) infinitum](https://blog.waikato.ac.nz/physicsstop/2020/04/17/pass-the-pigs-ad-almost-infinitum/) — University of Waikato, independent 1,111-roll tally
- [Pass the Pigs (Wikipedia)](https://en.wikipedia.org/wiki/Pass_the_Pigs)
