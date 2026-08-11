// hog-wild/game.js
//
// State machine, turn logic, players, persistence, wake lock, UI wiring.
// See SPEC.md for the module contracts this file depends on.
//
// State machine (SPEC.md, PRD §7.1):
//   setup -> ready -> shaking -> tossing -> settling -> resolved -> (ready | turnEnd) -> win

import { revealToss, celebrate, sadness, initAudio, setMuted, isMuted } from './fx.js';

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

const adapter = {
  ready: false,
  scene: null,
  pigSim: null,
  cache: null,
  pigMeshes: null,

  async boot(canvas) {
    try {
      const [pigMod, physMod] = await Promise.all([import('./pig.js'), import('./physics.js')]);
      const { buildScene, buildPig, buildPen } = pigMod;
      const { PigSim, TrajectoryCache } = physMod;
      if (
        typeof buildScene !== 'function' ||
        typeof buildPig !== 'function' ||
        typeof buildPen !== 'function' ||
        typeof PigSim !== 'function' ||
        typeof TrajectoryCache !== 'function'
      ) {
        throw new Error('pig.js / physics.js loaded but missing expected exports');
      }

      const scene = buildScene(canvas);
      const pen = buildPen();
      const pigA = buildPig({ dot: false });
      const pigB = buildPig({ dot: true });
      scene.scene?.add?.(pen);
      scene.scene?.add?.(pigA, pigB);

      const pigSim = new PigSim();
      const cache = new TrajectoryCache();
      // Best-effort idle prefill so the first toss doesn't pay the full
      // search cost. Never let a slow/odd prefill block boot.
      try {
        cache.prefill?.(200);
      } catch (err) {
        console.warn('[hog-wild] TrajectoryCache.prefill failed (non-fatal)', err);
      }

      this.scene = scene;
      this.pigSim = pigSim;
      this.cache = cache;
      this.pigMeshes = [pigA, pigB];
      this.ready = true;
      return true;
    } catch (err) {
      console.warn('[hog-wild] 3D boot failed — falling back to Quick Toss-only mode.', err);
      this.ready = false;
      return false;
    }
  },

  /** Called repeatedly while the player is holding, ramp 0..1 over ~1s. */
  shakeUpdate(_ramp) {
    if (!this.ready) return;
    try {
      // A later agent wires actual cup/pig jitter + camera shake here.
    } catch (err) {
      console.warn('[hog-wild] shakeUpdate failed (non-fatal)', err);
    }
  },

  /**
   * Play the toss for a pre-drawn outcome (Approach B: the outcome is
   * already known — this call must never influence it, only how it looks).
   * Resolves once pigs are settled on screen, or immediately if no 3D
   * trajectory could be found/played (fallback per PRD §6.3).
   *
   * @param {{oinker:true}|{a:string,b:string}} outcome
   * @returns {Promise<void>}
   */
  async toss(outcome) {
    if (!this.ready) return;
    try {
      let recording = null;
      if (outcome.oinker) {
        recording = this.cache?.takeOinker?.() ?? this.pigSim?.findOinker?.({});
      } else {
        // Single-pig recordings for each target pose; either could miss.
        recording = {
          a: this.cache?.take?.(outcome.a) ?? this.pigSim?.findRecording?.(outcome.a, {}),
          b: this.cache?.take?.(outcome.b) ?? this.pigSim?.findRecording?.(outcome.b, {}),
        };
      }
      if (!recording) return;
      // A later agent replays `recording` frame-by-frame onto
      // this.pigMeshes via requestAnimationFrame here, keyed on the
      // recording's dt (SPEC.md "Recording format").
    } catch (err) {
      console.warn('[hog-wild] toss playback failed (non-fatal, resolving instantly)', err);
    }
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
  } else {
    releaseWakeLock();
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
  saveGame();
  beginTurn(false);
}

/** Resolve a drawn outcome into a score result, update state, persist,
 * then play the (currently no-op) reveal. Approach B: the outcome is
 * already fully known here, before any animation plays — see SPEC.md
 * "Approach B invariants." That ordering is what lets us persist the true
 * result before the reveal even starts, so a mid-animation reload can
 * never be used to duck a bad result (PRD §9). */
async function resolveOutcome(outcome) {
  state.tossedThisTurn = true;

  if (outcome.oinker) {
    // Pick two display-only poses for flavor; they don't affect scoring —
    // an Oinker always zeroes the whole score regardless of how the pigs
    // "look" tangled together.
    const shownA = pickDisplayPose();
    const shownB = pickDisplayPose();
    const player = currentPlayer();
    state.turnTotal = 0;
    player.score = 0;
    saveGame();

    setPoseLabels(odds.POSES[shownA]?.label ?? 'Tangled', odds.POSES[shownB]?.label ?? 'Tangled');
    renderTurnBanner();
    renderScoreboard();
    setResultCard(
      'awful',
      'Oinker!! 😱',
      `The pigs are touching — ${player.name} goes all the way back to zero.`
    );
    sadness('oinker');
    revealToss({ ...outcome, type: 'oinker', points: 0, headline: 'Oinker!!' });

    setTurnState('settling');
    await adapter.toss(outcome);
    setTurnState('resolved');
    setActionsEnabled({ toss: false, stop: false, quick: false });
    setTimeout(() => nextPlayer(), reducedMotion ? 400 : 1900);
    return;
  }

  const result = odds.scoreToss(outcome.a, outcome.b);
  const labelA = odds.POSES[outcome.a]?.label ?? outcome.a;
  const labelB = odds.POSES[outcome.b]?.label ?? outcome.b;
  setPoseLabels(labelA, labelB);

  if (result.type === 'pigout') {
    state.turnTotal = 0;
    saveGame();
    renderTurnBanner();
    setResultCard('bad', result.headline, result.detail);
    sadness('pigout');
    revealToss({ ...outcome, ...result });

    setTurnState('settling');
    await adapter.toss(outcome);
    setTurnState('resolved');
    setActionsEnabled({ toss: false, stop: false, quick: false });
    setTimeout(() => nextPlayer(), reducedMotion ? 400 : 1500);
    return;
  }

  state.turnTotal += result.points;
  saveGame();
  renderTurnBanner();
  bumpTurnPoints();
  renderScoreboard();

  const tone = result.type === 'double' ? 'big' : 'good';
  setResultCard(tone, result.headline, `${result.detail} Turn total: ${state.turnTotal}.`);
  if (result.type === 'double') celebrate('double');
  revealToss({ ...outcome, ...result });

  setTurnState('settling');
  await adapter.toss(outcome);
  setTurnState('resolved');
  setActionsEnabled({ toss: true, stop: true, quick: true });
  // Nothing left to wait on (fx.js reveal hooks are no-ops for now) — go
  // straight back to ready so the next toss/bank is accepted. A later
  // agent adding a real timed reveal should hold 'resolved' until that
  // reveal finishes (or is tap-skipped) before calling this.
  setTurnState('ready');
}

async function performToss() {
  if (state.turnState !== 'ready') return;
  setTurnState('tossing');
  setActionsEnabled({ toss: false, stop: false, quick: false });
  clearResultCard();
  setPoseLabels('…', '…');

  // Approach B (SPEC.md): draw the outcome first, independent of hold
  // duration/shake — those only affect how the toss *looks*.
  const outcome = odds.drawToss();
  await resolveOutcome(outcome);
}

function bankPoints() {
  if (state.turnState !== 'ready') return;
  if (!state.tossedThisTurn || state.turnTotal === 0) return;

  const player = currentPlayer();
  const banked = state.turnTotal;
  player.score += banked;
  state.turnTotal = 0;
  state.tossedThisTurn = false;
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
  setTimeout(() => nextPlayer(), reducedMotion ? 300 : 1200);
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

  const tick = () => {
    if (!holdActive) return;
    const elapsed = performance.now() - holdStart;
    const ramp = Math.min(1, elapsed / RAMP_MS);
    dom.holdFill.style.transform = `scaleX(${ramp})`;
    adapter.shakeUpdate(ramp);
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

// Tap during a reveal skips it (PRD §8.3).
dom.penWrap.addEventListener('pointerdown', () => {
  if (state.turnState === 'tossing' || state.turnState === 'settling') {
    setTurnState('resolved');
  }
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
  performToss();
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
  saveGame();
  beginTurn(true);
  showScreen('game');
});

dom.changePlayersBtn.addEventListener('click', () => goToSetup(true));

function goToSetup(keepNames) {
  clearSave();
  populateSetupFromPlayers(keepNames ? state.players : null);
  showScreen('setup');
}

/* =========================================================================
 * Boot
 * ==================================================================== */

async function boot() {
  dom.body.classList.toggle('reduced-motion', reducedMotion);

  await loadOdds();

  const resumed = loadGame();
  if (resumed) {
    state.players = resumed.players;
    state.currentIndex = resumed.currentIndex ?? 0;
    state.turnTotal = resumed.turnTotal ?? 0;
    state.tossedThisTurn = !!resumed.tossedThisTurn;
    state.targetScore = resumed.targetScore ?? 100;
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
}

boot();
