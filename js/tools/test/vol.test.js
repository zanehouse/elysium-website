import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VOL_DEFAULTS, usableIvQuote, buildSmiles, ivAtMoneyness, atmIv, oiWeightedIv,
  skewAtMoneyness, skewSlope, termStructure, interpolateAtmIv, termSlope,
  referenceSmile, surfaceGrid, analyzeChain,
  varianceInterp, fillGridInTime, densifyGrid, ivColorDomain,
  niceTicks, dteTicks, countIvQuotes,
} from '../vol.js';

// A bare lattice in the shape surfaceGrid() returns, for the fill/densify tests.
function lattice(moneyness, rows) {
  const dtes = rows.map((r) => r.dte);
  return {
    moneyness,
    rows: rows.map((r) => ({ date: r.date || `d${r.dte}`, dte: r.dte, t: r.dte / 365, values: r.values })),
    dteMin: Math.min(...dtes),
    dteMax: Math.max(...dtes),
    cells: rows.length * moneyness.length,
  };
}

const TODAY = '2026-07-30';
const SPOT = 100;

// Build a chain row. Strikes are absolute; the caller keeps them OTM-consistent.
function row(expiry, type, strike, iv, oi = 500) {
  return { expiry, type, strike, oi, gamma: 0.01, volume: 10, ...(iv == null ? {} : { iv }) };
}

// A well-formed symmetric smile straddling spot, 7 points.
function smileChain(expiry, atm = 0.30, slope = -0.10) {
  const out = [];
  for (const m of [-0.15, -0.10, -0.05, 0, 0.05, 0.10, 0.15]) {
    const iv = atm + slope * m * 10;              // linear in moneyness
    const k = SPOT * (1 + m);
    if (m < 0) out.push(row(expiry, 'P', k, iv));
    else if (m > 0) out.push(row(expiry, 'C', k, iv));
    else { out.push(row(expiry, 'P', k, iv)); }    // exactly at spot
  }
  return out;
}

// ── usableIvQuote ───────────────────────────────────────────────────────────
test('usableIvQuote keeps out-of-the-money quotes only', () => {
  assert.equal(usableIvQuote(row('x', 'C', 110, 0.3), SPOT), true, 'OTM call');
  assert.equal(usableIvQuote(row('x', 'P', 90, 0.3), SPOT), true, 'OTM put');
  assert.equal(usableIvQuote(row('x', 'C', 90, 0.3), SPOT), false, 'ITM call rejected');
  assert.equal(usableIvQuote(row('x', 'P', 110, 0.3), SPOT), false, 'ITM put rejected');
  assert.equal(usableIvQuote(row('x', 'C', 100, 0.3), SPOT), true, 'call at spot');
  assert.equal(usableIvQuote(row('x', 'P', 100, 0.3), SPOT), true, 'put at spot');
});

test('usableIvQuote rejects absent, zero, and out-of-range iv', () => {
  assert.equal(usableIvQuote(row('x', 'C', 110, null), SPOT), false, 'no iv key');
  assert.equal(usableIvQuote(row('x', 'C', 110, 0), SPOT), false, 'CBOE no-quote sentinel');
  assert.equal(usableIvQuote(row('x', 'C', 110, 0.005), SPOT), false, 'below minIv');
  assert.equal(usableIvQuote(row('x', 'C', 110, 4.5), SPOT), false, 'above maxIv');
  assert.equal(usableIvQuote(row('x', 'C', 110, 0.3), 0), false, 'no spot');
});

// ── buildSmiles ─────────────────────────────────────────────────────────────
test('buildSmiles produces a strike-sorted smile with moneyness', () => {
  const smiles = buildSmiles(smileChain('2026-08-14'), SPOT, TODAY);
  assert.equal(smiles.length, 1);
  const s = smiles[0];
  assert.equal(s.date, '2026-08-14');
  assert.equal(s.dte, 15);
  assert.equal(s.n, 7);
  assert.ok(Math.abs(s.strikeMin - 85) < 1e-9, `strikeMin ${s.strikeMin}`);
  assert.ok(Math.abs(s.strikeMax - 115) < 1e-9, `strikeMax ${s.strikeMax}`);
  const strikes = s.points.map((p) => p.strike);
  assert.deepEqual(strikes, [...strikes].sort((a, b) => a - b), 'sorted by strike');
  assert.ok(Math.abs(s.points[3].moneyness) < 1e-12, 'spot strike is moneyness 0');
});

test('buildSmiles excludes same-day expiries entirely', () => {
  // 0DTE IV is a rounding artifact, not a volatility — see the vol.js header.
  const chain = [...smileChain(TODAY), ...smileChain('2026-08-14')];
  const smiles = buildSmiles(chain, SPOT, TODAY);
  assert.equal(smiles.length, 1);
  assert.equal(smiles[0].date, '2026-08-14');
});

