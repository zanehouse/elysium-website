// vol.js — implied-volatility surface: smile construction, ATM extraction,
// skew, and term structure.
// Pure functions only (no DOM, no fetch), so the same logic runs in the browser
// and under `node --test`, exactly like gex.js.
//
// Input is the same CBOE chain the GEX tool uses, now carrying a per-contract
// `iv` (a decimal fraction — see parseChain in cboe.js). Everything below is
// the volatility-model judgment that cboe.js deliberately stays out of.
//
// ── How the smile is built, and why ────────────────────────────────────────
//
// OUT-OF-THE-MONEY QUOTES ONLY. In-the-money options barely trade; their
// quotes are wide and stale, and inverting a stale mid gives a badly wrong IV.
// Measured on a live AAPL chain: the ITM 300-strike call printed 45.4% against
// an ATM of 39.7%, and the ITM 380 put printed 49.4% — errors of 5-10 vol
// points, all of it microstructure rather than signal. Using OTM only is
// standard practice, and it costs nothing: every strike still contributes
// exactly one quote (the liquid one) instead of two that disagree.
//
// SPOT, NOT FORWARD, SPLITS OTM FROM ITM. The committed chain carries no rate
// or dividend, so there is no forward to compute. Inside 60 DTE the forward
// sits within a few tens of basis points of spot, so at most one or two strikes
// right at the money are classified the "wrong" side — and those are the
// tightest, highest-OI contracts on the board, where the ITM/OTM distinction
// barely matters. Stated here because it is a real (small) approximation.
//
// SAME-DAY EXPIRIES ARE EXCLUDED (minDte). Expiring IV is not a volatility
// reading, it is a rounding artifact of a near-zero time value. Measured on a
// live SPX chain: five adjacent 0DTE strikes around the money printed 0.82,
// 1.34, 2.11, 4.90 and 8.43. Including that would make the front of every term
// structure pure noise.
//
// ── What the ±25% strike window costs ──────────────────────────────────────
// The committed chains keep strikes within ±25% of spot and drop open interest
// below a per-symbol floor (see reduceChain in build-market-data.mjs). Two
// consequences, both handled rather than hidden:
//
//   1. The wings are truncated, so this module NEVER extrapolates. Asking for
//      an IV outside the covered moneyness range returns null. Extrapolating
//      would mean inventing precisely the data the window removed.
//   2. The OI floor deletes the thin far wing on roughly a fifth of expiries,
//      so a fixed ±10% skew reading is often unavailable. That is why the
//      headline skew metric is the regression slope (skewSlope), which uses
//      every available point instead of requiring two specific strikes.
//
// A page loading a chain live through the CORS proxy (uncovered tickers) gets
// the full, unfiltered board and therefore a better surface than the
// prefetched path — worth surfacing to the user rather than glossing over.

import { daysBetween } from './gex.js';

export const VOL_DEFAULTS = {
  minIv: 0.01,             // below 1% the quote is a stale artifact, not a vol
  maxIv: 3.00,             // above 300% the inversion has broken down
  minDte: 1,               // exclude same-day expiries entirely (see above)
  minPointsPerExpiry: 4,   // fewer than this is not a smile
  skewMoneyness: 0.10,     // the secondary fixed-moneyness skew reading
  targetDays: 30,          // the headline ATM tenor
  maxAbsZ: 2,              // skew fit window, in standard deviations (see skewSlope)
};

// ── Smile construction ──────────────────────────────────────────────────────

// True when a contract carries a usable out-of-the-money implied-vol quote.
// Note calls at exactly spot and puts at exactly spot both qualify; buildSmiles
// merges that pair rather than letting one silently win.
export function usableIvQuote(c, spot, opts = {}) {
  const { minIv, maxIv } = { ...VOL_DEFAULTS, ...opts };
  if (!c || !Number.isFinite(spot) || spot <= 0) return false;
  const iv = Number(c.iv);
  if (!Number.isFinite(iv) || iv < minIv || iv > maxIv) return false;
  if (!Number.isFinite(c.strike) || c.strike <= 0) return false;
  return c.type === 'C' ? c.strike >= spot : c.strike <= spot;
}

