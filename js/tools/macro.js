// macro.js — Macro sentiment composite. Pure scorers (no DOM/fetch), shared by
// the Node prefetch pipeline (computes scores) and the browser (band colors).
//
// Scale: 0 = extreme fear, 100 = extreme greed / complacency.
// Every scorer is a piecewise-linear clamp between two thresholds.

export const THRESHOLDS = {
  vix:  { greed: 10,   fear: 40 },   // VIX 10 → 100, VIX 40 → 0
  term: { greed: 0.80, fear: 1.10 }, // VIX/VIX3M 0.80 → 100 (contango), 1.10 → 0 (backwardation)
  pc:   { greed: 0.70, fear: 1.30 }, // put/call 0.70 → 100, 1.30 → 0
};

// Linear map from [greedAt→100, fearAt→0], clamped to 0..100.
function scoreBetween(value, greedAt, fearAt) {
  if (!Number.isFinite(value)) return null;
  const t = (value - greedAt) / (fearAt - greedAt); // 0 at greed, 1 at fear
  const score = 100 * (1 - t);
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function scoreVixLevel(vix) {
  return scoreBetween(vix, THRESHOLDS.vix.greed, THRESHOLDS.vix.fear);
}

export function scoreTermStructure(vix, vix3m) {
  if (!Number.isFinite(vix) || !Number.isFinite(vix3m) || vix3m === 0) return null;
  return scoreBetween(vix / vix3m, THRESHOLDS.term.greed, THRESHOLDS.term.fear);
}

export function scorePutCall(pcr) {
  return scoreBetween(pcr, THRESHOLDS.pc.greed, THRESHOLDS.pc.fear);
}

// Mean of the available (non-null) component scores.
export function composite(scores) {
  const vals = scores.filter((s) => Number.isFinite(s));
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

export function bandLabel(score) {
  if (!Number.isFinite(score)) return 'Unavailable';
  if (score < 25) return 'Extreme Fear';
  if (score < 45) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Complacency';
}

// Sentiment band → palette color (fear = red, neutral = yellow, greed = green).
export function bandColor(score) {
  if (!Number.isFinite(score)) return '#888888';
  if (score < 45) return '#f87171';
  if (score <= 55) return '#facc15';
  return '#4ade80';
}

// One-word read for a component score.
export function componentRead(score) {
  if (!Number.isFinite(score)) return '—';
  if (score < 25) return 'Very fearful';
  if (score < 45) return 'Fearful';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Calm';
  return 'Complacent';
}

// ── Fed Regime 2×2 Matrix ────────────────────────────────────────────────────
// Splits Fed policy into rate level (low/high) × balance-sheet trend
// (expanding/shrinking), each quadrant implying a different equity strategy.
// Reference: rate-level and balance-sheet-trend framework as commonly used in
// macro strategy notes (e.g. 2020 ZIRP+QE → growth; 2022+ hikes+QT → value).

export const MATRIX_RATE_HIGH_THRESHOLD = 3.0; // % — rough ZIRP/restrictive-policy midline

export function rateRegime(fedFundsPct, { highThreshold = MATRIX_RATE_HIGH_THRESHOLD } = {}) {
  if (!Number.isFinite(fedFundsPct)) return null;
  return fedFundsPct >= highThreshold ? 'high' : 'low';
}

export function bsTrend(walclDeltaPct3mo) {
  if (!Number.isFinite(walclDeltaPct3mo)) return null;
  return walclDeltaPct3mo >= 0 ? 'expanding' : 'shrinking';
}

export const QUADRANTS = {
  A: {
    rate: 'low', bs: 'expanding', label: 'Growth',
    strategy: 'Money is cheap and abundant; hunt high-growth names regardless of current profitability.',
  },
  B: {
    rate: 'high', bs: 'expanding', label: 'Growth + Profitability',
    strategy: 'Policy is tightening while liquidity is backstopped through stress-driven facilities or targeted purchases, so favor growth names that also generate cash; yields can rise, though episodic backstops cap the spikes.',
  },
  C: {
    rate: 'low', bs: 'shrinking', label: 'Growth + Profitability',
    strategy: 'Rates stay low, though QT is slowly draining liquidity; blend fast growers with profitability rather than chasing pure growth.',
  },
  D: {
    rate: 'high', bs: 'shrinking', label: 'Value / Dividend Payers',
    strategy: 'Borrowing costs are high and reserves are being pulled; favor value and dividend payers, and screen for high margins and low P/E.',
  },
};

// Map (rate regime, balance-sheet trend) -> quadrant letter A-D.
export function matrixQuadrant(fedFundsPct, walclDeltaPct3mo, opts) {
  const rr = rateRegime(fedFundsPct, opts);
  const bt = bsTrend(walclDeltaPct3mo);
  if (!rr || !bt) return null;
  for (const [letter, q] of Object.entries(QUADRANTS)) {
    if (q.rate === rr && q.bs === bt) return letter;
  }
  return null;
}

// Where the market currently sits inside the 2x2 grid, as {x, y} fractions
// (0-1) of the grid box, for plotting a position dot. Matches MATRIX_LAYOUT's
// visual axes: x=0 is the Expanding (left) edge, x=1 is Shrinking (right);
// y=0 is Low Rates (top), y=1 is High Rates (bottom). Each axis saturates at
// a fixed distance from its boundary (the quadrant split) so a reading far
// from the threshold still lands near, but not on, the grid edge.
const MATRIX_BS_SATURATION = 4;   // % 3mo balance-sheet delta that maxes out the x-axis
const MATRIX_RATE_SATURATION = 3; // pp away from the threshold that maxes out the y-axis
const MATRIX_DOT_MARGIN = 0.07;   // keep the dot at least this far from any edge

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function matrixDotPosition(fedFundsPct, walclDeltaPct3mo, { highThreshold = MATRIX_RATE_HIGH_THRESHOLD } = {}) {
  if (!Number.isFinite(fedFundsPct) || !Number.isFinite(walclDeltaPct3mo)) return null;
  const xRaw = 0.5 - clamp(walclDeltaPct3mo / MATRIX_BS_SATURATION, -1, 1) * 0.5;
  const yRaw = 0.5 + clamp((fedFundsPct - highThreshold) / MATRIX_RATE_SATURATION, -1, 1) * 0.5;
  return {
    x: clamp(xRaw, MATRIX_DOT_MARGIN, 1 - MATRIX_DOT_MARGIN),
    y: clamp(yRaw, MATRIX_DOT_MARGIN, 1 - MATRIX_DOT_MARGIN),
  };
}
