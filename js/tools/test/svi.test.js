import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  SVI_DEFAULTS, fitSvi, sviIv, sviCurve, ivAtMoneynessSmoothed, durrlemanG,
} from '../svi.js';
import { buildSmiles, ivAtMoneyness } from '../vol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A smile object in exactly the shape buildSmiles() produces, built directly
// (same convention as vol.test.js's lattice() helper) so tests can control
// the exact k-values and iv curve without going through the OTM/spot-split
// machinery in buildSmiles.
function directSmile(t, points) {
  return {
    date: 'x', dte: Math.round(t * 365), t,
    points, n: points.length,
  };
}

function point(k, iv, oi = 500) {
  return {
    strike: 100 * Math.exp(k), moneyness: Math.exp(k) - 1, logMoneyness: k,
    iv, oi, type: k <= 0 ? 'P' : 'C',
  };
}

function linspace(lo, hi, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(lo + ((hi - lo) * i) / (n - 1));
  return out;
}

// ── fitSvi: perfect recovery ─────────────────────────────────────────────
test('fitSvi recovers a known SVI curve with low residual error', () => {
  const t = 30 / 365;
  const truth = { a: 0.02, b: 0.15, rho: -0.3, m: 0.01, sigma: 0.12 };
  const wTrue = (k) => {
    const x = k - truth.m;
    return truth.a + truth.b * (truth.rho * x + Math.sqrt(x * x + truth.sigma * truth.sigma));
  };
  const ks = linspace(-0.35, 0.35, 15);
  const points = ks.map((k) => point(k, Math.sqrt(wTrue(k) / t)));
  const smile = directSmile(t, points);

  const fit = fitSvi(smile);
  assert.equal(fit.ok, true, `expected a fit, got ${fit.ok === false ? fit.reason : ''}`);
  // The grid search (no local polish — see svi.js header) need not land on
  // the exact (m,sigma) that generated the data; what matters is the FITTED
  // CURVE matching the true curve closely, which the closed-form (a,c1,c2)
  // solve at each grid cell guarantees regardless of which cell wins.
  assert.ok(fit.rmse < 0.003, `fit.rmse ${fit.rmse} too high for a noise-free curve`);
  for (const k of [-0.35, -0.1, 0, 0.1, 0.35]) {
    const truthIv = Math.sqrt(wTrue(k) / t);
    const got = sviIv(fit, k);
    assert.ok(Math.abs(got - truthIv) < 0.01, `k=${k}: got ${got}, truth ${truthIv}`);
  }
});

// ── fitSvi: rejection paths ──────────────────────────────────────────────
test('fitSvi rejects a smile with fewer than minPoints quotes', () => {
  const t = 30 / 365;
  const points = [point(-0.1, 0.3), point(-0.05, 0.28), point(0, 0.25), point(0.05, 0.23), point(0.1, 0.22)];
  assert.equal(points.length, SVI_DEFAULTS.minPoints - 1);
  const fit = fitSvi(directSmile(t, points));
  assert.deepEqual(fit, { ok: false, reason: 'too_few_points' });
});

test('fitSvi rejects a degenerate smile (~zero log-moneyness spread)', () => {
  const t = 30 / 365;
  const points = linspace(0, 1e-9, 8).map((eps) => point(eps, 0.25));
  const fit = fitSvi(directSmile(t, points));
  assert.deepEqual(fit, { ok: false, reason: 'degenerate_smile' });
});

test('fitSvi accepts a flat smile with b near zero', () => {
  const t = 30 / 365;
  const points = linspace(-0.2, 0.2, 9).map((k) => point(k, 0.20));
  const fit = fitSvi(directSmile(t, points));
  assert.equal(fit.ok, true);
  assert.ok(fit.b < 0.01, `expected near-zero b for a flat smile, got ${fit.b}`);
  assert.ok(Math.abs(sviIv(fit, 0) - 0.20) < 0.002);
});

test('fitSvi rejects a smile no convex SVI curve can track', () => {
  const t = 30 / 365;
  // A zigzag: raw SVI's w(k) is a hyperbola (monotonic on each side of one
  // vertex) and cannot reproduce an oscillating pattern like this within
  // the RMSE tolerance.
  const ks = linspace(-0.3, 0.3, 7);
  const ivs = [0.20, 0.35, 0.15, 0.35, 0.15, 0.35, 0.20];
  const points = ks.map((k, i) => point(k, ivs[i]));
  const fit = fitSvi(directSmile(t, points));
  assert.equal(fit.ok, false);
  assert.ok(
    ['rmse_too_high', 'no_feasible_grid_point'].includes(fit.reason),
    `unexpected reason: ${fit.reason}`,
  );
});

// ── durrlemanG: butterfly-arbitrage check, tested directly ───────────────
// fitSvi's own grid+RMSE gate makes it hard to reliably force a butterfly-
// arbitrage rejection purely through smile-shape inputs (a bad fit usually
// fails on rmse or feasibility first), so this is verified directly against
// a hand-built, known-bad fit.
test('durrlemanG flags a known butterfly-arbitrage SVI parameterization', () => {
  const fit = { a: 0.001, b: 5, rho: 0.9, m: 0, sigma: 0.05, kMin: -1, kMax: 1 };
  assert.ok(durrlemanG(fit, 0.1) < SVI_DEFAULTS.gArbTol, 'expected a negative g(k)');
});