// One smile per expiry, OTM quotes only, sorted by strike.
// Returns [] when nothing is usable — never a partial or synthesised surface.
export function buildSmiles(contracts, spot, today, opts = {}) {
  const cfg = { ...VOL_DEFAULTS, ...opts };
  if (!Array.isArray(contracts) || !Number.isFinite(spot) || spot <= 0 || !today) return [];

  const byExpiry = new Map();
  for (const c of contracts) {
    if (!usableIvQuote(c, spot, cfg)) continue;
    const dte = daysBetween(today, c.expiry);
    if (!Number.isFinite(dte) || dte < cfg.minDte) continue;
    if (!byExpiry.has(c.expiry)) byExpiry.set(c.expiry, []);
    byExpiry.get(c.expiry).push(c);
  }

  const smiles = [];
  for (const [date, rows] of byExpiry) {
    // A strike exactly at spot yields both a call and a put quote. Blend them
    // by open interest rather than picking one arbitrarily.
    const byStrike = new Map();
    for (const c of rows) {
      const prev = byStrike.get(c.strike);
      if (!prev) {
        byStrike.set(c.strike, { strike: c.strike, iv: c.iv, oi: c.oi || 0, type: c.type });
        continue;
      }
      const wPrev = prev.oi || 0, wNext = c.oi || 0, wSum = wPrev + wNext;
      prev.iv = wSum > 0 ? (prev.iv * wPrev + c.iv * wNext) / wSum : (prev.iv + c.iv) / 2;
      prev.oi = wSum;
      prev.type = 'B';
    }

    const points = [...byStrike.values()]
      .sort((a, b) => a.strike - b.strike)
      .map((p) => ({
        strike: p.strike,
        moneyness: p.strike / spot - 1,
        logMoneyness: Math.log(p.strike / spot),
        iv: p.iv,
        oi: p.oi,
        type: p.type,
      }));

    if (points.length < cfg.minPointsPerExpiry) continue;

    const dte = daysBetween(today, date);
    smiles.push({
      date,
      dte,
      t: dte / 365,
      points,
      n: points.length,
      strikeMin: points[0].strike,
      strikeMax: points[points.length - 1].strike,
      moneynessMin: points[0].moneyness,
      moneynessMax: points[points.length - 1].moneyness,
    });
  }

  return smiles.sort((a, b) => a.dte - b.dte);
}

// ── Reads off a single smile ────────────────────────────────────────────────

// Linear interpolation in moneyness. Returns null OUTSIDE the covered range —
// see the header on why this never extrapolates.
export function ivAtMoneyness(smile, m) {
  if (!smile || !Array.isArray(smile.points) || !Number.isFinite(m)) return null;
  const pts = smile.points;
  if (pts.length < 2) return null;
  if (m < pts[0].moneyness || m > pts[pts.length - 1].moneyness) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (m >= a.moneyness && m <= b.moneyness) {
      const span = b.moneyness - a.moneyness;
      if (span === 0) return (a.iv + b.iv) / 2;
      return a.iv + (b.iv - a.iv) * ((m - a.moneyness) / span);
    }
  }
  return null;
}

// At-the-money IV. Null when the smile does not straddle spot — which happens
// whenever the OI floor has eaten one side of the board.
export function atmIv(smile) {
  return ivAtMoneyness(smile, 0);
}

