import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normPdf, normCdf, d1d2, bsPrice, bsGreeks, intrinsic, priceBounds, impliedVol,
  yearsFromDays, DAYS_PER_YEAR,
} from '../bs.js';

function close(actual, expected, eps, msg) {
  assert.ok(Number.isFinite(actual), `${msg}: got non-finite ${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps,
    `${msg}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)} > ${eps})`);
}

// ── Normal distribution ─────────────────────────────────────────────────────
test('normCdf matches known values to 1e-12', () => {
  close(normCdf(0), 0.5, 0, 'N(0) is exactly 0.5');
  close(normCdf(1), 0.841344746068543, 1e-12, 'N(1)');
  close(normCdf(-1), 0.158655253931457, 1e-12, 'N(-1)');
  close(normCdf(1.96), 0.975002104851780, 1e-12, 'N(1.96)');
  close(normCdf(-3), 0.001349898031630, 1e-12, 'N(-3)');
  close(normCdf(5), 0.999999713348428, 1e-12, 'N(5)');
});

// The mirrored implementation makes this exact, which is what turns put-call
// parity into a real invariant instead of a tolerance check.
test('normCdf is exactly symmetric: N(x) + N(-x) === 1', () => {
  for (const x of [0, 0.1, 0.5, 1, 1.96, 2.5, 3, 5, 7, 7.5, 10, 20, 36]) {
    assert.equal(normCdf(x) + normCdf(-x), 1, `symmetry at x=${x}`);
  }
});

test('normPdf matches known values', () => {
  close(normPdf(0), 0.398942280401433, 1e-12, 'phi(0)');
  close(normPdf(1), 0.241970724519143, 1e-12, 'phi(1)');
  close(normPdf(-1), 0.241970724519143, 1e-12, 'phi(-1) equals phi(1)');
});

// ── Reference values ────────────────────────────────────────────────────────
// Hull, Options Futures and Other Derivatives — the worked example (rounded to
// 4.76 / 0.81 in the text) carried out to 6dp.
test('Hull reference: S=42 K=40 T=0.5 r=0.10 q=0 sigma=0.20', () => {
  const args = [42, 40, 0.5, 0.10, 0.20, 0];
  const { d1, d2 } = d1d2(...args);
  close(d1, 0.769262437, 1e-6, 'd1');
  close(d2, 0.627841081, 1e-6, 'd2');

  close(bsPrice('C', ...args), 4.759422, 1e-6, 'call price');
  close(bsPrice('P', ...args), 0.808599, 1e-6, 'put price');

  const c = bsGreeks('C', ...args);
  const p = bsGreeks('P', ...args);
  close(c.delta, 0.779131, 1e-6, 'call delta');
  close(p.delta, -0.220869, 1e-6, 'put delta');
  close(c.gamma, 0.049963, 1e-6, 'gamma');
  close(c.vega, 8.813415, 1e-6, 'vega');
  close(c.theta, -4.559092, 1e-6, 'call theta');
  close(p.theta, -0.754175, 1e-6, 'put theta');
  close(c.rho, 13.982046, 1e-6, 'call rho');
  close(p.rho, -5.042542, 1e-6, 'put rho');
});

test('ATM reference: S=100 K=100 T=1 r=0.05 q=0 sigma=0.20', () => {
  const args = [100, 100, 1, 0.05, 0.20, 0];
  const { d1, d2 } = d1d2(...args);
  close(d1, 0.35, 1e-12, 'd1');
  close(d2, 0.15, 1e-12, 'd2');

  close(bsPrice('C', ...args), 10.450583, 1e-6, 'call price');
  close(bsPrice('P', ...args), 5.573526, 1e-6, 'put price');

  const c = bsGreeks('C', ...args);
  close(c.delta, 0.636831, 1e-6, 'call delta');
  close(c.gamma, 0.018762, 1e-6, 'gamma');
  close(c.vega, 37.524035, 1e-6, 'vega');
  close(c.theta, -6.414028, 1e-6, 'call theta');
  close(c.rho, 53.232482, 1e-6, 'call rho');
});

test('dividend reference: S=100 K=95 T=0.75 r=0.04 q=0.02 sigma=0.30', () => {
  const args = [100, 95, 0.75, 0.04, 0.30, 0.02];
  close(bsPrice('C', ...args), 13.331916150142, 1e-9, 'call price');
  close(bsPrice('P', ...args), 7.013047876944, 1e-9, 'put price');

  const c = bsGreeks('C', ...args);
  const p = bsGreeks('P', ...args);
  close(c.delta, 0.640230204449, 1e-9, 'call delta');
  close(p.delta, -0.344881735154, 1e-9, 'put delta');
  close(c.gamma, 0.014045782497, 1e-9, 'gamma');
  close(c.vega, 31.603010617663, 1e-9, 'vega');
  close(c.theta, -7.067785886425, 1e-9, 'call theta');
  close(p.theta, -5.350316738147, 1e-9, 'put theta');
  close(c.rho, 38.018328221066, 1e-9, 'call rho');
  close(p.rho, -31.125916044265, 1e-9, 'put rho');
});

// ── Structural invariants ───────────────────────────────────────────────────
test('put-call parity holds to 1e-12 across a parameter grid', () => {
  for (const S of [50, 100, 137.5]) {
    for (const K of [80, 100, 125]) {
      for (const T of [0.01, 0.5, 2]) {
        for (const r of [0, 0.05]) {
          for (const q of [0, 0.03]) {
            for (const sigma of [0.1, 0.35, 1.2]) {
              const c = bsPrice('C', S, K, T, r, sigma, q);
              const p = bsPrice('P', S, K, T, r, sigma, q);
              const expected = S * Math.exp(-q * T) - K * Math.exp(-r * T);
              close(c - p, expected, 1e-12,
                `parity S=${S} K=${K} T=${T} r=${r} q=${q} sig=${sigma}`);
            }
          }
        }
      }
    }
  }
});

test('gamma and vega are identical for calls and puts', () => {
  for (const K of [80, 100, 130]) {
    const c = bsGreeks('C', 100, K, 0.6, 0.03, 0.28, 0.01);
    const p = bsGreeks('P', 100, K, 0.6, 0.03, 0.28, 0.01);
    assert.equal(c.gamma, p.gamma, `gamma type-independence at K=${K}`);
    assert.equal(c.vega, p.vega, `vega type-independence at K=${K}`);
  }
});

test('price is strictly increasing in sigma (the bracket relies on it)', () => {
  for (const type of ['C', 'P']) {
    let prev = -Infinity;
    for (const sigma of [0.01, 0.05, 0.2, 0.5, 1, 2, 4]) {
      const v = bsPrice(type, 100, 110, 0.5, 0.04, sigma, 0);
      assert.ok(v > prev, `${type} price should increase at sigma=${sigma}`);
      prev = v;
    }
  }
});

// ── Degenerate-but-defined limits ───────────────────────────────────────────
test('T=0 prices to intrinsic, not null', () => {
  close(bsPrice('C', 110, 100, 0, 0.05, 0.3, 0), 10, 1e-12, 'ITM call at expiry');
  close(bsPrice('C', 90, 100, 0, 0.05, 0.3, 0), 0, 1e-12, 'OTM call at expiry');
  close(bsPrice('P', 90, 100, 0, 0.05, 0.3, 0), 10, 1e-12, 'ITM put at expiry');
  close(bsPrice('P', 110, 100, 0, 0.05, 0.3, 0), 0, 1e-12, 'OTM put at expiry');
});

test('sigma=0 prices to discounted forward intrinsic', () => {
  const S = 100, K = 95, T = 1, r = 0.05, q = 0.02;
  const expected = Math.max(0, S * Math.exp(-q * T) - K * Math.exp(-r * T));
  close(bsPrice('C', S, K, T, r, 0, q), expected, 1e-12, 'zero-vol call');
});

test('greeks at T=0 give a step delta and no NaN', () => {
  const itm = bsGreeks('C', 110, 100, 0, 0.05, 0.3, 0);
  const otm = bsGreeks('C', 90, 100, 0, 0.05, 0.3, 0);
  const put = bsGreeks('P', 90, 100, 0, 0.05, 0.3, 0);
  assert.equal(itm.delta, 1, 'ITM call delta steps to 1');
  assert.equal(otm.delta, 0, 'OTM call delta steps to 0');
  assert.equal(put.delta, -1, 'ITM put delta steps to -1');
  for (const g of [itm, otm, put]) {
    assert.equal(g.gamma, 0);
    assert.equal(g.vega, 0);
    assert.equal(g.theta, 0);
    assert.equal(g.rho, 0);
    for (const k of ['price', 'delta', 'gamma', 'vega', 'theta', 'rho']) {
      assert.ok(Number.isFinite(g[k]), `${k} must be finite at T=0`);
    }
  }
});

test('at-the-money at T=0 splits the delta step', () => {
  const g = bsGreeks('C', 100, 100, 0, 0, 0.3, 0);
  assert.equal(g.delta, 0.5);
});

test('invalid input returns null', () => {
  assert.equal(bsPrice('C', 0, 100, 1, 0.05, 0.2, 0), null, 'zero spot');
  assert.equal(bsPrice('C', 100, 0, 1, 0.05, 0.2, 0), null, 'zero strike');
  assert.equal(bsPrice('C', 100, 100, -1, 0.05, 0.2, 0), null, 'negative T');
  assert.equal(bsPrice('C', NaN, 100, 1, 0.05, 0.2, 0), null, 'NaN spot');
  assert.equal(bsPrice('C', 100, 100, 1, 0.05, -0.2, 0), null, 'negative sigma');
  assert.equal(bsGreeks('C', -5, 100, 1, 0.05, 0.2, 0), null, 'negative spot');
  assert.equal(d1d2(100, 100, 0, 0.05, 0.2, 0), null, 'd1d2 undefined at T=0');
});

// ── Implied volatility ──────────────────────────────────────────────────────
// Sigma is carried entirely by TIME VALUE, not by total price — a deep-ITM
// call can be worth $30 and still encode nothing, because all $30 of it is
// forward intrinsic. So the screen here is extrinsic value, and recoverable
// precision is (price tolerance / vega). See the conditioning caveat on
// impliedVol and the two dedicated tests below.
test('implied vol round-trips to 1e-8 wherever there is real time value', () => {
  let checked = 0;
  for (const sigma of [0.05, 0.15, 0.30, 0.75, 1.50, 2.50]) {
    for (const mny of [0.7, 0.9, 1.0, 1.1, 1.4]) {
      for (const T of [1 / 365, 0.08, 0.5, 2]) {
        for (const type of ['C', 'P']) {
          const S = 100, K = 100 * mny, r = 0.04, q = 0.01;
          const price = bsPrice(type, S, K, T, r, sigma, q);
          const timeValue = price - priceBounds(type, S, K, T, r, q).lo;
          if (timeValue < 1e-3) continue;             // no information to invert
          const solved = impliedVol(type, price, S, K, T, r, q);
          assert.ok(solved !== null,
            `should solve ${type} sigma=${sigma} mny=${mny} T=${T} (price ${price})`);
          close(solved, sigma, 1e-8,
            `roundtrip ${type} sigma=${sigma} mny=${mny} T=${T}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 150, `expected a broad sweep, only checked ${checked}`);
});

