// build-fred.mjs — prefetch FRED (Federal Reserve Economic Data) series and
// commit a reduced macro dashboard payload to assets/data/macro-fred.json.
//
// FRED's fredgraph.csv endpoint needs no API key, but it's one series per
// request and the daily series (yields, RRP) run to 10,000+ rows — this job
// fetches them in Node, computes YoY/deltas/the regime matrix with the SAME
// pure functions the browser would use (js/tools/fred.js, macro.js), and
// writes a small trimmed JSON for the page to load directly.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseFredCsv, yoySeries, trimSince, thinTo, latest, deltaOverMonths } from './js/tools/fred.js';
import { matrixQuadrant, rateRegime, bsTrend, MATRIX_RATE_HIGH_THRESHOLD } from './js/tools/macro.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'assets', 'data');

const SERIES = {
  cpi: 'CPIAUCSL', coreCpi: 'CPILFESL', corePce: 'PCEPILFE', unrate: 'UNRATE',
  fedFunds: 'FEDFUNDS', walcl: 'WALCL', m2: 'M2SL', rrp: 'RRPONTSYD',
  dgs3mo: 'DGS3MO', dgs2: 'DGS2', dgs5: 'DGS5', dgs10: 'DGS10', dgs30: 'DGS30',
  t10y2y: 'T10Y2Y',
};

const CHART_POINTS_MAX = 260; // ~1 point/week over 5y, plenty for a line chart

function tenYearsAgo() {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 10);
  return d.toISOString().slice(0, 10);
}

function fiveYearsAgo() {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

async function fetchSeries(id) {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
  if (!res.ok) throw new Error(`FRED ${id} HTTP ${res.status}`);
  return parseFredCsv(await res.text());
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const raw = {};
  for (const [key, id] of Object.entries(SERIES)) {
    try {
      raw[key] = await fetchSeries(id);
      console.log(`  ${id.padEnd(10)} ${raw[key].length} points, latest ${latest(raw[key])?.date}`);
    } catch (err) {
      console.error(`  ${id.padEnd(10)} FAILED: ${err.message}`);
      raw[key] = [];
    }
  }

  // ── Latest stat-card values ────────────────────────────────────────────
  const cpiYoy = yoySeries(raw.cpi);
  const coreCpiYoy = yoySeries(raw.coreCpi);
  const corePceYoy = yoySeries(raw.corePce);
  const m2Yoy = yoySeries(raw.m2);
  const walclDelta3mo = deltaOverMonths(raw.walcl, 3);

  const latestOf = (series) => latest(series);

  const latestBlock = {
    cpiYoy: latestOf(cpiYoy),
    coreCpiYoy: latestOf(coreCpiYoy),
    corePceYoy: latestOf(corePceYoy),
    unrate: latestOf(raw.unrate),
    fedFunds: latestOf(raw.fedFunds),
    walcl: latestOf(raw.walcl),
    walclDeltaPct3mo: walclDelta3mo ? walclDelta3mo.deltaPct : null,
    m2Yoy: latestOf(m2Yoy),
    rrp: latestOf(raw.rrp),
    t10y2y: latestOf(raw.t10y2y),
  };

  // ── Regime matrix ───────────────────────────────────────────────────────
  const fedFundsVal = latestBlock.fedFunds ? latestBlock.fedFunds.value : NaN;
  const walclDeltaVal = latestBlock.walclDeltaPct3mo;
  const matrix = {
    quadrant: matrixQuadrant(fedFundsVal, walclDeltaVal),
    rateRegime: rateRegime(fedFundsVal),
    bsTrend: bsTrend(walclDeltaVal),
    rateHighThreshold: MATRIX_RATE_HIGH_THRESHOLD,
    fedFunds: latestBlock.fedFunds,
    walclDeltaPct3mo: walclDeltaVal,
  };

  // ── Yield curve snapshot (now vs. ~1 year ago) ─────────────────────────
  const maturities = [
    { label: '3M', series: raw.dgs3mo }, { label: '2Y', series: raw.dgs2 },
    { label: '5Y', series: raw.dgs5 }, { label: '10Y', series: raw.dgs10 },
    { label: '30Y', series: raw.dgs30 },
  ];
  const yieldCurveNow = maturities.map((m) => ({ label: m.label, value: latest(m.series)?.value ?? null }));
  const yieldCurve1yAgo = maturities.map((m) => {
    const d = deltaOverMonths(m.series, 12);
    return { label: m.label, value: d && d.prior ? d.prior.value : null };
  });

  // ── Chart series (trimmed + thinned) ────────────────────────────────────
  const tenY = tenYearsAgo(), fiveY = fiveYearsAgo();
  const series = {
    cpiYoy: thinTo(trimSince(cpiYoy, tenY), CHART_POINTS_MAX),
    coreCpiYoy: thinTo(trimSince(coreCpiYoy, tenY), CHART_POINTS_MAX),
    corePceYoy: thinTo(trimSince(corePceYoy, tenY), CHART_POINTS_MAX),
    fedFunds: thinTo(trimSince(raw.fedFunds, tenY), CHART_POINTS_MAX),
    walcl: thinTo(trimSince(raw.walcl, tenY), CHART_POINTS_MAX).map((p) => ({ date: p.date, value: p.value / 1e6 })), // $M -> $T
    m2Yoy: thinTo(trimSince(m2Yoy, tenY), CHART_POINTS_MAX),
    rrp: thinTo(trimSince(raw.rrp, fiveY), CHART_POINTS_MAX),
    t10y2y: thinTo(trimSince(raw.t10y2y, fiveY), CHART_POINTS_MAX),
  };

  const out = {
    generated: new Date().toISOString(),
    latest: latestBlock,
    matrix,
    yieldCurveNow,
    yieldCurve1yAgo,
    series,
  };

  await writeFile(path.join(DATA_DIR, 'macro-fred.json'), JSON.stringify(out));
  console.log(`  MATRIX quadrant=${matrix.quadrant} (rate=${matrix.rateRegime}, bs=${matrix.bsTrend})`);
  console.log('Wrote assets/data/macro-fred.json');
}

main().catch((err) => { console.error(err); process.exit(1); });
