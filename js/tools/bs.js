// bs.js — Black-Scholes-Merton pricing, greeks, and implied-volatility solving.
// Pure functions only (no DOM, no fetch), so the same code runs in the browser,
// in Node scripts, and under `node --test`.
//
// This module has NO data dependency at all — everything is computed from the
// caller's inputs. That is deliberate: it makes the Greeks Lab work for any
// ticker, any contract, forever, with no feed to go stale.
//
// ── Conventions (the page states these verbatim; mismatched units are the
//    single most common way an options calculator misleads) ─────────────────
//   T      time to expiry in YEARS, ACT/365
//   sigma  volatility as a DECIMAL (0.25 = 25%)
//   r, q   continuously-compounded risk-free rate / dividend yield, decimals
//   delta  per $1 of underlying
//   gamma  per $1^2 of underlying (raw d2V/dS2)
//   vega   RAW dV/dsigma — per 1.00 of vol, i.e. per 100 vol points
//   theta  RAW dV/dt in CALENDAR time — per YEAR. Negative for a long option.
//   rho    RAW dV/dr — per 1.00 of rate, i.e. per 10,000 bp
//
// Everything returned here is the RAW mathematical greek. Display scaling
// (per vol point, per day, per 1% of rate) belongs to the page, which labels
// each figure with the units it is showing — see the constants below.
//
// ── Model formulas ─────────────────────────────────────────────────────────
//   Dq = e^(-qT),  Dr = e^(-rT),  N = normCdf,  phi = normPdf
//   d1 = [ln(S/K) + (r - q + sigma^2/2)T] / (sigma*sqrt(T)),  d2 = d1 - sigma*sqrt(T)
//   Call  = S*Dq*N(d1) - K*Dr*N(d2)
//   Put   = K*Dr*N(-d2) - S*Dq*N(-d1)
//   dC    = Dq*N(d1)                    dP    = -Dq*N(-d1)
//   Gamma = Dq*phi(d1) / (S*sigma*sqrt(T))        [same for calls and puts]
//   Vega  = S*Dq*phi(d1)*sqrt(T)                  [same for calls and puts]
//   ThC   = -S*Dq*phi(d1)*sigma/(2*sqrt(T)) - r*K*Dr*N(d2)  + q*S*Dq*N(d1)
//   ThP   = -S*Dq*phi(d1)*sigma/(2*sqrt(T)) + r*K*Dr*N(-d2) - q*S*Dq*N(-d1)
//   RhoC  = K*T*Dr*N(d2)                RhoP  = -K*T*Dr*N(-d2)
//
// ── On returning null ──────────────────────────────────────────────────────
// The house rule elsewhere in js/tools is "return null, never a fake neutral,
// when the data is insufficient". That rule is about MISSING DATA. It does not
// apply to T = 0 or sigma = 0, which are not missing inputs — they are
// well-defined limits of the model, and the payoff chart depends on the T = 0
// branch to draw the expiry kink. So those return their limiting values, and
// null is reserved for genuinely invalid input (non-positive S or K, negative
// T, anything non-finite).

export const DAYS_PER_YEAR = 365;

// Multiply a RAW greek by these to get the conventionally-quoted figure.
export const VEGA_PER_VOL_POINT = 0.01;   // raw vega -> per 1 vol point
export const THETA_PER_DAY = 1 / DAYS_PER_YEAR; // raw theta -> per calendar day
export const RHO_PER_PCT = 0.01;          // raw rho -> per 1% (100bp) rate move

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const INV_SQRT_2PI = 1 / SQRT_2PI;

// ── Normal distribution ─────────────────────────────────────────────────────
export function normPdf(x) {
  if (!Number.isFinite(x)) return 0;
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

// Hart (1968) rational approximation, in the arrangement given by West (2005).
// Double-precision accurate (~1e-16), where the Abramowitz-Stegun 26.2.17
// polynomial most calculators reach for tops out around 7.5e-8 — too coarse to
// assert published reference prices at 1e-6, and it starves the Newton solver
// of precision exactly where it is trying to converge.
//
// Computed on the TAIL for |x| and mirrored at the end. That structure is what
// makes normCdf(x) + normCdf(-x) === 1 hold exactly, to the last bit, which in
// turn makes put-call parity an exact invariant rather than something that
// merely passes within a tolerance.
export function normCdf(x) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const z = Math.abs(x);
  let c;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let b = 3.52624965998911e-02 * z + 0.700383064443688;
      b = b * z + 6.37396220353165;
      b = b * z + 33.912866078383;
      b = b * z + 112.079291497871;
      b = b * z + 221.213596169931;
      b = b * z + 220.206867912376;
      let d = 8.83883476483184e-02 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = e * b / d;
    } else {
      // Continued fraction for the far tail.
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / (b * SQRT_2PI);
    }
  }
  return x > 0 ? 1 - c : c;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