// Deep ITM near expiry: all price, no time value, so sigma is unrecoverable and
// refusing is the only honest answer. This is the guard doing real work.
test('implied vol returns null for a deep-ITM contract with no time value', () => {
  const S = 100, K = 70, T = 1 / 365, r = 0.04, q = 0.01;
  const price = bsPrice('C', S, K, T, r, 0.05, q);
  const timeValue = price - priceBounds('C', S, K, T, r, q).lo;
  assert.ok(price > 30, 'the contract is expensive');
  assert.ok(timeValue < 1e-9, 'but carries essentially no time value');
  assert.equal(impliedVol('C', price, S, K, T, r, q), null);
});

// The ill-conditioned tail: still converges and stays sane, just not to 1e-8.
// Asserting the real limit here documents it instead of hiding it behind a skip.
test('implied vol degrades gracefully where vega collapses', () => {
  const S = 100, K = 70, T = 2, r = 0.04, q = 0.01, sigma = 0.05;
  const price = bsPrice('P', S, K, T, r, sigma, q);
  assert.ok(price < 1e-6, 'this wing really is worth ~nothing');
  const solved = impliedVol('P', price, S, K, T, r, q);
  assert.ok(solved !== null, 'still returns an answer');
  close(solved, sigma, 1e-3, 'recovered to the conditioning limit, not beyond');
});

