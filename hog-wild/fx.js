// hog-wild/fx.js
//
// STUB MODULE — every export below is currently a no-op. A later agent
// replaces the bodies with the real reveal sequence, particles, audio
// (WebAudio) and haptics described in PRD.md §8 and §11.
//
// game.js calls this exact surface. Keep these names and call signatures
// stable while filling them in, or update SPEC.md + game.js together.
//
// Zero dependencies, browser-only (WebAudio/Vibration/etc). Every function
// must stay safe to call even before any user gesture, before audio is
// unlocked, or if the underlying API is unsupported — wrap real
// implementations in try/catch so fx.js can never be the thing that breaks
// a turn. game.js does not await most of these; treat them as
// fire-and-forget cues.

let muted = false;

/**
 * Unlock/create the audio context. Call this from inside a real user
 * gesture handler (pointerdown/keydown) before any sound is expected to
 * play — browsers block audio until then.
 */
export async function initAudio() {
  // no-op stub
}

/** Persisted mute toggle. game.js owns *storing* the preference; this just
 * tells fx.js whether to make noise. */
export function setMuted(value) {
  muted = !!value;
}

export function isMuted() {
  return muted;
}

/**
 * Play the full reveal sequence for a resolved toss (PRD §8.1): settle
 * beat, per-pig spotlight + pose name, points flying in, doubles merging
 * into a bonus number, sum landing in the turn total.
 *
 * @param {object} result - shape from odds.js `scoreToss`, plus context:
 *   { type: 'sider'|'pigout'|'double'|'mixed'|'oinker',
 *     points, headline, detail, a, b, oinker }
 */
export function revealToss(_result) {
  // no-op stub
}

/**
 * A celebratory beat: a double, a bank, or the win screen.
 * @param {'double'|'bank'|'win'} _type
 */
export function celebrate(_type) {
  // no-op stub
}

/**
 * A downbeat: Pig Out (turn wiped) or Oinker (whole score wiped).
 * @param {'pigout'|'oinker'} _type
 */
export function sadness(_type) {
  // no-op stub
}
