import { test } from 'node:test';
import assert from 'node:assert/strict';

import { insiderScore, skewScore, gammaRegimeScore, compositeScore, readLabel } from '../signals.js';

test('insiderScore: all buying scores 100, all selling scores 0', () => {
  const buyOnly = { filings: [{ tx: [{ date: '2026-06-01', side: 'buy', value: 100000 }] }] };
  const sellOnly = { filings: [{ tx: [{ date: '2026-06-01', side: 'sell', value: 100000 }] }] };
  assert.equal(insiderScore(buyOnly, { asOf: '2026-07-01' }), 100);
  assert.equal(insiderScore(sellOnly, { asOf: '2026-07-01' }), 0);
});

test('insiderScore: balanced buy/sell nets to neutral', () => {
  const data = { filings: [{ tx: [
    { date: '2026-06-01', side: 'buy', value: 50000 },
    { date: '2026-06-02', side: 'sell', value: 50000 },
  ] }] };
  assert.equal(insiderScore(data, { asOf: '2026-07-01' }), 50);
});

test('insiderScore: zero-value transactions (option exercises) are ignored', () => {
  const data = { filings: [{ tx: [{ date: '2026-06-01', side: 'buy', value: 0 }] }] };
  assert.equal(insiderScore(data, { asOf: '2026-07-01' }), null);
});

test('insiderScore: transactions outside the window are excluded', () => {
  const data = { filings: [{ tx: [{ date: '2025-01-01', side: 'buy', value: 100000 }] }] };
  assert.equal(insiderScore(data, { asOf: '2026-07-01', windowDays: 180 }), null);
});

test('insiderScore: no filings returns null (insufficient data, not neutral)', () => {
  assert.equal(insiderScore({ filings: [] }, { asOf: '2026-07-01' }), null);
});

test('skewScore: call-heavy OI near spot scores bullish, put-heavy scores bearish', () => {
  const contracts = [
    { strike: 100, type: 'C', oi: 1000 },
    { strike: 100, type: 'P', oi: 100 },
  ];
  assert.equal(skewScore(contracts, 100), 100); // ratio 0.1 -> clamped to greed edge (0.70)
  const bearish = [
    { strike: 100, type: 'C', oi: 100 },
    { strike: 100, type: 'P', oi: 1000 },
  ];
  assert.equal(skewScore(bearish, 100), 0);
});

test('skewScore: strikes outside the window are excluded', () => {
  const contracts = [
    { strike: 200, type: 'C', oi: 1000 }, // far OTM, outside default 15% window of spot=100
    { strike: 100, type: 'P', oi: 50 },
  ];
  assert.equal(skewScore(contracts, 100), null); // no call OI inside the window
});

test('gammaRegimeScore: net-positive dealer gamma (call-heavy OI) scores above 50', () => {
  const contracts = [
    { expiry: '2026-08-01', strike: 100, type: 'C', oi: 1000, gamma: 0.05, volume: 100 },
    { expiry: '2026-08-01', strike: 100, type: 'P', oi: 100, gamma: 0.05, volume: 100 },
  ];
  const score = gammaRegimeScore(contracts, 100, 'TEST');
  assert.ok(Number.isFinite(score) && score > 50, `expected > 50, got ${score}`);
});

test('gammaRegimeScore: no contracts returns null', () => {
  assert.equal(gammaRegimeScore([], 100, 'TEST'), null);
});

test('compositeScore: mean of available scores, ignoring nulls', () => {
  assert.equal(compositeScore([100, 0, null]), 50);
  assert.equal(compositeScore([null, null]), null);
});

test('readLabel bands', () => {
  assert.equal(readLabel(10), 'Strongly Bearish');
  assert.equal(readLabel(35), 'Bearish');
  assert.equal(readLabel(50), 'Neutral');
  assert.equal(readLabel(65), 'Bullish');
  assert.equal(readLabel(90), 'Strongly Bullish');
  assert.equal(readLabel(NaN), 'Unavailable');
});