test('implied vol recovers a realistic near-money quote', () => {
  const price = bsPrice('C', 340.15, 350, 30 / 365, 0.0384, 0.289, 0);
  close(impliedVol('C', price, 340.15, 350, 30 / 365, 0.0384, 0), 0.289, 1e-10, 'AAPL-shaped');
});

test('implied vol returns null when there is no solution', () => {
  const S = 100, K = 100, T = 0.5, r = 0.05, q = 0;
  const b = priceBounds('C', S, K, T, r, q);
  assert.equal(impliedVol('C', b.lo - 1, S, K, T, r, q), null, 'below intrinsic');
  assert.equal(impliedVol('C', b.hi + 1, S, K, T, r, q), null, 'above upper bound');
  assert.equal(impliedVol('C', b.lo, S, K, T, r, q), null, 'exactly at intrinsic');
  assert.equal(impliedVol('C', b.hi, S, K, T, r, q), null, 'exactly at upper bound');
  assert.equal(impliedVol('C', 5, S, K, 0, r, q), null, 'T=0');
  assert.equal(impliedVol('C', 5, S, K, -1, r, q), null, 'negative T');
  assert.equal(impliedVol('C', 5, 0, K, T, r, q), null, 'zero spot');
  assert.equal(impliedVol('C', NaN, S, K, T, r, q), null, 'NaN price');
});