test('buildSmiles drops expiries below minPointsPerExpiry', () => {
  // Real shape: AAPL 2026-08-10 came back with only 2 usable OTM quotes.
  const thin = [row('2026-08-10', 'P', 99.9, 0.33), row('2026-08-10', 'C', 104, 0.32)];
  assert.deepEqual(buildSmiles(thin, SPOT, TODAY), []);
});

test('buildSmiles merges a call and put at the same strike by open interest', () => {
  const chain = [
    ...smileChain('2026-08-14'),
    row('2026-08-14', 'C', 100, 0.40, 1500),   // pairs with the put already at 100
  ];
  const s = buildSmiles(chain, SPOT, TODAY)[0];
  const at = s.points.find((p) => p.strike === 100);
  assert.equal(at.type, 'B', 'flagged as blended');
  assert.equal(at.oi, 2000, 'open interest summed');
  // put 0.30 @ oi 500, call 0.40 @ oi 1500 -> 0.375
  assert.ok(Math.abs(at.iv - 0.375) < 1e-12, `expected 0.375, got ${at.iv}`);
  assert.equal(s.n, 7, 'still 7 distinct strikes');
});

test('buildSmiles returns [] on an all-pre-IV chain', () => {
  const noIv = smileChain('2026-08-14').map((c) => { const { iv, ...rest } = c; return rest; });
  assert.deepEqual(buildSmiles(noIv, SPOT, TODAY), []);
});

test('buildSmiles sorts expiries by DTE', () => {
  const chain = [...smileChain('2026-09-18'), ...smileChain('2026-08-07'), ...smileChain('2026-08-21')];
  const dtes = buildSmiles(chain, SPOT, TODAY).map((s) => s.dte);
  assert.deepEqual(dtes, [8, 22, 50]);
});

// ── Interpolation ───────────────────────────────────────────────────────────
test('ivAtMoneyness interpolates at and between knots', () => {
  const s = buildSmiles(smileChain('2026-08-14', 0.30, -0.10), SPOT, TODAY)[0];
  assert.ok(Math.abs(ivAtMoneyness(s, 0) - 0.30) < 1e-12, 'exactly at a knot');
  // knots at m=0 (0.30) and m=0.05 (0.25); midpoint m=0.025 -> 0.275
  assert.ok(Math.abs(ivAtMoneyness(s, 0.025) - 0.275) < 1e-12, 'midway between knots');
});

test('ivAtMoneyness never extrapolates', () => {
  const s = buildSmiles(smileChain('2026-08-14'), SPOT, TODAY)[0];
  assert.equal(ivAtMoneyness(s, -0.20), null, 'below covered range');
  assert.equal(ivAtMoneyness(s, 0.20), null, 'above covered range');
  assert.equal(ivAtMoneyness(s, NaN), null, 'non-finite target');
});

// The measured SPY 2026-08-10 shape: enough points to clear the count filter,
// but every one of them above spot, so there is no ATM to read.
test('atmIv returns null when the smile does not straddle spot', () => {
  const oneSided = [
    row('2026-08-10', 'C', 101, 0.31), row('2026-08-10', 'C', 104, 0.32),
    row('2026-08-10', 'C', 108, 0.34), row('2026-08-10', 'C', 111, 0.36),
    row('2026-08-10', 'C', 114, 0.38),
  ];
  const s = buildSmiles(oneSided, SPOT, TODAY)[0];
  assert.ok(s, 'the smile itself still builds');
  assert.equal(s.n, 5, 'and clears minPointsPerExpiry');
  assert.equal(atmIv(s), null, 'but has no ATM reading');
});

test('oiWeightedIv weights by open interest', () => {
  const chain = [row('2026-08-14', 'P', 90, 0.40, 100), row('2026-08-14', 'P', 95, 0.40, 100),
    row('2026-08-14', 'C', 105, 0.20, 300), row('2026-08-14', 'C', 110, 0.20, 300)];
  const s = buildSmiles(chain, SPOT, TODAY)[0];
  // (0.40*200 + 0.20*600) / 800 = 0.25
  assert.ok(Math.abs(oiWeightedIv(s) - 0.25) < 1e-12);
});

// ── Skew ────────────────────────────────────────────────────────────────────
test('skewAtMoneyness measures put wing minus call wing', () => {
  const s = buildSmiles(smileChain('2026-08-14', 0.30, -0.10), SPOT, TODAY)[0];
  // iv(-0.10) = 0.40, iv(+0.10) = 0.20
  assert.ok(Math.abs(skewAtMoneyness(s, 0.10) - 0.20) < 1e-12);
});