export function oiWeightedIv(smile) {
  if (!smile || !Array.isArray(smile.points) || !smile.points.length) return null;
  let num = 0, den = 0;
  for (const p of smile.points) {
    const w = p.oi > 0 ? p.oi : 0;
    num += p.iv * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

// Fixed-moneyness skew in decimal vol points: iv(-m) - iv(+m).
// Positive means downside vol is bid, the usual equity shape.
// Null when either wing is missing (measured: roughly a fifth of expiries).
export function skewAtMoneyness(smile, m = VOL_DEFAULTS.skewMoneyness) {
  const put = ivAtMoneyness(smile, -Math.abs(m));
  const call = ivAtMoneyness(smile, Math.abs(m));
  if (put === null || call === null) return null;
  return put - call;
}

// THE HEADLINE SKEW METRIC. Ordinary-least-squares slope of iv against
// standardized moneyness:
//
//     z = ln(K/S) / (atmIv * sqrt(T))
//
// i.e. each strike's distance from spot measured in expected standard
// deviations rather than in percent.
//
// This normalisation is the whole point. A fixed ±10% skew reading decays as
// roughly 1/sqrt(T) purely as an artifact of the scale: on a live AAPL chain it
// fell from 16.7 vol points at 1 DTE to 5.3 at 50 DTE, because a 10% move is
// several sigma next week and well under one sigma in two months. Reporting
// that as "skew" would tell a user AAPL's skew collapses over the next seven
// weeks, which is false. Dividing by sqrt(T) removes the artifact and leaves a
// number that is comparable across expiries and across tickers.
//
// Using every point in the window also sidesteps the OI floor deleting a
// specific wing.
//
// THE FIT IS BOUNDED TO |z| <= maxAbsZ, and that bound is load-bearing rather
// than cosmetic. How far out the strike board reaches depends entirely on where
// the quotes came from: the committed chains are clipped to ±25% of spot, while
// a live proxy lookup returns the whole board. Measured on PANW, the live board
// ran from −77% to +70% moneyness (z −7.5 to +2.7) with the deep put wing
// printing 247% implied volatility, and an unbounded fit let that one tail set
// the slope for the entire smile — reporting −0.154 for a smile whose
// near-the-money region is nearly flat. Two tickers would then get slopes that
// were never comparable, which is the one thing this metric exists to provide.
// Clipping to a fixed ±2 standard deviations makes the number mean the same
// thing on both paths, and drops the far wings where quotes are least reliable
// anyway. The z range actually spanned is returned so a caller can show it.
//
// Returns null when there are too few points in the window, or no ATM level to
// normalise by.
export function skewSlope(smile, opts = {}) {
  const cfg = { ...VOL_DEFAULTS, ...opts };
  if (!smile || !Array.isArray(smile.points)) return null;
  if (smile.points.length < cfg.minPointsPerExpiry) return null;
  const atm = atmIv(smile);
  if (atm === null || atm <= 0) return null;
  const sqrtT = Math.sqrt(smile.t);
  if (!Number.isFinite(sqrtT) || sqrtT <= 0) return null;

  const zs = [], ys = [];
  let clipped = 0;
  // The window is inclusive at the boundary. z is reached via exp/log, so a
  // strike sitting exactly on ±maxAbsZ can land a bit either side of it — that
  // is a rounding wobble, not a reason to treat the two wings differently.
  const zLimit = cfg.maxAbsZ * (1 + 1e-12);
  for (const p of smile.points) {
    const z = p.logMoneyness / (atm * sqrtT);
    if (!Number.isFinite(z)) continue;
    if (Math.abs(z) > zLimit) { clipped++; continue; }
    zs.push(z);
    ys.push(p.iv);
  }
  const n = zs.length;
  if (n < cfg.minPointsPerExpiry) return null;

  let sz = 0, sy = 0;
  for (let i = 0; i < n; i++) { sz += zs[i]; sy += ys[i]; }
  const mz = sz / n, my = sy / n;

  let szz = 0, szy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dz = zs[i] - mz, dy = ys[i] - my;
    szz += dz * dz; szy += dz * dy; syy += dy * dy;
  }
  if (szz <= 0) return null;

  const slope = szy / szz;
  const r2 = syy > 0 ? (szy * szy) / (szz * syy) : 1;
  return { slope, r2, n, clipped, zMin: Math.min(...zs), zMax: Math.max(...zs) };
}

// ── Term structure ──────────────────────────────────────────────────────────

// ATM IV by expiry, sorted by DTE. Expiries whose smile does not straddle spot
// drop out here rather than being filled in with a neighbour.
export function termStructure(smiles) {
  if (!Array.isArray(smiles)) return [];
  return smiles
    .map((s) => ({ date: s.date, dte: s.dte, t: s.t, atmIv: atmIv(s), n: s.n }))
    .filter((p) => p.atmIv !== null)
    .sort((a, b) => a.dte - b.dte);
}

// ATM IV at a target tenor, interpolated LINEARLY IN TOTAL VARIANCE
// (sigma^2 * T) and converted back to a volatility — the same convention VIX
// uses. Interpolating sigma directly would misprice the middle of the curve
// whenever the term structure is steep, which is exactly when anyone looks.
//
// Never extrapolates: outside the listed range it returns the nearest endpoint
// flagged as method 'nearest', so the caller can label it honestly.
export function interpolateAtmIv(term, targetDays = VOL_DEFAULTS.targetDays) {
  if (!Array.isArray(term) || !term.length || !Number.isFinite(targetDays)) return null;
  const pts = term.filter((p) => Number.isFinite(p.dte) && Number.isFinite(p.atmIv) && p.atmIv > 0);
  if (!pts.length) return null;

  if (pts.length === 1 || targetDays <= pts[0].dte) {
    return { iv: pts[0].atmIv, method: 'nearest', loDte: pts[0].dte, hiDte: pts[0].dte };
  }
  const last = pts[pts.length - 1];
  if (targetDays >= last.dte) {
    return { iv: last.atmIv, method: 'nearest', loDte: last.dte, hiDte: last.dte };
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (targetDays >= a.dte && targetDays <= b.dte) {
      const va = a.atmIv * a.atmIv * a.dte;   // total variance to each expiry
      const vb = b.atmIv * b.atmIv * b.dte;
      const span = b.dte - a.dte;
      const frac = span === 0 ? 0 : (targetDays - a.dte) / span;
      const v = va + (vb - va) * frac;
      if (v <= 0 || targetDays <= 0) return null;
      return { iv: Math.sqrt(v / targetDays), method: 'interp', loDte: a.dte, hiDte: b.dte };
    }
  }
  return null;
}

// Front expiry versus the target tenor. Backwardation (front above the back)
// is the stress/event shape; contango is the calm default.
export function termSlope(term, targetDays = VOL_DEFAULTS.targetDays, opts = {}) {
  const { flatBand = 0.005 } = opts;   // within half a vol point counts as flat
  if (!Array.isArray(term) || !term.length) return null;
  const target = interpolateAtmIv(term, targetDays);
  if (!target) return null;
  const front = term[0];
  if (!front || !Number.isFinite(front.atmIv)) return null;
  const diff = front.atmIv - target.iv;
  const shape = diff > flatBand ? 'backwardation' : diff < -flatBand ? 'contango' : 'flat';
  return { front: front.atmIv, frontDte: front.dte, target: target.iv, diff, shape };
}

// ── Interpolating a lattice in time ─────────────────────────────────────────

// Total variance w = iv² · dte, interpolated LINEARLY IN dte between the two
// bracketing samples, then converted back to a volatility. Same convention
// interpolateAtmIv() uses for the 30-day ATM reading — interpolating the
// volatility directly instead would misprice the middle of a steep curve.
//
// Days rather than years throughout: the 1/365 cancels in w/dte, so carrying it
// is one more unit to get wrong for no gain.
//
// NEVER extrapolates — outside the sample range this returns null. And it
// reproduces a sample exactly at its own tenor, since w_a / dte_a === iv_a².
export function varianceInterp(samples, dte) {
  if (!Array.isArray(samples) || !samples.length || !Number.isFinite(dte) || dte <= 0) return null;
  const pts = samples.filter((s) => s && Number.isFinite(s.dte) && s.dte > 0 && Number.isFinite(s.iv) && s.iv > 0);
  if (!pts.length) return null;

  // A lone sample can only answer for its own tenor. Anything else would be
  // extrapolation dressed up as a constant.
  if (pts.length === 1) return pts[0].dte === dte ? pts[0].iv : null;
  if (dte < pts[0].dte || dte > pts[pts.length - 1].dte) return null;

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (dte < a.dte || dte > b.dte) continue;
    const wa = a.iv * a.iv * a.dte;
    const wb = b.iv * b.iv * b.dte;
    const span = b.dte - a.dte;
    const w = span === 0 ? wa : wa + (wb - wa) * ((dte - a.dte) / span);
    return w > 0 ? Math.sqrt(w / dte) : null;
  }
  return null;
}