test('durrlemanG stays non-negative for a well-behaved curve', () => {
  const fit = { a: 0.02, b: 0.15, rho: -0.3, m: 0.01, sigma: 0.12, kMin: -0.35, kMax: 0.35 };
  for (const k of linspace(-0.35, 0.35, 9)) {
    assert.ok(durrlemanG(fit, k) >= SVI_DEFAULTS.gArbTol, `g(${k}) unexpectedly negative`);
  }
});

// ── sviCurve ──────────────────────────────────────────────────────────────
test('sviCurve is clamped to the fit range, ascending, exactly `steps` points', () => {
  const t = 30 / 365;
  const points = linspace(-0.2, 0.2, 8).map((k) => point(k, 0.22 - 0.1 * k));
  const fit = fitSvi(directSmile(t, points));
  assert.equal(fit.ok, true);
  const curve = sviCurve(fit, { steps: 20 });
  assert.equal(curve.length, 20);
  assert.ok(Math.abs(curve[0].logMoneyness - fit.kMin) < 1e-9);
  assert.ok(Math.abs(curve[curve.length - 1].logMoneyness - fit.kMax) < 1e-9);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i].logMoneyness > curve[i - 1].logMoneyness, 'strictly ascending');
  }
});

// ── ivAtMoneynessSmoothed ──────────────────────────────────────────────────
test('ivAtMoneynessSmoothed falls back to plain linear interpolation when the fit is unusable', () => {
  const chain = [];
  for (const m of [-0.15, -0.10, -0.05, 0, 0.05, 0.10, 0.15]) {
    const strike = 100 * (1 + m);
    const iv = 0.30 - 0.5 * m;
    chain.push({ expiry: '2026-09-11', type: m <= 0 ? 'P' : 'C', strike, oi: 500, iv });
  }
  const smile = buildSmiles(chain, 100, '2026-08-04')[0];

  for (const fit of [null, { ok: false, reason: 'too_few_points' }]) {
    for (const m of [-0.1, -0.025, 0, 0.05]) {
      assert.equal(
        ivAtMoneynessSmoothed(smile, m, fit), ivAtMoneyness(smile, m),
        `mismatch at m=${m} for fit=${JSON.stringify(fit)}`,
      );
    }
  }
});

test('ivAtMoneynessSmoothed never extrapolates past the quoted moneyness range', () => {
  const t = 30 / 365;
  const points = linspace(-0.15, 0.15, 8).map((k) => point(k, 0.22 - 0.4 * k));
  const smile = directSmile(t, points);
  const fit = fitSvi(smile);
  assert.equal(fit.ok, true);
  assert.equal(ivAtMoneynessSmoothed(smile, -0.5, fit), null);
  assert.equal(ivAtMoneynessSmoothed(smile, 0.5, fit), null);
  assert.equal(ivAtMoneynessSmoothed(smile, NaN, fit), null);
});

// ── Real-shape regression ──────────────────────────────────────────────────
// A realistic (synthetic — no real IV-bearing CBOE snapshot is available
// offline; see the fixture's own generator note) multi-expiry SPY-shaped
// chain: several liquid expiries with a full strike ladder, plus one
// deliberately thin expiry, so this exercises both the SVI path and the
// fallback path against something closer to production shape than the
// hand-built fixtures above.
test('fitSvi handles every expiry in a realistic multi-expiry chain without throwing', () => {
  const raw = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'spy-like-synthetic-chain.json'), 'utf8'));
  const chain = raw.contracts.map((c) => ({
    expiry: c.e, type: c.t, strike: c.k, oi: c.oi, gamma: c.g, volume: c.v, iv: c.iv,
  }));
  const smiles = buildSmiles(chain, raw.spot, raw.today);
  assert.ok(smiles.length >= 5, `expected several expiries, got ${smiles.length}`);

  const results = smiles.map((s) => ({ date: s.date, n: s.n, fit: fitSvi(s) }));
  for (const r of results) {
    if (r.fit.ok) {
      assert.ok(Number.isFinite(r.fit.rmse) && r.fit.b >= 0 && Math.abs(r.fit.rho) < 1);
    } else {
      assert.ok(
        ['too_few_points', 'degenerate_smile', 'no_feasible_grid_point', 'rmse_too_high', 'butterfly_arbitrage']
          .includes(r.fit.reason),
        `unexpected reason on ${r.date}: ${r.fit.reason}`,
      );
    }
  }

  const thin = results.find((r) => r.n < SVI_DEFAULTS.minPoints);
  assert.ok(thin, 'fixture should include a thin expiry');
  assert.equal(thin.fit.ok, false);
  assert.equal(thin.fit.reason, 'too_few_points');

  const richFits = results.filter((r) => r.n >= SVI_DEFAULTS.minPoints);
  const okCount = richFits.filter((r) => r.fit.ok).length;
  assert.ok(okCount >= richFits.length - 1, `expected most rich expiries to fit, got ${okCount}/${richFits.length}`);
});