test('skewAtMoneyness returns null when the OI floor ate a wing', () => {
  // Call side stops at +6%, so a ±10% reading is unavailable — measured on
  // roughly a fifth of live expiries.
  const clipped = [
    row('2026-08-14', 'P', 85, 0.40), row('2026-08-14', 'P', 90, 0.37),
    row('2026-08-14', 'P', 95, 0.34), row('2026-08-14', 'C', 103, 0.29),
    row('2026-08-14', 'C', 106, 0.28),
  ];
  const s = buildSmiles(clipped, SPOT, TODAY)[0];
  assert.equal(skewAtMoneyness(s, 0.10), null);
  assert.ok(skewAtMoneyness(s, 0.05) !== null, 'the narrower reading still works');
});

test('skewSlope recovers an exact slope in standardized moneyness', () => {
  // Construct iv linear in z = ln(K/S)/(atm*sqrt(T)) so OLS must fit perfectly.
  const date = '2026-08-29', dte = 30, t = dte / 365, atm = 0.40, slope = -0.05;
  const chain = [];
  for (const z of [-2, -1, -0.5, 0, 0.5, 1, 2]) {
    const k = SPOT * Math.exp(z * atm * Math.sqrt(t));
    const iv = atm + slope * z;
    chain.push(row(date, k < SPOT ? 'P' : 'C', k, iv));
  }
  const s = buildSmiles(chain, SPOT, TODAY)[0];
  const res = skewSlope(s);
  assert.ok(res, 'slope computed');
  assert.ok(Math.abs(res.slope - slope) < 1e-9, `expected ${slope}, got ${res.slope}`);
  assert.ok(Math.abs(res.r2 - 1) < 1e-9, `perfect fit, got r2=${res.r2}`);
  assert.equal(res.n, 7);
});

// The comparability guarantee. A live proxy lookup returns the whole strike
// board while the committed chains are clipped to ±25% of spot, so an unbounded
// fit would give two different answers for the same smile depending only on
// which path supplied it. Measured on a live PANW board: the −77% moneyness
// wing printed 247% IV and dragged the slope to −0.154 on a smile that is
// nearly flat near the money.
test('skewSlope clips far wings so the slope means the same on any board', () => {
  const date = '2026-08-29', dte = 30, t = dte / 365, atm = 0.40, slope = -0.05;
  const core = [];
  for (const z of [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]) {
    const k = SPOT * Math.exp(z * atm * Math.sqrt(t));
    core.push(row(date, k < SPOT ? 'P' : 'C', k, atm + slope * z));
  }
  // A far put wing with a wildly elevated quote, as an unfiltered board carries.
  const wing = [];
  for (const z of [-7, -5.5, -4]) {
    const k = SPOT * Math.exp(z * atm * Math.sqrt(t));
    wing.push(row(date, 'P', k, atm + slope * z + 1.2));
  }

  const clean = skewSlope(buildSmiles(core, SPOT, TODAY)[0]);
  const withWing = skewSlope(buildSmiles([...core, ...wing], SPOT, TODAY)[0]);

  assert.ok(Math.abs(clean.slope - slope) < 1e-9, 'clean board recovers the slope');
  assert.equal(withWing.clipped, 3, 'the three far-wing quotes were excluded');
  assert.ok(Math.abs(withWing.slope - slope) < 1e-9,
    `wing must not move the slope: ${clean.slope} vs ${withWing.slope}`);
  assert.ok(withWing.zMin >= -2 - 1e-9 && withWing.zMax <= 2 + 1e-9, 'fit stayed inside ±2σ');
});

test('skewSlope returns null when clipping leaves too few points', () => {
  // Every quote sits beyond ±2σ, so there is no window left to fit.
  const date = '2026-08-29', t = 30 / 365, atm = 0.40;
  const far = [];
  for (const z of [-6, -5, -4, -3]) {
    const k = SPOT * Math.exp(z * atm * Math.sqrt(t));
    far.push(row(date, 'P', k, 1.5));
  }
  // Give it an ATM anchor so the null comes from clipping, not a missing ATM.
  far.push(row(date, 'P', SPOT, atm), row(date, 'C', SPOT * 1.001, atm));
  const s = buildSmiles(far, SPOT, TODAY)[0];
  assert.equal(skewSlope(s), null);
});

test('skewSlope returns null without an ATM level to normalise by', () => {
  const oneSided = [
    row('2026-08-14', 'C', 101, 0.31), row('2026-08-14', 'C', 104, 0.32),
    row('2026-08-14', 'C', 108, 0.34), row('2026-08-14', 'C', 111, 0.36),
  ];
  const s = buildSmiles(oneSided, SPOT, TODAY)[0];
  assert.equal(skewSlope(s), null);
});