export function yearsFromDays(days) {
  return Number.isFinite(days) ? days / DAYS_PER_YEAR : NaN;
}

function isCall(type) {
  return String(type || '').trim().toUpperCase().startsWith('C');
}

// Payoff if exercised right now, undiscounted.
export function intrinsic(type, S, K) {
  if (!Number.isFinite(S) || !Number.isFinite(K)) return NaN;
  return isCall(type) ? Math.max(0, S - K) : Math.max(0, K - S);
}

// Valid input for the pricing model at all? (T = 0 and sigma = 0 ARE valid.)
function validInputs(S, K, T, r, sigma, q) {
  return Number.isFinite(S) && S > 0 &&
    Number.isFinite(K) && K > 0 &&
    Number.isFinite(T) && T >= 0 &&
    Number.isFinite(r) && Number.isFinite(q) &&
    Number.isFinite(sigma) && sigma >= 0;
}

// Returns null in the degenerate cases where d1/d2 are undefined (T or sigma
// zero) — callers handle those limits explicitly rather than through here.
export function d1d2(S, K, T, r, sigma, q = 0) {
  if (!validInputs(S, K, T, r, sigma, q)) return null;
  if (T <= 0 || sigma <= 0) return null;
  const vs = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / vs;
  return { d1, d2: d1 - vs };
}

// ── Pricing ─────────────────────────────────────────────────────────────────
export function bsPrice(type, S, K, T, r, sigma, q = 0) {
  if (!validInputs(S, K, T, r, sigma, q)) return null;
  const Dq = Math.exp(-q * T);
  const Dr = Math.exp(-r * T);

  // Limit case: with no time or no vol the option is worth the discounted
  // forward intrinsic. At T = 0 both discount factors are 1 and this collapses
  // to plain intrinsic, which is what the payoff-at-expiry curve draws.
  if (T <= 0 || sigma <= 0) {
    return isCall(type) ? Math.max(0, S * Dq - K * Dr) : Math.max(0, K * Dr - S * Dq);
  }

  const { d1, d2 } = d1d2(S, K, T, r, sigma, q);
  return isCall(type)
    ? S * Dq * normCdf(d1) - K * Dr * normCdf(d2)
    : K * Dr * normCdf(-d2) - S * Dq * normCdf(-d1);
}

// ── Greeks ──────────────────────────────────────────────────────────────────
export function bsGreeks(type, S, K, T, r, sigma, q = 0) {
  if (!validInputs(S, K, T, r, sigma, q)) return null;
  const call = isCall(type);
  const Dq = Math.exp(-q * T);
  const Dr = Math.exp(-r * T);
  const price = bsPrice(type, S, K, T, r, sigma, q);

  // Limit case. Delta becomes the step function (the payoff's own slope), and
  // every second-order greek vanishes. Returning these rather than null is
  // what lets the greek-vs-spot chart render a correct step at DTE 0 instead
  // of a blank canvas or a row of NaN.
  if (T <= 0 || sigma <= 0) {
    const fwdITM = call ? (S * Dq > K * Dr) : (K * Dr > S * Dq);
    const atBoundary = S * Dq === K * Dr;
    const delta = atBoundary ? (call ? 0.5 : -0.5) : (fwdITM ? (call ? Dq : -Dq) : 0);
    return { price, delta, gamma: 0, vega: 0, theta: 0, rho: 0, d1: null, d2: null };
  }

  const { d1, d2 } = d1d2(S, K, T, r, sigma, q);
  const sqrtT = Math.sqrt(T);
  const pdf1 = normPdf(d1);

  const gamma = Dq * pdf1 / (S * sigma * sqrtT);
  const vega = S * Dq * pdf1 * sqrtT;
  const decay = -S * Dq * pdf1 * sigma / (2 * sqrtT);

  const delta = call ? Dq * normCdf(d1) : -Dq * normCdf(-d1);
  const theta = call
    ? decay - r * K * Dr * normCdf(d2) + q * S * Dq * normCdf(d1)
    : decay + r * K * Dr * normCdf(-d2) - q * S * Dq * normCdf(-d1);
  const rho = call ? K * T * Dr * normCdf(d2) : -K * T * Dr * normCdf(-d2);

  return { price, delta, gamma, vega, theta, rho, d1, d2 };
}

