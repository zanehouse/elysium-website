// svi.js — raw-SVI smile fit, one curve per expiry, with a no-arbitrage gate
// and an explicit fallback to vol.js's plain linear interpolation.
//
// Pure functions only (no DOM, no fetch) — same convention as vol.js and
// gex.js, so this runs under `node --test` and in the browser unchanged.
// Deliberately kept OUT of vol.js: vol.js is a load-bearing "never fabricate
// data" contract already covered end to end by tests, and this module is a
// materially riskier piece of math (an optimizer, not a lookup). Keeping the
// fallback boundary a FILE boundary means vol.js never has to know SVI
// exists, and nothing here can change what vol.js already promises.
//
// ── The model ────────────────────────────────────────────────────────────
// Raw SVI (Gatheral 2004): total variance as a function of log-moneyness k,
//
//   w(k) = a + b * ( rho * (k - m) + sqrt((k - m)^2 + sigma^2) )
//
// k is ln(strike/spot) — the same spot-not-forward convention vol.js's own
// header already documents and accepts (SVI introduces no new approximation
// there). w = iv^2 * t. Five parameters: a (level), b >= 0 (angle/steepness),
// rho in (-1, 1) (rotation, i.e. skew), m (horizontal shift), sigma > 0
// (curvature at the vertex).
//
// ── Why this needs no external optimizer ────────────────────────────────
// For a FIXED (m, sigma), w(k) is LINEAR in three new variables:
//
//   w(k) = a + c1*(k-m) + c2*sqrt((k-m)^2+sigma^2)     c1 = b*rho, c2 = b
//
// — an ordinary 3-parameter least squares problem, solved directly from a
// 3x3 normal-equations system (no matrix library needed). The only genuinely
// nonlinear part is a 2-D search over (m, sigma), done here as a coarse grid:
// every cell costs one closed-form solve, so a few hundred cells is well
// under a millisecond. This is the standard "quasi-explicit" SVI calibration
// (Zeliade Systems, 2009).
//
// ── The gate ─────────────────────────────────────────────────────────────
// fitSvi() either fully accepts a curve or fully rejects it — it never
// returns something "a bit sketchy". Rejected cases carry a reason so a
// caller can report (never silently swallow) why an expiry fell back to the
// plain interpolation:
//
//   too_few_points        fewer than minPoints quoted strikes
//   degenerate_smile      quoted strikes span ~zero log-moneyness
//   no_feasible_grid_point   no (m,sigma) cell produced b>=0, |rho|<1,
//                          non-negative vertex variance
//   rmse_too_high         best feasible fit still misses the quotes by more
//                          than maxRmseVolPts
//   butterfly_arbitrage   best feasible, accurate fit still fails the
//                          Durrleman butterfly-arbitrage check somewhere
//                          inside the smile's OWN quoted range (never
//                          checked past it — matches vol.js's
//                          never-extrapolate rule)

import { ivAtMoneyness } from './vol.js';

export const SVI_DEFAULTS = {
  minPoints: 6,          // 5 free parameters + 1 spare: a 5-point fit is a
                          // perfect but meaningless interpolation, not a fit
  gridM: 17,
  gridSigma: 12,
  maxRmseVolPts: 0.03,    // 3 vol points
  minSigma: 1e-4,
  maxAbsRho: 0.999,
  gArbTol: -1e-6,         // small negative slack for float rounding
  gArbSamples: 25,
  curveSteps: 60,
};

// Solve the 3x3 system M*x = v via Cramer's rule. Returns null when M is
// (numerically) singular rather than dividing by ~0 — the caller treats
// that grid cell as infeasible, not as a crash.
function solve3x3(M, v) {
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

  const det = det3(M);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;

  const withCol = (col) => M.map((row, i) => row.map((x, j) => (j === col ? v[i] : x)));
  return [det3(withCol(0)) / det, det3(withCol(1)) / det, det3(withCol(2)) / det];
}