// ── Term structure ──────────────────────────────────────────────────────────
test('termStructure drops expiries with no ATM and stays DTE-sorted', () => {
  const chain = [
    ...smileChain('2026-09-18', 0.28),
    ...smileChain('2026-08-07', 0.35),
    // one-sided: builds a smile, but contributes no ATM point
    row('2026-08-21', 'C', 101, 0.31), row('2026-08-21', 'C', 104, 0.32),
    row('2026-08-21', 'C', 108, 0.34), row('2026-08-21', 'C', 111, 0.36),
  ];
  const term = termStructure(buildSmiles(chain, SPOT, TODAY));
  assert.deepEqual(term.map((p) => p.dte), [8, 50]);
  assert.ok(Math.abs(term[0].atmIv - 0.35) < 1e-12);
});

// This is the test that pins the convention. Linear-in-sigma would give 25.9%;
// linear-in-variance (the VIX method) gives ~26.6%.
test('interpolateAtmIv interpolates in variance time, not in sigma', () => {
  const term = [{ dte: 7, atmIv: 0.20 }, { dte: 60, atmIv: 0.30 }];
  const got = interpolateAtmIv(term, 30);
  assert.equal(got.method, 'interp');
  const va = 0.20 * 0.20 * 7, vb = 0.30 * 0.30 * 60;
  const expected = Math.sqrt((va + (vb - va) * ((30 - 7) / (60 - 7))) / 30);
  assert.ok(Math.abs(got.iv - expected) < 1e-12, `expected ${expected}, got ${got.iv}`);

  const naive = 0.20 + (0.30 - 0.20) * ((30 - 7) / (60 - 7));
  assert.ok(Math.abs(got.iv - naive) > 5e-3, 'and is meaningfully different from linear-in-sigma');
});

test('interpolateAtmIv returns the level on a flat term structure', () => {
  const term = [{ dte: 7, atmIv: 0.25 }, { dte: 60, atmIv: 0.25 }];
  assert.ok(Math.abs(interpolateAtmIv(term, 30).iv - 0.25) < 1e-12);
});

test('interpolateAtmIv never extrapolates outside the listed range', () => {
  const term = [{ dte: 10, atmIv: 0.22 }, { dte: 45, atmIv: 0.28 }];
  const short = interpolateAtmIv(term, 5);
  assert.equal(short.method, 'nearest');
  assert.equal(short.iv, 0.22);
  const long = interpolateAtmIv(term, 400);
  assert.equal(long.method, 'nearest');
  assert.equal(long.iv, 0.28);
  assert.equal(interpolateAtmIv([], 30), null);
});

test('termSlope classifies contango, backwardation and flat', () => {
  assert.equal(termSlope([{ dte: 5, atmIv: 0.60 }, { dte: 60, atmIv: 0.30 }], 30).shape,
    'backwardation', 'event-driven front-loaded vol');
  assert.equal(termSlope([{ dte: 5, atmIv: 0.15 }, { dte: 60, atmIv: 0.25 }], 30).shape,
    'contango', 'calm upward-sloping curve');
  assert.equal(termSlope([{ dte: 5, atmIv: 0.20 }, { dte: 60, atmIv: 0.20 }], 30).shape,
    'flat');
  assert.equal(termSlope([], 30), null);
});

// ── referenceSmile ──────────────────────────────────────────────────────────
test('referenceSmile picks the expiry nearest the target tenor, not the front', () => {
  const chain = [
    ...smileChain('2026-07-31', 0.60),   // 1d — the noisy front
    ...smileChain('2026-08-28', 0.30),   // 29d — nearest 30
    ...smileChain('2026-09-18', 0.28),   // 50d
  ];
  const ref = referenceSmile(buildSmiles(chain, SPOT, TODAY));
  assert.equal(ref.dte, 29);
});

test('referenceSmile prefers an expiry that actually has an ATM level', () => {
  const chain = [
    // 30d exactly, but entirely one-sided: no ATM to anchor a skew reading
    row('2026-08-29', 'C', 101, 0.31), row('2026-08-29', 'C', 104, 0.32),
    row('2026-08-29', 'C', 108, 0.34), row('2026-08-29', 'C', 111, 0.36),
    ...smileChain('2026-09-18', 0.28),  // 50d, well formed
  ];
  const ref = referenceSmile(buildSmiles(chain, SPOT, TODAY));
  assert.equal(ref.dte, 50, 'skips the ATM-less expiry despite it being closer');
});

test('referenceSmile handles an empty surface', () => {
  assert.equal(referenceSmile([]), null);
  assert.equal(referenceSmile(null), null);
});