// Every quoted cell in one moneyness column, ascending in time — the sample set
// both fillGridInTime and densifyGrid interpolate from. Sharing it is what makes
// the audit lattice and the render lattice incapable of disagreeing.
function columnSamples(rows, col) {
  const out = [];
  for (const r of rows) {
    const v = r.values[col];
    if (v !== null && Number.isFinite(v)) out.push({ dte: r.dte, iv: v });
  }
  return out;
}

// Fill the TIME direction of a surfaceGrid() lattice. Same rows, same columns —
// nothing is invented in the moneyness direction.
//
// A cell is filled only when the SAME moneyness column carries a quote both
// before AND after it in time, so the truncated wings stay truncated exactly as
// this module's header promises. Measured on live boards, this recovers most of
// what the open-interest floor removed: SPY 78% -> 95% of the lattice, AAPL
// 91% -> 95%. What is left over is genuine edges, where a column simply has no
// quote on one side to bracket against.
//
// The honesty cost, stated because it is real: interpolating across two expiries
// that straddle an earnings date smooths a discontinuity that genuinely exists.
// `filled` marks which cells came from interpolation so a caller can report it.
export function fillGridInTime(grid) {
  if (!grid || !Array.isArray(grid.rows) || !grid.rows.length) return null;
  const cols = grid.moneyness.length;

  const rows = grid.rows.map((r) => ({
    date: r.date, dte: r.dte, t: r.t,
    values: r.values.slice(),
    filled: new Array(cols).fill(false),
  }));

  let quoted = 0, interpolated = 0;
  let ivMin = Infinity, ivMax = -Infinity;
  const note = (v) => { if (v < ivMin) ivMin = v; if (v > ivMax) ivMax = v; };

  for (let c = 0; c < cols; c++) {
    const samples = columnSamples(grid.rows, c);
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r].values[c];
      if (v !== null) { quoted++; note(v); continue; }
      const filledValue = varianceInterp(samples, rows[r].dte);
      if (filledValue === null) continue;
      rows[r].values[c] = filledValue;
      rows[r].filled[c] = true;
      interpolated++;
      note(filledValue);
    }
  }

  if (!quoted) return null;
  return {
    moneyness: grid.moneyness,
    rows,
    quoted,
    interpolated,
    covered: quoted + interpolated,
    cells: rows.length * cols,
    ivMin, ivMax,
    dteMin: grid.dteMin, dteMax: grid.dteMax,
  };
}

