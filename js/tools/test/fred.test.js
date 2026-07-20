import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFredCsv, nearestPoint, yoySeries, trimSince, thinTo, latest, deltaOverMonths } from '../fred.js';
import { rateRegime, bsTrend, matrixQuadrant, QUADRANTS } from '../macro.js';

test('parseFredCsv skips header and missing-value rows', () => {
  const csv = 'observation_date,CPIAUCSL\n2025-01-01,300.1\n2025-02-01,.\n2025-03-01,301.4\n';
  const series = parseFredCsv(csv);
  assert.deepEqual(series, [{ date: '2025-01-01', value: 300.1 }, { date: '2025-03-01', value: 301.4 }]);
});

test('nearestPoint finds closest within tolerance, null outside', () => {
  const series = [{ date: '2025-01-01', value: 1 }, { date: '2025-06-01', value: 2 }, { date: '2025-12-01', value: 3 }];
  assert.equal(nearestPoint(series, '2025-01-05', 20).value, 1);
  assert.equal(nearestPoint(series, '2025-03-01', 20), null); // too far from any point
});

test('yoySeries computes 12-month percent change', () => {
  const series = [];
  for (let m = 1; m <= 24; m++) {
    const mm = String(((m - 1) % 12) + 1).padStart(2, '0');
    const yr = 2024 + Math.floor((m - 1) / 12);
    series.push({ date: `${yr}-${mm}-01`, value: 100 + m }); // linear growth
  }
  const yoy = yoySeries(series);
  // month 13 (2025-01, value 113) vs month 1 (2024-01, value 101): (113/101 - 1) * 100
  const jan25 = yoy.find((p) => p.date === '2025-01-01');
  assert.ok(jan25);
  assert.ok(Math.abs(jan25.value - ((113 / 101 - 1) * 100)) < 0.001);
});

test('trimSince filters by cutoff date', () => {
  const series = [{ date: '2020-01-01', value: 1 }, { date: '2024-01-01', value: 2 }];
  assert.equal(trimSince(series, '2023-01-01').length, 1);
});

test('thinTo downsamples but keeps the last point', () => {
  const series = Array.from({ length: 1000 }, (_, i) => ({ date: `d${i}`, value: i }));
  const thinned = thinTo(series, 100);
  assert.ok(thinned.length <= 101);
  assert.equal(thinned[thinned.length - 1].date, 'd999');
});

test('deltaOverMonths compares latest to ~N months back', () => {
  const series = [{ date: '2025-01-01', value: 100 }, { date: '2025-04-01', value: 110 }];
  const d = deltaOverMonths(series, 3);
  assert.equal(d.latest.value, 110);
  assert.equal(d.prior.value, 100);
  assert.equal(Math.round(d.deltaPct), 10);
});

test('rateRegime + bsTrend thresholds', () => {
  assert.equal(rateRegime(3.63), 'high');
  assert.equal(rateRegime(2.9), 'low');
  assert.equal(rateRegime(3.0), 'high'); // boundary inclusive
  assert.equal(bsTrend(0.5), 'expanding');
  assert.equal(bsTrend(-0.5), 'shrinking');
  assert.equal(bsTrend(0), 'expanding'); // boundary inclusive
});

test('matrixQuadrant maps all four combinations', () => {
  assert.equal(matrixQuadrant(2.0, 1.0), 'A');   // low + expanding
  assert.equal(matrixQuadrant(4.0, 1.0), 'B');   // high + expanding
  assert.equal(matrixQuadrant(2.0, -1.0), 'C');  // low + shrinking
  assert.equal(matrixQuadrant(4.0, -1.0), 'D');  // high + shrinking
  assert.equal(matrixQuadrant(NaN, 1.0), null);
});

test('QUADRANTS has all four letters with strategy text', () => {
  for (const letter of ['A', 'B', 'C', 'D']) {
    assert.ok(QUADRANTS[letter].strategy.length > 10);
  }
});