// ── surfaceGrid ─────────────────────────────────────────────────────────────
test('surfaceGrid resamples every expiry onto shared moneyness columns', () => {
  const chain = [...smileChain('2026-08-07', 0.35), ...smileChain('2026-09-18', 0.28)];
  const g = surfaceGrid(buildSmiles(chain, SPOT, TODAY), { cols: 7, moneynessSpan: 0.15 });
  assert.ok(g, 'grid built');
  assert.equal(g.rows.length, 2);
  assert.equal(g.moneyness.length, 7);
  assert.ok(Math.abs(g.moneyness[0] + 0.15) < 1e-12, 'spans the low edge');
  assert.ok(Math.abs(g.moneyness[6] - 0.15) < 1e-12, 'spans the high edge');
  assert.ok(Math.abs(g.moneyness[3]) < 1e-12, 'centre column is at the money');
  assert.equal(g.rows[0].values.length, 7);
  assert.equal(g.cells, 14);
  assert.ok(Math.abs(g.rows[0].values[3] - 0.35) < 1e-12, 'ATM value lands on the centre column');

  // The outermost columns sit at exactly ±15%, and a real board almost never
  // lists a strike on that exact boundary — here the top strike is 114.999…, a
  // hair inside it. So the edge column is null and the surface ends slightly
  // narrower than the sampled span. That is the ragged edge doing its job, not
  // a gap to be filled.
  assert.equal(g.covered, 12);
  assert.equal(g.rows[0].values[6], null, 'top edge column is outside the listed strikes');
  assert.ok(g.rows[0].values[5] !== null, 'the column inside it resolves');
});

// The ragged edge is the point: a cell outside an expiry's listed strikes is
// null so the renderer can drop that quad, rather than a fabricated wing.
test('surfaceGrid leaves uncovered cells null instead of extrapolating', () => {
  const narrow = [
    row('2026-08-14', 'P', 96, 0.33), row('2026-08-14', 'P', 98, 0.32),
    row('2026-08-14', 'C', 102, 0.30), row('2026-08-14', 'C', 104, 0.29),
  ];
  const g = surfaceGrid(
    [...buildSmiles(narrow, SPOT, TODAY), ...buildSmiles(smileChain('2026-09-18'), SPOT, TODAY)],
    { cols: 7, moneynessSpan: 0.15 },
  );
  const narrowRow = g.rows.find((r) => r.date === '2026-08-14');
  assert.equal(narrowRow.values[0], null, 'far put column uncovered');
  assert.equal(narrowRow.values[6], null, 'far call column uncovered');
  assert.ok(narrowRow.values[3] !== null, 'the covered centre still resolves');
  assert.ok(g.covered < g.cells, 'coverage is reported as partial');
});

test('surfaceGrid thins expiries in log time, keeping both ends', () => {
  const dates = ['2026-08-01', '2026-08-04', '2026-08-08', '2026-08-20',
    '2026-09-15', '2026-11-10', '2027-02-10', '2027-08-10'];
  const chain = dates.flatMap((d) => smileChain(d, 0.3));
  const smiles = buildSmiles(chain, SPOT, TODAY);
  assert.equal(smiles.length, 8);
  const g = surfaceGrid(smiles, { cols: 5, maxRows: 4 });
  assert.equal(g.rows.length, 4, 'thinned to the cap');
  assert.equal(g.rows[0].date, '2026-08-01', 'front kept');
  assert.equal(g.rows[3].date, '2027-08-10', 'back kept');
  // Log spacing must keep a near-dated row; even-in-days would jump to months.
  assert.ok(g.rows[1].dte <= 21, `expected a near-dated second row, got ${g.rows[1].dte}d`);
  assert.deepEqual(g.rows.map((r) => r.dte), [...g.rows.map((r) => r.dte)].sort((a, b) => a - b));
});

test('surfaceGrid reports the IV range for the colour ramp', () => {
  const chain = [...smileChain('2026-08-07', 0.40), ...smileChain('2026-09-18', 0.20)];
  const g = surfaceGrid(buildSmiles(chain, SPOT, TODAY), { cols: 5 });
  assert.ok(g.ivMin > 0 && g.ivMax > g.ivMin, `range ${g.ivMin}..${g.ivMax}`);
  const all = g.rows.flatMap((r) => r.values).filter((v) => v !== null);
  assert.ok(Math.abs(g.ivMin - Math.min(...all)) < 1e-12);
  assert.ok(Math.abs(g.ivMax - Math.max(...all)) < 1e-12);
});

test('surfaceGrid returns null when there is no surface to draw', () => {
  assert.equal(surfaceGrid([]), null, 'no smiles');
  assert.equal(surfaceGrid(null), null, 'not an array');
  assert.equal(surfaceGrid(buildSmiles(smileChain('2026-08-14'), SPOT, TODAY)), null,
    'a single expiry is a curve, not a surface');
  // Two expiries whose strikes sit entirely outside the sampled window.
  const far = [
    row('2026-08-14', 'C', 140, 0.3), row('2026-08-14', 'C', 150, 0.3),
    row('2026-08-14', 'C', 160, 0.3), row('2026-08-14', 'C', 170, 0.3),
    row('2026-09-18', 'C', 140, 0.3), row('2026-09-18', 'C', 150, 0.3),
    row('2026-09-18', 'C', 160, 0.3), row('2026-09-18', 'C', 170, 0.3),
  ];
  assert.equal(surfaceGrid(buildSmiles(far, SPOT, TODAY), { moneynessSpan: 0.15 }), null,
    'nothing lands inside the sampled window');
});

