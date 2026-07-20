// fred.js — FRED (Federal Reserve Economic Data) CSV helpers. Pure functions
// (no fetch) shared by the Node prefetch pipeline and unit tests.
//
// Source: https://fred.stlouisfed.org/graph/fredgraph.csv?id={SERIES} — no
// API key required, one series per request. Rows are "observation_date,value";
// missing observations (holidays on daily series, or an occasional gap) are
// simply absent rows in current-format FRED CSVs, but a "." placeholder is
// also handled defensively since older exports use it.

// Parse "observation_date,SERIES\nYYYY-MM-DD,123.45\n..." into
// [{date:'YYYY-MM-DD', value:number}], ascending by date, skipping missing rows.
export function parseFredCsv(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) { // skip header
    const line = lines[i].trim();
    if (!line) continue;
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const date = line.slice(0, comma).trim();
    const raw = line.slice(comma + 1).trim();
    if (raw === '.' || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out.push({ date, value });
  }
  return out;
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

// Find the series point closest to `targetDate`, within ±toleranceDays.
// Series must be ascending by date. Returns null if nothing is close enough.
export function nearestPoint(series, targetDate, toleranceDays = 20) {
  let best = null, bestDist = Infinity;
  for (const p of series) {
    const d = Math.abs(daysBetween(p.date, targetDate));
    if (d < bestDist) { bestDist = d; best = p; }
    if (p.date > targetDate && bestDist <= toleranceDays) break; // series is sorted; can stop once we've passed and matched
  }
  return bestDist <= toleranceDays ? best : null;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Year-over-year % change series: for each point, find the value ~365 days
// earlier (within tolerance) and compute percent change. Points with no
// valid prior-year match are skipped (typically the first ~year of history).
export function yoySeries(series, { toleranceDays = 20 } = {}) {
  const out = [];
  for (const p of series) {
    const priorTarget = addDays(p.date, -365);
    const prior = nearestPoint(series, priorTarget, toleranceDays);
    if (!prior || prior.value === 0) continue;
    out.push({ date: p.date, value: ((p.value / prior.value) - 1) * 100 });
  }
  return out;
}

export function trimSince(series, cutoffDate) {
  return series.filter((p) => p.date >= cutoffDate);
}

// Downsample a long series to at most maxPoints, always keeping the last point.
export function thinTo(series, maxPoints) {
  if (series.length <= maxPoints) return series;
  const step = Math.ceil(series.length / maxPoints);
  const out = [];
  for (let i = 0; i < series.length; i += step) out.push(series[i]);
  const last = series[series.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function latest(series) {
  return series.length ? series[series.length - 1] : null;
}

// Compare the latest value to the value ~monthsBack earlier; used for the
// balance-sheet 3-month delta that drives the regime matrix, and for simple
// "latest + change" stat cards.
export function deltaOverMonths(series, monthsBack, { toleranceDays = 20 } = {}) {
  const last = latest(series);
  if (!last) return null;
  const priorTarget = addDays(last.date, -monthsBack * 30);
  const prior = nearestPoint(series, priorTarget, toleranceDays);
  if (!prior || prior.value === 0) return { latest: last, prior: null, deltaPct: null };
  const deltaPct = ((last.value / prior.value) - 1) * 100;
  return { latest: last, prior, deltaPct };
}
