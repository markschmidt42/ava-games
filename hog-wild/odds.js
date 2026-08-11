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

export const DOUBLE_POINTS = {
  razorback: 20,
  trotter: 20,
  snouter: 40,
  jowler: 60,
};

/**
 * Score a pair of poses.
 *
 * Round classification vocabulary (SPEC "Presentation model" beat 2 — the names
 * the owner settled on in the demo arena). `name` is the round's NAME with no
 * points attached, which is what the reveal camera beat and the pen chips want;
 * `headline` is that name plus the score, which is what the result card wants:
 *
 *   matching siders    → "Sider"                     (1 pt, never "Double Sider")
 *   sider + scorer     → named by the scorer         "Trotter"
 *   two scorers        → "Trotter + Razorback Combo"
 *   matching scorers   → "Double Trotter Bonus"
 *   opposite siders    → "Pig Out"
 *
 * @param {string} a - first pose key
 * @param {string} b - second pose key
 * ROUND-3 REVIEW, on the copy: "the result card ships a rules tutorial in the
 * reward moment, EVERY single round: 'Two different positions score the sum of both
 * pigs. Turn total: 35.' … Both wrap to two lines in small dim text under the
 * headline. After toss three the player knows the rule; what they want is the pose
 * names and the number, big."
 *
 * So `detail` is now reserved for the two results the headline genuinely cannot
 * explain — a Pig Out (why zero) and a Sider (why only one point, in two words) —
 * and is EMPTY for every scoring round, whose headline already names both poses and
 * the number. The turn total is not repeated here either: it lives in the header
 * pill, which now animates on the reveal's arrival instead of before it.
 *
 * @returns {Object} { type: 'sider'|'pigout'|'double'|'mixed', points, name, headline, detail }
 *   `detail` may be '' — the card hides an empty line (.result-detail:empty).
 */
export function scoreToss(a, b) {
  // Both sides
  if (isSide(a) && isSide(b)) {
    if (a === b) {
      // Same side = Sider. Never "Double Sider" — matching sides are worth 1.
      return {
        type: 'sider',
        points: 1,
        name: 'Sider',
        headline: 'Sider! +1',
        detail: 'Matching sides.',
      };
    }
    // Opposite sides = Pig Out
    return {
      type: 'pigout',
      points: 0,
      name: 'Pig Out',
      headline: 'Pig Out!',
      detail: "Opposite sides — this turn's points are gone.",
    };
  }

  // Both same non-side pose = Double
  if (a === b) {
    const points = DOUBLE_POINTS[a];
    const name = `Double ${POSES[a].label} Bonus`;
    return {
      type: 'double',
      points,
      name,
      headline: `${name}! +${points}`,
      detail: '',
    };
  }

  // Mixed: one scorer (the sider adds nothing to the name), or two — a Combo.
  const points = POSES[a].points + POSES[b].points;
  const aLabel = isSide(a) ? null : POSES[a].label;
  const bLabel = isSide(b) ? null : POSES[b].label;
  const named = [aLabel, bLabel].filter(Boolean);
  const name = named.length > 1 ? `${named.join(' + ')} Combo` : named[0];

  return {
    type: 'mixed',
    points,
    name,
    headline: `${name}! +${points}`,
    detail: '',
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