// ── Implied volatility ──────────────────────────────────────────────────────
// No-arbitrage price bounds. Price is strictly increasing in sigma, so these
// are exactly the values approached as sigma -> 0 and sigma -> infinity, and a
// target outside them has no solution at any volatility.
export function priceBounds(type, S, K, T, r, q = 0) {
  if (!Number.isFinite(S) || !Number.isFinite(K) || !Number.isFinite(T)) return null;
  const Dq = Math.exp(-q * T);
  const Dr = Math.exp(-r * T);
  return isCall(type)
    ? { lo: Math.max(0, S * Dq - K * Dr), hi: S * Dq }
    : { lo: Math.max(0, K * Dr - S * Dq), hi: K * Dr };
}

const SIGMA_MIN = 1e-8;
const SIGMA_MAX = 5.0;   // 500% vol; past here the BS inversion is meaningless

// Invert bsPrice for sigma.
//
// Safeguarded Newton: a bisection bracket is maintained at EVERY step, and any
// Newton step that is non-finite, leaves the bracket, or divides by a vanishing
// vega is replaced by a bisection step. That matters because plain Newton
// diverges precisely where these solvers get used in anger — deep ITM/OTM and
// near expiry, where vega collapses toward zero. The usual "try Newton, fall
// back to bisection on failure" arrangement both diverges first and then throws
// away the work; carrying the bracket gives unconditional convergence (bisection
// is the floor) while keeping Newton's quadratic rate in the common case.
//
// Returns null when there is genuinely no solution rather than a plausible
// number: outside the no-arbitrage bounds, at intrinsic (where sigma is
// undetermined and a returned 0 would be a lie), or on invalid input.
//
// Conditioning caveat, worth knowing before trusting the last digits: sigma is
// recovered from price, so the achievable precision is (price tolerance / vega).
// Far out in the wings vega collapses and the problem becomes ill-conditioned —
// e.g. a 2-year 30%-OTM put at 5% vol is worth ~1.7e-9 with vega ~1.3e-6, so
// even an exact price match pins sigma only to ~1e-4. That is a property of the
// option, not of this solver: at those prices the quote carries no volatility
// information. It never bites in practice, where quotes are penny-wide.
export function impliedVol(type, targetPrice, S, K, T, r, q = 0, opts = {}) {
  const { maxIter = 60, tol = 1e-10 } = opts;
  if (!Number.isFinite(targetPrice) || !Number.isFinite(S) || S <= 0 ||
      !Number.isFinite(K) || K <= 0 || !Number.isFinite(T) || T <= 0 ||
      !Number.isFinite(r) || !Number.isFinite(q)) return null;

  const bounds = priceBounds(type, S, K, T, r, q);
  if (!bounds) return null;
  const absTol = Math.max(tol, tol * Math.abs(targetPrice));

  // Outside the no-arbitrage band, or sitting on intrinsic where every
  // sufficiently small sigma prices the same.
  if (targetPrice <= bounds.lo + absTol) return null;
  if (targetPrice >= bounds.hi - absTol) return null;

  let lo = SIGMA_MIN, hi = SIGMA_MAX;
  if (bsPrice(type, S, K, T, r, hi, q) < targetPrice) return null;

  // Brenner-Subrahmanyam seed: a closed-form ATM approximation, good enough to
  // put Newton in the right neighbourhood on the common near-the-money case.
  let sigma = Math.sqrt(2 * Math.PI / T) * targetPrice / S;
  if (!Number.isFinite(sigma) || sigma <= lo || sigma >= hi) sigma = 0.5 * (lo + hi);

  for (let i = 0; i < maxIter; i++) {
    const g = bsGreeks(type, S, K, T, r, sigma, q);
    if (!g) return null;
    const diff = g.price - targetPrice;
    if (Math.abs(diff) <= absTol) return sigma;

    // Tighten the bracket using monotonicity in sigma.
    if (diff > 0) hi = sigma; else lo = sigma;
    if (hi - lo < 1e-12) return sigma;

    let next = g.vega > 1e-12 ? sigma - diff / g.vega : NaN;
    if (!Number.isFinite(next) || next <= lo || next >= hi) next = 0.5 * (lo + hi);
    sigma = next;
  }
  return null;
}