// Resample onto a lattice UNIFORM IN log(dte), for the mesh.
//
// Uniform in log because the renderer already lays time out logarithmically, so
// uniform-in-log rows give uniform facet width on screen — which is the entire
// point of densifying. Over a 1 -> 1095 day board the step works out at ~15.7%
// per row: 1.0, 1.16, 1.34, 1.55 days at the front (finer than the listed
// board, so the front week resolves better than the quotes do) and 900 -> 1045
// at the back (coarser than listed, which is fine because LEAPS are flat).
//
// The rows this returns are SYNTHETIC tenors, so they carry no date. The real
// expiries ride along in `listed` — hover reports one of those, never an
// interpolated tenor that no contract actually has.
export function densifyGrid(grid, opts = {}) {
  const { rows: nRows = 49 } = opts;
  if (!grid || !Array.isArray(grid.rows) || grid.rows.length < 2) return null;
  if (!(nRows >= 2)) return null;

  const cols = grid.moneyness.length;
  const loLog = Math.log(Math.max(1, grid.dteMin));
  const hiLog = Math.log(Math.max(Math.max(1, grid.dteMin) + 1, grid.dteMax));

  const samplesByCol = [];
  for (let c = 0; c < cols; c++) samplesByCol.push(columnSamples(grid.rows, c));

  let covered = 0;
  let ivMin = Infinity, ivMax = -Infinity;
  const rows = [];
  for (let i = 0; i < nRows; i++) {
    // Pin the endpoints exactly; exp(log(x)) drifts in the last bits otherwise.
    const dte = i === 0 ? grid.dteMin
      : i === nRows - 1 ? grid.dteMax
      : Math.exp(loLog + ((hiLog - loLog) * i) / (nRows - 1));
    const values = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const v = varianceInterp(samplesByCol[c], dte);
      values[c] = v;
      if (v !== null) {
        covered++;
        if (v < ivMin) ivMin = v;
        if (v > ivMax) ivMax = v;
      }
    }
    rows.push({ dte, t: dte / 365, values });
  }

  if (!covered) return null;
  return {
    moneyness: grid.moneyness,
    rows,
    listed: grid.rows.map((r) => ({ date: r.date, dte: r.dte })),
    ivMin, ivMax,
    covered,
    cells: nRows * cols,
    dteMin: grid.dteMin,
    dteMax: grid.dteMax,
  };
}

