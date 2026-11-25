// signals.js — Smart-Money Signals: per-ticker composite score from data the
// site already ingests for other tools (no new data source). Pure functions
// (no DOM/fetch), unit-tested under node --test, same shape as macro.js.
//
// Three legs, each 0-100 (100 = bullish/stable smart-money read):
//   - insiderScore: net $ bought vs sold in SEC Form 4 filings (assets/data/insiders/<T>.json)
//   - skewScore: near-the-money put/call open-interest ratio (assets/data/gex/<T>.json)
//   - gammaRegimeScore: dealer net gamma sign/magnitude, self-normalized per ticker
//
// Congressional trade data has no ticker/amount in machine-readable form on
// this site (assets/data/congress.json is filer/date/PDF-link only), so it is
// deliberately NOT a leg here — it's surfaced elsewhere as an unscored,
// market-wide "recent filings" feed.

import { scorePutCall, composite } from './macro.js';
import { DEFAULTS, floorFor, selectContracts, computeGex } from './gex.js';

const INSIDER_WINDOW_DAYS = 180;

function daysAgo(dateStr, asOf) {
  const a = new Date(`${dateStr}T00:00:00Z`);
  const b = new Date(`${asOf}T00:00:00Z`);
  if (isNaN(a) || isNaN(b)) return Infinity;
  return Math.round((b - a) / 86400000);
}

// data: parsed assets/data/insiders/<TICKER>.json ({ filings: [{ tx: [...] }] }).
// asOf: 'YYYY-MM-DD', defaults to today (UTC). Returns null when there's no
// dollar-valued transaction in the window (nothing to score, not "neutral").
export function insiderScore(data, { asOf, windowDays = INSIDER_WINDOW_DAYS } = {}) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  let buy = 0, sell = 0;
  for (const f of (data && data.filings) || []) {
    for (const t of f.tx || []) {
      if (!t.value || daysAgo(t.date, today) > windowDays) continue;
      if (t.side === 'buy') buy += t.value;
      else if (t.side === 'sell') sell += t.value;
    }
  }
  const total = buy + sell;
  if (total <= 0) return null;
  const ratio = (buy - sell) / total; // -1 (all selling) .. +1 (all buying)
  return Math.max(0, Math.min(100, Math.round((ratio + 1) * 50)));
}

// contracts: assets/data/gex/<TICKER>.json's parsed chain contracts array.
// Near-the-money put/call OI ratio, reusing macro.js's existing put/call
// scale (0.70 -> 100 bullish, 1.30 -> 0 bearish) — the same convention
// already used for SPX-wide sentiment, applied here per single name.
export function skewScore(contracts, spot, { strikePct = 0.15 } = {}) {
  if (!Number.isFinite(spot) || spot <= 0 || !Array.isArray(contracts)) return null;
  const lo = spot * (1 - strikePct), hi = spot * (1 + strikePct);
  let callOi = 0, putOi = 0;
  for (const c of contracts) {
    if (c.strike < lo || c.strike > hi) continue;
    if (c.type === 'C') callOi += c.oi || 0;
    else if (c.type === 'P') putOi += c.oi || 0;
  }
  if (callOi <= 0) return null;
  return scorePutCall(putOi / callOi);
}

// contracts + spot: same GEX chain data as skewScore, run through the exact
// selection/aggregation the GEX tool itself uses (selectContracts + computeGex),
// so the regime read matches what a user sees on /tools/gex/ for this ticker.
// Net gamma is normalized by total |gamma| so tickers of any size land on the
// same -1..+1 scale before mapping to 0-100.
export function gammaRegimeScore(contracts, spot, symbol) {
  if (!Number.isFinite(spot) || spot <= 0 || !Array.isArray(contracts) || !contracts.length) return null;
  const expirySet = new Set(contracts.map((c) => c.expiry));
  const { selected } = selectContracts(contracts, {
    expirySet, spot, strikePct: DEFAULTS.strikePct, minOI: floorFor(symbol),
  });
  if (!selected.length) return null;
  const { byStrike, totalNet } = computeGex(selected, spot);
  const totalAbs = byStrike.reduce((s, r) => s + Math.abs(r.callGex) + Math.abs(r.putGex), 0);
  if (totalAbs <= 0) return null;
  const ratio = Math.max(-1, Math.min(1, totalNet / totalAbs));
  return Math.round((ratio + 1) * 50);
}

export function compositeScore(scores) {
  return composite(scores);
}

export function readLabel(score) {
  if (!Number.isFinite(score)) return 'Unavailable';
  if (score < 25) return 'Strongly Bearish';
  if (score < 45) return 'Bearish';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Bullish';
  return 'Strongly Bullish';
}
