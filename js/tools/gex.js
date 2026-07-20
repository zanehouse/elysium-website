// gex.js — Gamma Exposure: contract auto-selection + aggregation.
// Pure functions only (no DOM, no fetch) so the exact same logic runs in the
// Node prefetch pipeline and in the browser, and is unit-tested under node --test.
//
// GEX convention (stated verbatim in the tool's methodology note):
//   dollar gamma per 1% move  =  Γ × OI × 100 × Spot² × 0.01
//   calls contribute positive GEX, puts negative (naive dealer-positioning).

export const DEFAULTS = {
  strikePct: 0.12,          // strike window: ±12% of spot
  floorDefault: 200,        // open-interest floor (contracts below are dropped)
  floors: {
    SPX: 100, SPY: 500, QQQ: 500, RUT: 100, NDX: 50, IWM: 300, DIA: 100, XSP: 50,
    TLT: 200, GLD: 150, SLV: 100, SMH: 100,
    // Lower-priced / more speculative single names carry high OI at low strikes
    // even when the stock itself isn't especially liquid — a lower floor avoids
    // an empty auto-selection for these.
    GME: 50, AMC: 50, SOFI: 80, RIVN: 60, SNAP: 60, PLTR: 100, COIN: 60, MSTR: 60, HOOD: 60,
  },
  autoDteMax: 30,           // auto-include every expiry within 30 days
  minVolumeDefault: 1,      // strikes with zero volume today are dropped (see selectContracts)
};

export function floorFor(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/^_/, '');
  return DEFAULTS.floors[s] ?? DEFAULTS.floorDefault;
}

// ── Date helpers (UTC-safe, no timezone drift) ──────────────────────────────
export function parseISODate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}

export function daysBetween(fromStr, toStr) {
  const a = parseISODate(fromStr);
  const b = parseISODate(toStr);
  return Math.round((b - a) / 86400000);
}

// Third Friday of a given year/month (monthly standard OPEX). month is 1-12.
export function thirdFriday(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstDow = first.getUTCDay();               // 0=Sun … 5=Fri
  const firstFriday = 1 + ((5 - firstDow + 7) % 7);
  return firstFriday + 14;                            // + two weeks
}