// ── Colour domain ───────────────────────────────────────────────────────────
// Robust range for the colour ramp: the loPct/hiPct quantiles of the covered
// cells rather than raw min/max.
//
// Raw min/max is a trap here. A single 1-DTE wing can print 64% against a body
// that lives between 15% and 25%, which pins the entire readable part of the
// surface into the bottom fifth of the ramp. Clamping to p2-p98 gives the body
// usable contrast; anything beyond the clamp still draws at its true HEIGHT and
// still reads its true value on hover, so nothing is hidden — the legend just
// says "≥" and the caller states it.
//
// Type-7 (the numpy/R default) linear-interpolated quantile, named so the tests
// can assert exact values.
export function ivColorDomain(grid, opts = {}) {
  const { loPct = 0.02, hiPct = 0.98, minSpan = 0.02 } = opts;
  if (!grid || !Array.isArray(grid.rows)) return null;

  const vals = [];
  for (const r of grid.rows) {
    for (const v of r.values) if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);

  const q = (p) => {
    const h = (vals.length - 1) * Math.min(1, Math.max(0, p));
    const i = Math.floor(h);
    const frac = h - i;
    return i + 1 < vals.length ? vals[i] + (vals[i + 1] - vals[i]) * frac : vals[i];
  };

  const ivMin = vals[0], ivMax = vals[vals.length - 1];
  let lo = q(loPct), hi = q(hiPct);

  // A genuinely flat surface would otherwise amplify a few tenths of a vol
  // point of noise across the whole ramp.
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  return { lo, hi, ivMin, ivMax, clampedLo: lo > ivMin, clampedHi: hi < ivMax };
}

// ── Axis ticks ──────────────────────────────────────────────────────────────
// Round tick values inside [lo, hi], from a 1/2/2.5/5 ladder.
//
// Picks the step whose resulting tick COUNT is closest to target, rather than
// the first step at least as large as the raw spacing. The ceiling rule is the
// obvious implementation and it overshoots badly: on a 12.1%-63.9% IV range
// asking for 6 it computes a raw spacing of 0.104, rejects 0.10 for being a
// hair under, jumps to 0.20 and returns three ticks.
export function niceTicks(lo, hi, target = 6) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || !(target >= 2)) return [];
  const raw = (hi - lo) / (target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));

  let best = null, bestScore = Infinity;
  for (const m of [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10]) {
    const step = mag * m;
    if (!(step > 0)) continue;
    const n = Math.floor(hi / step + 1e-9) - Math.ceil(lo / step - 1e-9) + 1;
    if (n < 2) continue;
    // Ties go to the finer step — a slightly busy axis beats a bare one.
    const score = Math.abs(n - target) + (n < target ? 0.25 : 0);
    if (score < bestScore) { bestScore = score; best = step; }
  }
  if (best === null) return [];

  const out = [];
  for (let i = Math.ceil(lo / best - 1e-9); i * best <= hi + best * 1e-9; i++) {
    out.push(Number((i * best).toFixed(10)));
  }
  return out;
}