// Closed-form (a, c1, c2) for one (m, sigma) grid cell, plus the resulting
// RMSE in vol points. Returns null when the normal equations are singular
// (degenerate x-spread, effectively duplicate strikes at this sigma) — that
// is an infeasible cell, not an error.
function fitLinearInner(ks, ws, t, m, sigma) {
  const n = ks.length;
  let S1 = n, Sx = 0, Ss = 0, Sxx = 0, Sxs = 0, Sss = 0, Sy = 0, Sxy = 0, Ssy = 0;
  const xs = new Array(n), ss = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = ks[i] - m;
    const s = Math.sqrt(x * x + sigma * sigma);
    xs[i] = x; ss[i] = s;
    const w = ws[i];
    Sx += x; Ss += s; Sxx += x * x; Sxs += x * s; Sss += s * s;
    Sy += w; Sxy += x * w; Ssy += s * w;
  }

  const sol = solve3x3(
    [[S1, Sx, Ss], [Sx, Sxx, Sxs], [Ss, Sxs, Sss]],
    [Sy, Sxy, Ssy],
  );
  if (!sol) return null;
  const [a, c1, c2] = sol;

  let sse = 0;
  for (let i = 0; i < n; i++) {
    const wPred = a + c1 * xs[i] + c2 * ss[i];
    const ivPred = Math.sqrt(Math.max(0, wPred) / t);
    const ivActual = Math.sqrt(ws[i] / t);
    const d = ivPred - ivActual;
    sse += d * d;
  }
  return { a, c1, c2, rmse: Math.sqrt(sse / n) };
}

function linspace(lo, hi, n) {
  if (n <= 1) return [lo];
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = lo + ((hi - lo) * i) / (n - 1);
  return out;
}

function logspace(lo, hi, n) {
  return linspace(Math.log(lo), Math.log(hi), n).map(Math.exp);
}

// Total variance at the vertex (minimum of w over k) — a + b*sigma*sqrt(1-rho^2).
// Must stay non-negative for the curve to be a legitimate variance surface.
function vertexVariance(a, b, rho, sigma) {
  return a + b * sigma * Math.sqrt(Math.max(0, 1 - rho * rho));
}

function wAt(fit, k) {
  const x = k - fit.m;
  return fit.a + fit.b * (fit.rho * x + Math.sqrt(x * x + fit.sigma * fit.sigma));
}

function dwAt(fit, k) {
  const x = k - fit.m;
  const s = Math.sqrt(x * x + fit.sigma * fit.sigma);
  return fit.b * (fit.rho + x / s);
}

function d2wAt(fit, k) {
  const x = k - fit.m;
  const s2 = x * x + fit.sigma * fit.sigma;
  return (fit.b * fit.sigma * fit.sigma) / Math.pow(s2, 1.5);
}

// Durrleman (2004) butterfly-arbitrage function, via Gatheral & Jacquier
// (2014)'s g(k) for a single SVI slice. g(k) >= 0 everywhere is sufficient
// for no butterfly arbitrage in that slice.
export function durrlemanG(fit, k) {
  const w = wAt(fit, k);
  if (!(w > 0)) return -Infinity; // non-positive variance is itself a violation
  const wp = dwAt(fit, k);
  const wpp = d2wAt(fit, k);
  const term1 = Math.pow(1 - (k * wp) / (2 * w), 2);
  const term2 = ((wp * wp) / 4) * (1 / w + 1 / 4);
  const term3 = wpp / 2;
  return term1 - term2 + term3;
}

