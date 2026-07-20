import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreVixLevel, scoreTermStructure, scorePutCall,
  composite, bandLabel, bandColor, matrixDotPosition,
} from '../macro.js';

test('scoreVixLevel clamps between thresholds', () => {
  assert.equal(scoreVixLevel(10), 100);  // greed edge
  assert.equal(scoreVixLevel(40), 0);    // fear edge
  assert.equal(scoreVixLevel(25), 50);   // midpoint
  assert.equal(scoreVixLevel(5), 100);   // clamped
  assert.equal(scoreVixLevel(60), 0);    // clamped
});

test('scoreTermStructure: contango greedy, backwardation fearful', () => {
  assert.equal(scoreTermStructure(16, 20), 100); // ratio 0.80 -> full greed
  assert.equal(scoreTermStructure(22, 20), 0);   // ratio 1.10 -> full fear
  assert.equal(scoreTermStructure(19, 20), scoreTermStructure(19, 20)); // finite
  assert.equal(scoreTermStructure(20, 0), null); // guard divide-by-zero
});

test('scorePutCall: low ratio greedy, high ratio fearful', () => {
  assert.equal(scorePutCall(0.70), 100);
  assert.equal(scorePutCall(1.30), 0);
  assert.equal(scorePutCall(1.00), 50);
});

test('composite ignores nulls, averages the rest', () => {
  assert.equal(composite([100, 0, null]), 50);
  assert.equal(composite([null, null, null]), null);
  assert.equal(composite([60]), 60);
});

test('bandLabel + bandColor bands', () => {
  assert.equal(bandLabel(10), 'Extreme Fear');
  assert.equal(bandLabel(35), 'Fear');
  assert.equal(bandLabel(50), 'Neutral');
  assert.equal(bandLabel(65), 'Greed');
  assert.equal(bandLabel(90), 'Complacency');
  assert.equal(bandColor(10), '#f87171');
  assert.equal(bandColor(50), '#facc15');
  assert.equal(bandColor(90), '#4ade80');
});

test('matrixDotPosition: at the threshold/boundary sits at the center', () => {
  const pos = matrixDotPosition(3.0, 0, { highThreshold: 3.0 });
  assert.equal(pos.x, 0.5);
  assert.equal(pos.y, 0.5);
});

test('matrixDotPosition: saturates near but not on the edges', () => {
  // Deep in "high rates, strongly expanding" territory -> bottom-left corner.
  const hot = matrixDotPosition(30, 30, { highThreshold: 3.0 });
  assert.ok(Math.abs(hot.x - 0.07) < 1e-9); // strongly expanding -> low x
  assert.ok(Math.abs(hot.y - 0.93) < 1e-9); // deep in "high" rate territory -> near bottom edge
  // Deep in "low rates, strongly shrinking" territory -> top-right corner.
  const cold = matrixDotPosition(-30, -30, { highThreshold: 3.0 });
  assert.ok(Math.abs(cold.x - 0.93) < 1e-9); // strongly shrinking -> high x
  assert.ok(Math.abs(cold.y - 0.07) < 1e-9); // deep in "low" rate territory -> near top edge
  // Never touches the true edge (0 or 1), always inside the margin.
  for (const p of [hot, cold]) {
    assert.ok(p.x >= 0.07 && p.x <= 0.93);
    assert.ok(p.y >= 0.07 && p.y <= 0.93);
  }
});

test('matrixDotPosition: matches current site data (high rates, expanding balance sheet)', () => {
  // 3.63% fed funds, +0.56% 3mo balance-sheet delta -> just past the rate
  // threshold (y = 0.5 + 0.63/3 * 0.5 = 0.605) and mildly expanding
  // (x = 0.5 - 0.5567/4 * 0.5 ≈ 0.430).
  const pos = matrixDotPosition(3.63, 0.5567207341340863, { highThreshold: 3.0 });
  assert.ok(Math.abs(pos.y - 0.605) < 1e-6);
  assert.ok(pos.x < 0.5 && pos.x > 0.4);
});

test('matrixDotPosition returns null on missing data', () => {
  assert.equal(matrixDotPosition(NaN, 1.0), null);
  assert.equal(matrixDotPosition(3.0, NaN), null);
});