// Expiry ticks on a log axis, drawn from tenors a trader actually names.
//
// Two things matter here. The ladder is deliberately the NAMED tenors only —
// including 2, 3, 21, 45, 120, 270 and friends would be more "complete" and
// reads as clutter, because nobody thinks in 270-day options. And the log-gap
// filter is what stops the front of the axis turning to mush: 1, 2 and 3 sit
// almost on top of each other once the board runs out to three years, so a
// tick is dropped whenever it would land within minLogGap of the last one kept.
export function dteTicks(dteMin, dteMax, opts = {}) {
  const { minLogGap = 0.55 } = opts;
  if (!Number.isFinite(dteMin) || !Number.isFinite(dteMax) || dteMax <= dteMin) return [];
  const CANDIDATES = [1, 7, 14, 30, 60, 90, 180, 365, 730, 1095];
  const out = [];
  let lastLog = -Infinity;
  for (const d of CANDIDATES) {
    if (d < dteMin - 1e-9 || d > dteMax + 1e-9) continue;
    const l = Math.log(d);
    if (l - lastLog < minLogGap) continue;
    out.push(d);
    lastLog = l;
  }
  return out;
}

// How many contracts carry a usable implied-volatility quote. Shared by
// analyzeChain and the page so the two can never drift apart.
export function countIvQuotes(contracts) {
  if (!Array.isArray(contracts)) return 0;
  let n = 0;
  for (const c of contracts) {
    const iv = Number(c && c.iv);
    if (Number.isFinite(iv) && iv > 0) n++;
  }
  return n;
}

// ── Surface grid ────────────────────────────────────────────────────────────
// Resample the (irregular) smiles onto a regular moneyness × expiry lattice so
// a renderer can build a mesh from it. Pure and unit-tested; the WebGL module
// only turns the numbers into triangles.
//
// Listed strikes differ from expiry to expiry, so this interpolates each row at
// shared moneyness columns. A cell whose moneyness falls outside that expiry's
// covered strikes is `null`, NOT a filled-in guess — the caller drops those
// quads and the surface ends up with an honestly ragged edge showing exactly
// where the board stops. Filling them would fabricate the wings the ±25% window
// removed, which is the one thing this module refuses to do everywhere else.
//
// Expiries are thinned in LOG time when there are more than maxRows. Chains run
// out to three years, and evenly-spaced-in-days sampling spends most of its rows
// on LEAPS while throwing away the front weeks where the surface actually moves.
export function surfaceGrid(smiles, opts = {}) {
  const {
    cols = 41,
    moneynessSpan = 0.15,
    maxRows = 22,
    minRows = 2,
    // Swappable per-cell reader, defaulting to the plain linear interpolation
    // above. A caller can pass a smoothed reader (see js/tools/svi.js) that
    // still returns null outside the quoted range — surfaceGrid itself stays
    // ignorant of where the value came from.
    ivReader = ivAtMoneyness,
  } = opts;
  if (!Array.isArray(smiles) || smiles.length < minRows) return null;
  if (!(cols >= 2) || !(moneynessSpan > 0)) return null;

  const usable = smiles.filter((s) => s && Array.isArray(s.points) && s.points.length >= 2 && s.dte > 0);
  if (usable.length < minRows) return null;

  const picked = thinByLogDte(usable, maxRows);

  const moneyness = Array.from({ length: cols },
    (_, i) => -moneynessSpan + (2 * moneynessSpan * i) / (cols - 1));

  let ivMin = Infinity, ivMax = -Infinity, covered = 0;
  const rows = picked.map((s) => {
    const values = moneyness.map((m) => {
      const v = ivReader(s, m);
      if (v === null) return null;
      covered++;
      if (v < ivMin) ivMin = v;
      if (v > ivMax) ivMax = v;
      return v;
    });
    return { date: s.date, dte: s.dte, t: s.t, values };
  });

  if (!covered || !Number.isFinite(ivMin)) return null;
  return {
    moneyness,
    rows,
    ivMin,
    ivMax,
    covered,
    cells: rows.length * cols,
    dteMin: rows[0].dte,
    dteMax: rows[rows.length - 1].dte,
  };
}