export function isThirdFriday(dateStr) {
  const d = parseISODate(dateStr);
  return d.getUTCDay() === 5 && d.getUTCDate() === thirdFriday(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

// ── Expiry enumeration ──────────────────────────────────────────────────────
// today: 'YYYY-MM-DD'. Returns sorted [{date, dte, opex}].
export function enumerateExpiries(contracts, today) {
  const seen = new Set();
  for (const c of contracts) seen.add(c.expiry);
  return [...seen]
    .map((date) => ({ date, dte: daysBetween(today, date), opex: isThirdFriday(date) }))
    .filter((e) => e.dte >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// The auto-selection rule set — the "contracts that matter" logic.
// Includes: 0DTE (today's expiry if present), every expiry with dte ≤ autoDteMax,
// plus the next monthly OPEX (third Friday) even if it is beyond that window.
// Returns a Set of expiry-date strings.
export function autoSelectExpiries(expiryInfos, { autoDteMax = DEFAULTS.autoDteMax } = {}) {
  const set = new Set();
  for (const e of expiryInfos) {
    if (e.dte <= autoDteMax) set.add(e.date);
  }
  const nextOpex = expiryInfos
    .filter((e) => e.opex && e.dte > 0)
    .sort((a, b) => a.dte - b.dte)[0];
  if (nextOpex) set.add(nextOpex.date);
  return set;
}

// Resolve a dropdown preset to the set of expiry dates it selects.
// preset is one of: 'auto' | 'all' | '7d' | '30d' | an exact 'YYYY-MM-DD'.
export function expiriesForPreset(expiryInfos, preset) {
  if (preset === 'all') return new Set(expiryInfos.map((e) => e.date));
  if (preset === '7d') return new Set(expiryInfos.filter((e) => e.dte <= 7).map((e) => e.date));
  if (preset === '30d') return new Set(expiryInfos.filter((e) => e.dte <= 30).map((e) => e.date));
  if (preset === 'auto' || !preset) return autoSelectExpiries(expiryInfos, {});
  // A specific expiry date: select it alone if present, else fall back to auto.
  const match = expiryInfos.find((e) => e.date === preset);
  return match ? new Set([match.date]) : autoSelectExpiries(expiryInfos, {});
}

// ── Contract selection ──────────────────────────────────────────────────────
// Filter to selected expiries, strikes within ±strikePct of spot, OI ≥ minOI,
// volume ≥ minVolume (default 0 — off unless a caller opts in). The volume
// floor exists to drop strikes that carry stale/legacy OI but saw zero
// trading today, which otherwise stretch the chart's strike axis out toward
// far strikes with nothing visually meaningful to show.
// Returns { selected, summary } where summary drives the transparency line.
export function selectContracts(contracts, { expirySet, spot, strikePct = DEFAULTS.strikePct, minOI, minVolume = 0 }) {
  const lo = spot * (1 - strikePct);
  const hi = spot * (1 + strikePct);
  const selected = contracts.filter((c) =>
    expirySet.has(c.expiry) &&
    c.strike >= lo && c.strike <= hi &&
    c.oi >= minOI &&
    (c.volume || 0) >= minVolume &&
    Number.isFinite(c.gamma)
  );
  const strikes = selected.map((c) => c.strike);
  const expiries = [...new Set(selected.map((c) => c.expiry))].sort();
  return {
    selected,
    summary: {
      nTotal: contracts.length,
      nSelected: selected.length,
      nExpiries: expiries.length,
      expiries,
      strikeMin: strikes.length ? Math.min(...strikes) : null,
      strikeMax: strikes.length ? Math.max(...strikes) : null,
      minOI,
      minVolume,
      strikePct,
    },
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────
// per contract: gex = Γ × weight × 100 × Spot² × 0.01 ; calls +, puts −.
// weight is open interest (the standard, settled overnight) or today's
// traded volume (reflects intraday flow) — selected via weightBy.
export function contractGex(c, spot, weightBy = 'oi') {
  const weight = weightBy === 'volume' ? (c.volume || 0) : c.oi;
  const mag = c.gamma * weight * 100 * spot * spot * 0.01;
  return c.type === 'P' ? -mag : mag;
}

export function computeGex(selected, spot, weightBy = 'oi') {
  const byStrikeMap = new Map(); // strike -> {callGex, putGex}
  for (const c of selected) {
    const g = contractGex(c, spot, weightBy);
    let bucket = byStrikeMap.get(c.strike);
    if (!bucket) { bucket = { callGex: 0, putGex: 0 }; byStrikeMap.set(c.strike, bucket); }
    if (c.type === 'P') bucket.putGex += g; else bucket.callGex += g;
  }

  const byStrike = [...byStrikeMap.entries()]
    .map(([strike, b]) => ({ strike, callGex: b.callGex, putGex: b.putGex, netGex: b.callGex + b.putGex }))
    .sort((a, b) => a.strike - b.strike);

  // Cumulative net GEX from the lowest strike up.
  let run = 0;
  const cumulative = byStrike.map((r) => { run += r.netGex; return { strike: r.strike, cum: run }; });

  // Zero-gamma flip: interpolated zero-crossing of the cumulative curve,
  // choosing the crossing nearest spot when several exist.
  let flip = null, flipDist = Infinity;
  for (let i = 1; i < cumulative.length; i++) {
    const a = cumulative[i - 1], b = cumulative[i];
    if ((a.cum <= 0 && b.cum >= 0) || (a.cum >= 0 && b.cum <= 0)) {
      const span = b.cum - a.cum;
      const x = span === 0 ? a.strike : a.strike + (b.strike - a.strike) * (-a.cum / span);
      const d = Math.abs(x - spot);
      if (d < flipDist) { flipDist = d; flip = x; }
    }
  }

  let callWall = null, putWall = null, totalNet = 0;
  let maxNet = -Infinity, minNet = Infinity;
  for (const r of byStrike) {
    totalNet += r.netGex;
    if (r.netGex > maxNet) { maxNet = r.netGex; callWall = r.strike; }
    if (r.netGex < minNet) { minNet = r.netGex; putWall = r.strike; }
  }

  return { byStrike, cumulative, flip, callWall, putWall, totalNet };
}