// Fit one raw-SVI curve to a smile (as built by vol.js's buildSmiles), or
// report exactly why it could not. Never throws.
export function fitSvi(smile, opts = {}) {
  const cfg = { ...SVI_DEFAULTS, ...opts };
  if (!smile || !Array.isArray(smile.points) || !(smile.t > 0)) {
    return { ok: false, reason: 'too_few_points' };
  }
  const pts = smile.points;
  if (pts.length < cfg.minPoints) return { ok: false, reason: 'too_few_points' };

  const ks = pts.map((p) => p.logMoneyness);
  const ws = pts.map((p) => p.iv * p.iv * smile.t);
  const kMin = ks[0], kMax = ks[ks.length - 1];
  const kRange = kMax - kMin;
  if (!(kRange > 1e-6)) return { ok: false, reason: 'degenerate_smile' };

  const mCandidates = linspace(kMin - 0.15 * kRange, kMax + 0.15 * kRange, cfg.gridM);
  const sigmaCandidates = logspace(
    Math.max(cfg.minSigma, 0.05 * kRange),
    Math.max(2 * kRange, 10 * cfg.minSigma),
    cfg.gridSigma,
  );

  let best = null;
  for (const m of mCandidates) {
    for (const sigma of sigmaCandidates) {
      const inner = fitLinearInner(ks, ws, smile.t, m, sigma);
      if (!inner) continue; // singular cell — infeasible, not an error
      const { a, c1, c2, rmse } = inner;
      const b = c2;
      if (!(b >= 0)) continue;
      const rho = b > 0 ? c1 / b : 0;
      if (!Number.isFinite(rho) || Math.abs(rho) > cfg.maxAbsRho) continue;
      if (!(vertexVariance(a, b, rho, sigma) >= 0)) continue;
      if (!best || rmse < best.rmse) best = { a, b, rho, m, sigma, rmse };
    }
  }

  if (!best) return { ok: false, reason: 'no_feasible_grid_point' };
  if (best.rmse > cfg.maxRmseVolPts) return { ok: false, reason: 'rmse_too_high' };

  const fit = {
    ok: true,
    a: best.a, b: best.b, rho: best.rho, m: best.m, sigma: best.sigma,
    rmse: best.rmse, n: pts.length, kMin, kMax, t: smile.t,
  };

  const gSamples = linspace(kMin, kMax, cfg.gArbSamples);
  for (const k of gSamples) {
    if (durrlemanG(fit, k) < cfg.gArbTol) return { ok: false, reason: 'butterfly_arbitrage' };
  }

  return fit;
}

// IV at a given log-moneyness k (NOT clamped to [kMin,kMax] — callers that
// must respect the never-extrapolate rule do that clamp themselves; see
// ivAtMoneynessSmoothed below). Assumes fit.ok.
export function sviIv(fit, k, t = fit.t) {
  const w = wAt(fit, k);
  return Math.sqrt(Math.max(0, w) / t);
}

// Sampled curve, strictly inside the fit's own quoted range — never past it.
export function sviCurve(fit, opts = {}) {
  const { steps = SVI_DEFAULTS.curveSteps } = opts;
  if (!fit || !fit.ok || !(steps >= 2)) return [];
  return linspace(fit.kMin, fit.kMax, steps).map((k) => ({
    logMoneyness: k,
    moneyness: Math.exp(k) - 1,
    iv: sviIv(fit, k),
  }));
}

// Drop-in reader for vol.js's surfaceGrid({ ivReader }) — same never-
// extrapolate contract as vol.js's own ivAtMoneyness: null outside the
// smile's quoted moneyness range, regardless of fit validity. Falls back to
// the plain linear interpolation whenever there is no accepted fit, so a
// caller can pass this everywhere without special-casing the failure case.
export function ivAtMoneynessSmoothed(smile, m, fit) {
  if (!fit || !fit.ok) return ivAtMoneyness(smile, m);
  if (!smile || !Array.isArray(smile.points) || !smile.points.length) return null;
  const lo = smile.points[0].moneyness, hi = smile.points[smile.points.length - 1].moneyness;
  if (!Number.isFinite(m) || m < lo || m > hi) return null;
  const k = Math.log(1 + m);
  return sviIv(fit, k);
}