// Keep the first and last expiry, and spread the rest evenly across log(dte).
function thinByLogDte(smiles, maxRows) {
  if (smiles.length <= maxRows) return smiles;
  const lo = Math.log(smiles[0].dte);
  const hi = Math.log(smiles[smiles.length - 1].dte);
  const chosen = new Set([0, smiles.length - 1]);
  for (let i = 1; i < maxRows - 1; i++) {
    const target = lo + ((hi - lo) * i) / (maxRows - 1);
    let best = 0, bestD = Infinity;
    for (let j = 0; j < smiles.length; j++) {
      const d = Math.abs(Math.log(smiles[j].dte) - target);
      if (d < bestD) { bestD = d; best = j; }
    }
    chosen.add(best);
  }
  return [...chosen].sort((a, b) => a - b).map((i) => smiles[i]);
}

// The expiry a skew reading should describe: the listed smile closest to the
// target tenor, preferring one that actually has an ATM level.
//
// Deliberately NOT the front expiry. The front is very often tomorrow, and a
// 1-DTE smile is a steep V rather than a line — on a live SPY chain the front
// smile fitted at r2 = 0.38 against 0.6-0.9 for the monthlies. Anchoring the
// headline skew there would make it jump around for reasons that have nothing
// to do with skew. Around 30 days is the standard reference tenor, and it pairs
// with the 30-day ATM reading shown beside it.
export function referenceSmile(smiles, targetDays = VOL_DEFAULTS.targetDays) {
  if (!Array.isArray(smiles) || !smiles.length) return null;
  const withAtm = smiles.filter((s) => atmIv(s) !== null);
  const pool = withAtm.length ? withAtm : smiles;
  return pool.reduce((best, s) =>
    Math.abs(s.dte - targetDays) < Math.abs(best.dte - targetDays) ? s : best, pool[0]);
}

// ── One-shot analysis for a page controller ─────────────────────────────────
// Returns null when the chain yields no usable surface at all, so the caller
// can show a single clean empty state instead of six blank panels.
export function analyzeChain(contracts, spot, today, opts = {}) {
  const cfg = { ...VOL_DEFAULTS, ...opts };
  const total = Array.isArray(contracts) ? contracts.length : 0;
  const withIv = Array.isArray(contracts)
    ? contracts.reduce((n, c) => n + (Number.isFinite(Number(c.iv)) && c.iv > 0 ? 1 : 0), 0)
    : 0;

  const smiles = buildSmiles(contracts, spot, today, cfg);
  if (!smiles.length) return null;

  const term = termStructure(smiles);
  const iv30 = interpolateAtmIv(term, cfg.targetDays);
  const front = smiles[0];
  const ref = referenceSmile(smiles, cfg.targetDays);

  return {
    smiles,
    term,
    iv30,
    frontAtm: front ? atmIv(front) : null,
    frontDate: front ? front.date : null,
    frontDte: front ? front.dte : null,
    // Skew describes the reference expiry, not the front — see referenceSmile.
    refDate: ref ? ref.date : null,
    refDte: ref ? ref.dte : null,
    refAtm: ref ? atmIv(ref) : null,
    slope: ref ? skewSlope(ref, cfg) : null,
    skew: ref ? skewAtMoneyness(ref, cfg.skewMoneyness) : null,
    termShape: termSlope(term, cfg.targetDays),
    coverage: { withIv, total, expiries: smiles.length, quoted: smiles.reduce((n, s) => n + s.n, 0) },
  };
}