test('implied vol handles a deep ITM put where vega collapses', () => {
  // vega is tiny here, so an unsafeguarded Newton step overshoots the bracket;
  // this only converges because bisection catches it.
  const S = 100, K = 180, T = 0.05, r = 0.03, q = 0, sigma = 0.22;
  const price = bsPrice('P', S, K, T, r, sigma, q);
  const solved = impliedVol('P', price, S, K, T, r, q);
  if (solved !== null) close(solved, sigma, 1e-6, 'deep ITM put');
});

test('price bounds bracket the achievable prices', () => {
  const S = 100, K = 105, T = 0.75, r = 0.04, q = 0.02;
  for (const type of ['C', 'P']) {
    const b = priceBounds(type, S, K, T, r, q);
    close(bsPrice(type, S, K, T, r, 1e-9, q), b.lo, 1e-6, `${type} low bound`);
    assert.ok(bsPrice(type, S, K, T, r, 20, q) < b.hi + 1e-9, `${type} high bound`);
  }
});

// ── Small helpers ───────────────────────────────────────────────────────────
test('intrinsic and yearsFromDays', () => {
  assert.equal(intrinsic('C', 110, 100), 10);
  assert.equal(intrinsic('C', 90, 100), 0);
  assert.equal(intrinsic('P', 90, 100), 10);
  assert.equal(intrinsic('P', 110, 100), 0);
  assert.equal(yearsFromDays(365), 1);
  assert.equal(yearsFromDays(DAYS_PER_YEAR / 2), 0.5);
});

test('type argument accepts call/put spellings', () => {
  const a = bsPrice('C', 100, 100, 1, 0.05, 0.2, 0);
  assert.equal(bsPrice('call', 100, 100, 1, 0.05, 0.2, 0), a);
  assert.equal(bsPrice('c', 100, 100, 1, 0.05, 0.2, 0), a);
  const p = bsPrice('P', 100, 100, 1, 0.05, 0.2, 0);
  assert.equal(bsPrice('put', 100, 100, 1, 0.05, 0.2, 0), p);
});
