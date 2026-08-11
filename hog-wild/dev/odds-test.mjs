#!/usr/bin/env node

import { drawToss, scoreToss, POSES } from '../odds.js';

const NUM_DRAWS = 400_000;

// Run the simulation
console.log(`\nRunning ${NUM_DRAWS.toLocaleString()} draws through drawToss + scoreToss...\n`);

const poseTallies = {};
for (const key of Object.keys(POSES)) {
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

for (let i = 0; i < NUM_DRAWS; i++) {
  const toss = drawToss();

  if (toss.oinker) {
    resultTallies.oinker++;
    continue;
  }

  poseTallies[toss.a]++;
  poseTallies[toss.b]++;

  const result = scoreToss(toss.a, toss.b);
  resultTallies[result.type]++;
  totalPoints += result.points;
}

// Compute derived two-pig odds
const totalTosses = NUM_DRAWS;
const nonOinkerTosses = totalTosses - resultTallies.oinker;
const oinkPercentage = (resultTallies.oinker / totalTosses) * 100;
const pigoutPercentage = (resultTallies.pigout / totalTosses) * 100;
const siderPercentage = (resultTallies.sider / totalTosses) * 100;
const pointsPerToss = totalPoints / totalTosses;

// Expected values from spec
const expectedPoseFreqs = {
  'side-blank': 34.9,
  'side-dot': 30.2,
  'razorback': 22.4,
  'trotter': 8.8,
  'snouter': 3.0,
  'jowler': 0.7,
};

// Build results table
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║                    POSE FREQUENCY TABLE                         ║');
console.log('╠════════════════════════════════════════════════════════════════╣');
console.log('║ Pose          Observed    Expected    Delta (pp)   Pass/Fail   ║');
console.log('╠════════════════════════════════════════════════════════════════╣');

let allPosesPass = true;

for (const [key, expected] of Object.entries(expectedPoseFreqs)) {
  const count = poseTallies[key];
  const observed = (count / (2 * NUM_DRAWS)) * 100; // Each toss draws 2 pigs
  const delta = observed - expected;
  const tolerance = 0.5;
  const pass = Math.abs(delta) <= tolerance;
  allPosesPass = allPosesPass && pass;

  const status = pass ? '✓ PASS' : '✗ FAIL';
  const line = `║ ${key.padEnd(13)} ${observed.toFixed(2).padStart(7)}%  ${expected.toFixed(2).padStart(7)}%  ${delta > 0 ? '+' : ''}${delta.toFixed(2).padStart(6)} pp   ${status.padEnd(8)}   ║`;
  console.log(line);
}

console.log('╠════════════════════════════════════════════════════════════════╣');
console.log('║                   TWO-PIG OUTCOME TABLE                         ║');
console.log('╠════════════════════════════════════════════════════════════════╣');
console.log('║ Result           Observed    Expected    Delta (pp)   Pass/Fail ║');
console.log('╠════════════════════════════════════════════════════════════════╣');

// Check Oinker: 0.38% ± 0.1pp
const oinkExpected = 0.38;
const oinkTolerance = 0.1;
const oinkPass = Math.abs(oinkPercentage - oinkExpected) <= oinkTolerance;
const oinkStatus = oinkPass ? '✓ PASS' : '✗ FAIL';
const oinkDelta = oinkPercentage - oinkExpected;
console.log(`║ Oinker           ${oinkPercentage.toFixed(2).padStart(7)}%  ${oinkExpected.toFixed(2).padStart(7)}%  ${oinkDelta > 0 ? '+' : ''}${oinkDelta.toFixed(2).padStart(6)} pp   ${oinkStatus.padEnd(8)} ║`);

// Check Pig Out: ~21.1% ± 0.6pp
const pigoutExpected = 21.1;
const pigoutTolerance = 0.6;
const pigoutPass = Math.abs(pigoutPercentage - pigoutExpected) <= pigoutTolerance;
const pigoutStatus = pigoutPass ? '✓ PASS' : '✗ FAIL';
const pigoutDelta = pigoutPercentage - pigoutExpected;
console.log(`║ Pig Out          ${pigoutPercentage.toFixed(2).padStart(7)}%  ${pigoutExpected.toFixed(2).padStart(7)}%  ${pigoutDelta > 0 ? '+' : ''}${pigoutDelta.toFixed(2).padStart(6)} pp   ${pigoutStatus.padEnd(8)} ║`);

// Check Sider: ~21.3% ± 0.6pp
const siderExpected = 21.3;
const siderTolerance = 0.6;
const siderPass = Math.abs(siderPercentage - siderExpected) <= siderTolerance;
const siderStatus = siderPass ? '✓ PASS' : '✗ FAIL';
const siderDelta = siderPercentage - siderExpected;
console.log(`║ Sider            ${siderPercentage.toFixed(2).padStart(7)}%  ${siderExpected.toFixed(2).padStart(7)}%  ${siderDelta > 0 ? '+' : ''}${siderDelta.toFixed(2).padStart(6)} pp   ${siderStatus.padEnd(8)} ║`);

// Check other results (for reference, no hard tolerance)
const doublePercentage = (resultTallies.double / totalTosses) * 100;
const mixedPercentage = (resultTallies.mixed / totalTosses) * 100;
console.log(`║ Double (all)     ${doublePercentage.toFixed(2).padStart(7)}%                              ║`);
console.log(`║ Mixed            ${mixedPercentage.toFixed(2).padStart(7)}%                              ║`);

console.log('╠════════════════════════════════════════════════════════════════╣');
console.log('║                    EXPECTED VALUE CHECK                         ║');
console.log('╠════════════════════════════════════════════════════════════════╣');

const evExpected = 4.7;
const evTolerance = 0.15;
const evPass = Math.abs(pointsPerToss - evExpected) <= evTolerance;
const evStatus = evPass ? '✓ PASS' : '✗ FAIL';
const evDelta = pointsPerToss - evExpected;
console.log(`║ Points per toss  ${pointsPerToss.toFixed(2).padStart(7)}   ${evExpected.toFixed(2).padStart(7)}   ${evDelta > 0 ? '+' : ''}${evDelta.toFixed(2).padStart(6)} pp   ${evStatus.padEnd(8)} ║`);

console.log('╚════════════════════════════════════════════════════════════════╝');

// Overall result
const allPass = allPosesPass && oinkPass && pigoutPass && siderPass && evPass;

console.log(`\nOverall result: ${allPass ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);

process.exit(allPass ? 0 : 1);
