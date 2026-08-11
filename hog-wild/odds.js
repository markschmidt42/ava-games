// Hog Wild — probability model and scoring
// Zero dependencies. Shared by game.js, odds-test.mjs, and odds-harness.

export const POSES = {
  'side-blank': { points: 0, p: 0.349, label: 'Sider' },
  'side-dot': { points: 0, p: 0.302, label: 'Sider' },
  'razorback': { points: 5, p: 0.224, label: 'Razorback' },
  'trotter': { points: 5, p: 0.088, label: 'Trotter' },
  'snouter': { points: 10, p: 0.030, label: 'Snouter' },
  'jowler': { points: 15, p: 0.007, label: 'Leaning Jowler' },
};

export const OINKER_CHANCE = 0.0038;

const POSE_KEYS = Object.keys(POSES);

/**
 * Draw a single pig pose from the distribution.
 * @param {Function} rng - random number generator (default Math.random)
 * @returns {string} pose key
 */
function drawPose(rng) {
  const roll = rng();
  let cumulative = 0;
  for (const key of POSE_KEYS) {
    cumulative += POSES[key].p;
    if (roll < cumulative) {
      return key;
    }
  }
  return POSE_KEYS[POSE_KEYS.length - 1];
}

/**
 * Draw a toss outcome: either an oinker or two independent poses.
 * @param {Function} rng - random number generator (default Math.random)
 * @returns {Object} { oinker: true } or { a: poseKey, b: poseKey }
 */
export function drawToss(rng = Math.random) {
  // Oinker is drawn independently
  if (rng() < OINKER_CHANCE) {
    return { oinker: true };
  }
  // Otherwise, two independent single-pig draws
  return {
    a: drawPose(rng),
    b: drawPose(rng),
  };
}

/**
 * Check if a pose is a side position.
 * @param {string} pose - pose key
 * @returns {boolean}
 */
function isSide(pose) {
  return pose.startsWith('side-');
}

/**
 * Score a pair of poses.
 * @param {string} a - first pose key
 * @param {string} b - second pose key
 * @returns {Object} { type: 'sider'|'pigout'|'double'|'mixed', points, headline, detail }
 */
export function scoreToss(a, b) {
  // Both sides
  if (isSide(a) && isSide(b)) {
    if (a === b) {
      // Same side = Sider
      return {
        type: 'sider',
        points: 1,
        headline: 'Sider! +1',
        detail: 'Both pigs landed the same way up.',
      };
    }
    // Opposite sides = Pig Out
    return {
      type: 'pigout',
      points: 0,
      headline: 'Pig Out!',
      detail: "Opposite sides — this turn's points are gone.",
    };
  }

  // Both same non-side pose = Double
  if (a === b) {
    const doublePoints = {
      razorback: 20,
      trotter: 20,
      snouter: 40,
      jowler: 60,
    };
    const points = doublePoints[a];
    const label = POSES[a].label;
    return {
      type: 'double',
      points,
      headline: `Double ${label}! +${points}`,
      detail: "Both pigs the same — that's worth way more than two.",
    };
  }

  // Mixed: different poses
  const points = POSES[a].points + POSES[b].points;
  const aLabel = isSide(a) ? null : POSES[a].label;
  const bLabel = isSide(b) ? null : POSES[b].label;
  const named = [aLabel, bLabel].filter(Boolean).join(' + ');

  return {
    type: 'mixed',
    points,
    headline: `${named}! +${points}`,
    detail: isSide(a) || isSide(b)
      ? 'A pig on its side is worth nothing, but the other one counts.'
      : 'Two different positions score the sum of both pigs.',
  };
}

/**
 * Verify distribution by running n draws.
 * Used by the odds harness and test suite.
 * @param {number} n - number of draws
 * @param {Function} rng - random number generator (default Math.random)
 * @returns {Object} tally with pose and result frequencies
 */
export function verifyDistribution(n, rng = Math.random) {
  const poseTallies = {};
  for (const key of POSE_KEYS) {
    poseTallies[key] = 0;
  }

  const resultTallies = {
    sider: 0,
    pigout: 0,
    double: 0,
    mixed: 0,
    oinker: 0,
  };

  let totalPoints = 0;

  for (let i = 0; i < n; i++) {
    const toss = drawToss(rng);

    if (toss.oinker) {
      resultTallies.oinker++;
      // For oinker, still tally that we drew two poses (but the result is oinker)
      continue;
    }

    poseTallies[toss.a]++;
    poseTallies[toss.b]++;

    const result = scoreToss(toss.a, toss.b);
    resultTallies[result.type]++;
    totalPoints += result.points;
  }

  return {
    poseTallies,
    resultTallies,
    totalPoints,
    totalDraws: n,
  };
}