// ── varianceInterp ──────────────────────────────────────────────────────────
test('varianceInterp reproduces a sample exactly at its own tenor', () => {
  const s = [{ dte: 10, iv: 0.40 }, { dte: 40, iv: 0.20 }];
  assert.ok(Math.abs(varianceInterp(s, 10) - 0.40) < 1e-12);
  assert.ok(Math.abs(varianceInterp(s, 40) - 0.20) < 1e-12);
});

test('varianceInterp interpolates total variance, not volatility', () => {
  // w = iv^2*dte: 0.40^2*10 = 1.6 and 0.20^2*40 = 1.6 — total variance is FLAT,
  // so every tenor between must price at sqrt(1.6/dte), never the linear-in-vol
  // midpoint of 0.30. This is the test that pins the convention.
  const s = [{ dte: 10, iv: 0.40 }, { dte: 40, iv: 0.20 }];
  const got = varianceInterp(s, 25);
  assert.ok(Math.abs(got - Math.sqrt(1.6 / 25)) < 1e-12, `got ${got}`);
  assert.ok(Math.abs(got - 0.2529822128) < 1e-9, `got ${got}`);
  assert.ok(Math.abs(got - 0.30) > 0.04, 'and is nowhere near the linear-in-vol answer');
});

test('varianceInterp never extrapolates', () => {
  const s = [{ dte: 10, iv: 0.40 }, { dte: 40, iv: 0.20 }];
  assert.equal(varianceInterp(s, 9.9), null, 'below the first sample');
  assert.equal(varianceInterp(s, 40.1), null, 'above the last sample');
});

test('varianceInterp handles degenerate input', () => {
  assert.equal(varianceInterp([{ dte: 10, iv: 0.4 }], 10), 0.4, 'lone sample at its own tenor');
  assert.equal(varianceInterp([{ dte: 10, iv: 0.4 }], 20), null, 'lone sample elsewhere');
  assert.equal(varianceInterp([], 10), null);
  assert.equal(varianceInterp(null, 10), null);
  assert.equal(varianceInterp([{ dte: 10, iv: 0.4 }, { dte: 40, iv: 0.2 }], NaN), null);
  assert.equal(varianceInterp([{ dte: 10, iv: 0 }, { dte: 40, iv: 0.2 }], 25), null,
    'a zero-vol sample is dropped, leaving one — no bracket');
});

// ── fillGridInTime ──────────────────────────────────────────────────────────
test('fillGridInTime fills a hole bracketed in the same column', () => {
  const g = lattice([-0.05, 0, 0.05], [
    { dte: 10, values: [0.40, 0.30, 0.28] },
    { dte: 25, values: [null, 0.30, 0.28] },   // put wing missing on this expiry
    { dte: 40, values: [0.20, 0.30, 0.28] },
  ]);
  const f = fillGridInTime(g);
  assert.equal(f.quoted, 8);
  assert.equal(f.interpolated, 1);
  assert.equal(f.covered, 9);
  assert.equal(f.cells, 9);
  assert.ok(Math.abs(f.rows[1].values[0] - Math.sqrt(1.6 / 25)) < 1e-12, 'variance-interpolated');
  assert.equal(f.rows[1].filled[0], true, 'and marked as filled');
  assert.equal(f.rows[0].filled[0], false, 'quoted cells are not marked');
});

// The case that proves the wings are not invented.
test('fillGridInTime leaves an unbracketed edge null', () => {
  const g = lattice([-0.05, 0], [
    { dte: 10, values: [null, 0.30] },   // no quote BELOW to bracket against
    { dte: 25, values: [0.35, 0.30] },
    { dte: 40, values: [null, 0.30] },   // and none ABOVE
  ]);
  const f = fillGridInTime(g);
  assert.equal(f.rows[0].values[0], null, 'first row stays null');
  assert.equal(f.rows[2].values[0], null, 'last row stays null');
  assert.equal(f.interpolated, 0);
  assert.equal(f.covered, f.quoted);
});

test('fillGridInTime widens ivMin/ivMax to include filled values', () => {
  const g = lattice([0], [
    { dte: 10, values: [0.40] },
    { dte: 25, values: [null] },
    { dte: 40, values: [0.20] },
  ]);
  const f = fillGridInTime(g);
  const mid = f.rows[1].values[0];
  assert.ok(mid > 0.20 && mid < 0.40);
  assert.ok(Math.abs(f.ivMin - 0.20) < 1e-12);
  assert.ok(Math.abs(f.ivMax - 0.40) < 1e-12);
});

test('fillGridInTime returns null when nothing was quoted', () => {
  assert.equal(fillGridInTime(lattice([0], [{ dte: 10, values: [null] }])), null);
  assert.equal(fillGridInTime(null), null);
});

