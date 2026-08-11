# Hog Wild — Project Status (paused 2026-08-11)

Paused by owner to conserve tokens. This file is the resume point.

## Where things stand

**The game is built, playable, and shipped-quality:** final critic verdict
**9/10 WOWED** (from a 4/10 start, across ~7 critic⇄fixer rounds), all four
verification suites green (`dev/odds-test.mjs`, `collider-test.mjs`,
`search-test.mjs`, `replay-test.mjs`), M5 ship checklist complete (see PRD §12),
full smoke test passed on desktop + mobile viewports.

Last completed work (all committed through `e48602d`):
- Wooden barrel vessel + pour-out release (owner direction)
- Shake overhaul: pigs rattle inside the barrel, continuous mobile touch-hold
  (pointercancel fix), device-motion shake + `dev/shake-test.html` harness
- CUTE-mandate face rebuild: 3 variants in pig-viewer (keys a/b/c), B default
- Face-orientation fixes: per-pose face ink rotation (mouth never reads as an
  eyebrow), eye-facing reveal camera term (razorback reveals show the face),
  camera-facing wink

## In flight when paused (not lost, just unverified)

The **independent re-check** of the orientation fixes was mid-run when
stopped. The fixes themselves are committed; re-verification of the six
measurements (mouth-below-eye in flank rests, eye-facing dot products, wink
both flanks, single catchlight, short-canvas eye floor) has NOT been
independently confirmed. Resume via:
`Workflow({scriptPath: '<session>/workflows/scripts/hogwild-face-orientation-wf_50c5fb7d-93e.js', resumeFromRunId: 'wf_50c5fb7d-93e'})`
(fixer replays from cache, re-check runs live) — or just fold the re-check
into the next workflow.

## Next queued work (owner-directed, spec'd, NOT started)

**Storybook pig redesign** — SPEC.md "OWNER REFERENCE REDESIGN (2026-08-11)":
huge floppy ears with visible inner ear, big round eyes WITH white sclera +
warm amber iris (supersedes bean-minimal), prominent snout with bold
nostrils, gentle smile, matte latex squeaky-toy rubber material (replaces
glossy porcelain — "it bounces like a bouncy ball, it needs to look the
part"), legs pink / hooves may be black-grey (owner clarified: the no-browns
rule means no tree-branch LEGS, dark hooves are fine and natural).

## Open owner decisions

1. **Face pick**: owner leaned variant A but wants the storybook redesign
   instead — redesign supersedes the a/b/c pick.
2. **ORPHAN_GRACE (900ms)**: after a platform pointercancel, shake holds 900ms
   more then auto-throws. Owner hasn't chosen between keeping this vs
   extending grace to the hold cap. Current behavior stays.
3. **Push to GitHub Pages**: everything is committed locally on
   `feature/pass-the-pig`; nothing pushed. Dev tools are wired to ship to prod
   per owner (devnav on all pages, relative paths verified for the
   /ava-games/ subpath).

## How to resume

- Dev server: `python3 -m http.server 4173` from repo root (or the
  `ava-games` entry in `.claude/launch.json`). Game: `/hog-wild/`.
- Dev pages (all linked via the 🛠 devnav): `/_watch/` dashboard ·
  `/_watch/arena.html` · `/_watch/poses.html` · `/hog-wild/dev/pig-viewer.html`
  (poses 1-6, expressions qwertyui, variants abc, zoom z) ·
  `/hog-wild/dev/audio-lab.html` (muted by default; `?audible=1` to hear) ·
  `/hog-wild/dev/shake-test.html`.
- Dashboard watcher: remove `_watch/.stop`, then loop
  `node _watch/gen.mjs` every ~5s (it parses agent transcripts → data.json).
- **Audio is globally muted** (owner was in a meeting):
  `localStorage['hogwild.muted.v1'] = '1'` — unmute via the in-game button.
- Verification: run the four suites in `hog-wild/dev/` + `node --check` on
  the six game JS files. All were green at pause.
- The 2D game lives at commit `7be8349` if ever needed.

## Build history

The whole build ran 2026-08-10 → 08-11 as orchestrated agent workflows
(foundation → realism/QA → juice + critic loops → shake → barrel/ship → cute).
Workflow transcripts: `~/.claude/projects/-Users-mschmidt-source-ava-games/
41c21d9b-c1d5-4fce-9abf-b96319c2a7ae/subagents/workflows/`.
The critic score arc: 4 → 5 → 5 → 8 → 9 (WOWED).