// ── densifyGrid ─────────────────────────────────────────────────────────────
test('densifyGrid resamples onto a lattice uniform in log time', () => {
  const g = lattice([-0.05, 0, 0.05], [
    { dte: 1, values: [0.60, 0.50, 0.55] },
    { dte: 30, values: [0.34, 0.30, 0.32] },
    { dte: 365, values: [0.26, 0.25, 0.26] },
  ]);
  const d = densifyGrid(g, { rows: 49 });
  assert.equal(d.rows.length, 49);
  assert.equal(d.rows[0].dte, 1, 'front endpoint pinned exactly');
  assert.equal(d.rows[48].dte, 365, 'back endpoint pinned exactly');

  // Constant ratio between consecutive tenors is the whole point.
  const steps = [];
  for (let i = 1; i < 48; i++) steps.push(Math.log(d.rows[i].dte) - Math.log(d.rows[i - 1].dte));
  const first = steps[0];
  for (const s of steps) assert.ok(Math.abs(s - first) < 1e-12, `log step drift: ${s} vs ${first}`);
});

test('densifyGrid reproduces listed values at listed tenors', () => {
  const g = lattice([0], [
    { dte: 10, values: [0.40] }, { dte: 100, values: [0.25] },
  ]);
  const d = densifyGrid(g, { rows: 3 });
  assert.ok(Math.abs(d.rows[0].values[0] - 0.40) < 1e-12);
  assert.ok(Math.abs(d.rows[2].values[0] - 0.25) < 1e-12);
});

test('densifyGrid keeps the listed expiries for hover', () => {
  const g = lattice([0], [
    { date: '2026-08-07', dte: 8, values: [0.35] },
    { date: '2026-09-18', dte: 50, values: [0.28] },
  ]);
  const d = densifyGrid(g, { rows: 9 });
  assert.deepEqual(d.listed, [
    { date: '2026-08-07', dte: 8 }, { date: '2026-09-18', dte: 50 },
  ]);
  assert.equal(d.rows[0].date, undefined, 'synthetic rows carry no date');
});

test('densifyGrid will not spread a single-sample column across time', () => {
  const g = lattice([-0.05, 0], [
    { dte: 10, values: [0.40, 0.30] },
    { dte: 100, values: [null, 0.25] },   // column 0 has only one quote
  ]);
  const d = densifyGrid(g, { rows: 5 });
  // Row 0 sits at dte 10 exactly, so it reports the real quote — that is the
  // quote itself, not interpolation. Every synthetic tenor after it is null,
  // because one sample cannot bracket anything.
  assert.ok(Math.abs(d.rows[0].values[0] - 0.40) < 1e-12, 'the real quote survives at its own tenor');
  for (let i = 1; i < d.rows.length; i++) {
    assert.equal(d.rows[i].values[0], null, `row ${i} has no bracket, so no fill`);
  }
  assert.ok(d.rows[2].values[1] !== null, 'the bracketed column still fills');
});

test('densifyGrid rejects a lattice it cannot span', () => {
  assert.equal(densifyGrid(lattice([0], [{ dte: 10, values: [0.3] }])), null, 'one row');
  assert.equal(densifyGrid(null), null);
});

// ── ivColorDomain ───────────────────────────────────────────────────────────
test('ivColorDomain clamps an outlier out of the ramp', () => {
  // 100 values: ninety-nine 0.20s and one 0.64 spike, exactly the shape a
  // 1-DTE wing makes against a flat body.
  const values = new Array(99).fill(0.20).concat([0.64]);
  const g = lattice([0], values.map((v, i) => ({ dte: i + 1, values: [v] })));
  const d = ivColorDomain(g);
  assert.ok(Math.abs(d.ivMax - 0.64) < 1e-12, 'true max still reported');
  assert.ok(d.hi < 0.64, 'but the ramp stops short of it');
  assert.equal(d.clampedHi, true);
  assert.equal(d.clampedLo, false, 'the low end needs no clamping here');
});

test('ivColorDomain uses type-7 quantiles', () => {
  // 0..100 in unit steps: p2 = 2, p98 = 98 exactly under type 7.
  const vals = Array.from({ length: 101 }, (_, i) => i / 100);
  const g = lattice([0], vals.map((v, i) => ({ dte: i + 1, values: [v] })));
  const d = ivColorDomain(g, { minSpan: 0 });
  assert.ok(Math.abs(d.lo - 0.02) < 1e-12, `lo ${d.lo}`);
  assert.ok(Math.abs(d.hi - 0.98) < 1e-12, `hi ${d.hi}`);
});

test('ivColorDomain widens a near-flat surface to minSpan', () => {
  const g = lattice([0], [
    { dte: 1, values: [0.2000] }, { dte: 2, values: [0.2001] }, { dte: 3, values: [0.2002] },
  ]);
  const d = ivColorDomain(g, { minSpan: 0.02 });
  assert.ok(Math.abs((d.hi - d.lo) - 0.02) < 1e-12, 'widened to the floor');
  assert.ok(Math.abs((d.hi + d.lo) / 2 - 0.2001) < 1e-6, 'and widened symmetrically');
});

test('ivColorDomain returns null with nothing to measure', () => {
  assert.equal(ivColorDomain(lattice([0], [{ dte: 1, values: [null] }])), null);
  assert.equal(ivColorDomain(null), null);
});

// ── ticks ───────────────────────────────────────────────────────────────────
test('niceTicks lands on round values inside the range', () => {
  const t = niceTicks(0.121, 0.639, 6);
  assert.ok(t.length >= 4 && t.length <= 8, `got ${t.length}: ${t}`);
  assert.ok(t[0] >= 0.121 && t[t.length - 1] <= 0.639, 'stays inside');
  for (const v of t) assert.ok(Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, `${v} is round`);
  assert.deepEqual(niceTicks(1, 0), [], 'inverted range');
});

test('dteTicks thins crowded log-axis tenors', () => {
  const t = dteTicks(1, 1095);
  assert.equal(t[0], 1, 'front kept');
  assert.ok(t.includes(30) && t.includes(365), 'the tenors people name are kept');
  assert.ok(t.length >= 6 && t.length <= 10, `want a readable axis, got ${t.length}: ${t}`);
  for (let i = 1; i < t.length; i++) {
    assert.ok(Math.log(t[i]) - Math.log(t[i - 1]) >= 0.55 - 1e-9, `${t[i - 1]}->${t[i]} too close`);
  }
  assert.deepEqual(dteTicks(5, 5), [], 'empty range');
});

test('dteTicks adapts to a short board instead of promising LEAPS', () => {
  const t = dteTicks(1, 45);
  assert.ok(t.every((d) => d <= 45), `no tenor past the board: ${t}`);
  assert.ok(t.includes(30), 'but the monthly is still there');
});

// ── countIvQuotes ───────────────────────────────────────────────────────────
test('countIvQuotes matches analyzeChain coverage', () => {
  const chain = smileChain('2026-08-14');
  assert.equal(countIvQuotes(chain), chain.length);
  const noIv = chain.map((c) => { const { iv, ...rest } = c; return rest; });
  assert.equal(countIvQuotes(noIv), 0);
  assert.equal(countIvQuotes(null), 0);

  const full = [...smileChain('2026-08-07'), ...smileChain('2026-09-18')];
  assert.equal(countIvQuotes(full), analyzeChain(full, SPOT, TODAY).coverage.withIv);
});

// ── analyzeChain ────────────────────────────────────────────────────────────
test('analyzeChain assembles the full read and reports coverage', () => {
  const chain = [...smileChain('2026-08-07', 0.35), ...smileChain('2026-09-18', 0.28)];
  const res = analyzeChain(chain, SPOT, TODAY);
  assert.ok(res, 'analysis produced');
  assert.equal(res.smiles.length, 2);
  assert.equal(res.term.length, 2);
  assert.equal(res.frontDate, '2026-08-07');
  assert.equal(res.frontDte, 8);
  assert.ok(Math.abs(res.frontAtm - 0.35) < 1e-12);
  assert.equal(res.iv30.method, 'interp');
  assert.equal(res.coverage.total, 14);
  assert.equal(res.coverage.withIv, 14);
  assert.equal(res.coverage.expiries, 2);
});

test('analyzeChain anchors skew to the reference expiry, not the front', () => {
  const chain = [...smileChain('2026-07-31', 0.60), ...smileChain('2026-08-28', 0.30)];
  const res = analyzeChain(chain, SPOT, TODAY);
  assert.equal(res.frontDte, 1, 'front is still reported separately');
  assert.equal(res.refDte, 29, 'but skew describes the ~30d expiry');
  assert.ok(Math.abs(res.refAtm - 0.30) < 1e-12);
});

test('analyzeChain returns null on a pre-IV chain', () => {
  const noIv = smileChain('2026-08-14').map((c) => { const { iv, ...rest } = c; return rest; });
  assert.equal(analyzeChain(noIv, SPOT, TODAY), null);
});

test('analyzeChain returns null on an empty or malformed chain', () => {
  assert.equal(analyzeChain([], SPOT, TODAY), null);
  assert.equal(analyzeChain(null, SPOT, TODAY), null);
  assert.equal(analyzeChain(smileChain('2026-08-14'), 0, TODAY), null, 'no spot');
});

test('VOL_DEFAULTS documents the filters the header explains', () => {
  assert.equal(VOL_DEFAULTS.minDte, 1);
  assert.equal(VOL_DEFAULTS.minPointsPerExpiry, 4);
  assert.equal(VOL_DEFAULTS.targetDays, 30);
});
