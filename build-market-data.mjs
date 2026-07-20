// build-market-data.mjs — prefetch pipeline for the free-tools section.
//
// cdn.cboe.com serves the option chains WITHOUT a CORS header, so the browser
// can never read them directly. This script (run by .github/workflows/
// market-data.yml on a schedule, or locally) fetches the chains in Node, runs
// the SAME selection/scoring logic the browser uses (js/tools/gex.js, macro.js),
// and writes small reduced JSON into assets/data/ for the static pages to load.
//
// Usage:  node build-market-data.mjs [--eod] [SYM ...]     (defaults to the full set)
//         --eod writes into assets/data/gex-eod/ (a frozen post-close
//         snapshot for the tool's Intraday/EOD close toggle) instead of
//         assets/data/gex/, and skips the macro/sentiment rebuild.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { fetchChain, fetchQuote, parseChain, displaySymbol } from './js/tools/cboe.js';
import {
  DEFAULTS, floorFor, enumerateExpiries, autoSelectExpiries,
} from './js/tools/gex.js';
import {
  scoreVixLevel, scoreTermStructure, scorePutCall, composite,
  bandLabel, componentRead,
} from './js/tools/macro.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'assets', 'data');
const GEX_DIR = path.join(DATA_DIR, 'gex');
const GEX_EOD_DIR = path.join(DATA_DIR, 'gex-eod');

// GEX symbol universe: liquid indices/ETFs + the most-traded optionable
// single names. Prefetched here load instantly on the page; anything else
// typed in falls back to a live CORS-proxied CBOE fetch (see gex-page.js).
const GEX_SYMBOLS = [
  // Indices + broad ETFs
  'SPX', 'SPY', 'QQQ', 'IWM', 'RUT', 'NDX', 'DIA', 'XSP',
  'TLT', 'GLD', 'SLV', 'XLE', 'XLF', 'XLK', 'SMH', 'ARKK',
  // Megacap tech
  'AAPL', 'NVDA', 'TSLA', 'AMZN', 'MSFT', 'META', 'GOOGL', 'GOOG', 'AMD', 'NFLX',
  'AVGO', 'CRM', 'ORCL', 'ADBE', 'INTC', 'MU', 'QCOM',
  // Financials
  'JPM', 'BAC', 'GS', 'V', 'MA',
  // Energy / industrials
  'XOM', 'CVX', 'BA', 'CAT', 'F', 'GM',
  // Consumer / other megacap
  'COST', 'WMT', 'HD', 'DIS', 'LLY', 'UNH', 'UBER', 'SHOP', 'PYPL', 'ROKU',
  // Higher-beta / retail-favorite names
  'PLTR', 'COIN', 'MSTR', 'HOOD', 'SOFI', 'RIVN', 'SNAP', 'DKNG', 'GME', 'AMC',
];

const COMMIT_STRIKE_PCT = 0.15; // commit a slightly wider window than the browser uses (0.12)

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// CBOE timestamp -> ISO date the chain is "as of".
function asofDate(asof) {
  if (!asof) return todayUTC();
  const d = new Date(asof.includes('T') ? asof : asof.replace(' ', 'T') + 'Z');
  return isNaN(d) ? todayUTC() : d.toISOString().slice(0, 10);
}

// Reduce a parsed chain to the committed GEX file shape. Keeps every expiry
// (including LEAPS) — the dropdown lets the browser filter down; auto-select
// still highlights the "contracts that matter" by default.
function reduceChain(symbol, parsed) {
  const { spot, asof, contracts } = parsed;
  if (!spot || !contracts.length) throw new Error(`empty chain for ${symbol}`);
  const today = asofDate(asof);
  const expInfos = enumerateExpiries(contracts, today);
  const autoSet = autoSelectExpiries(expInfos, {});
  const floor = floorFor(symbol);
  const lo = spot * (1 - COMMIT_STRIKE_PCT), hi = spot * (1 + COMMIT_STRIKE_PCT);
  const reduced = contracts
    .filter((c) => c.strike >= lo && c.strike <= hi && c.oi >= floor)
    .map((c) => ({
      e: c.expiry, t: c.type, k: c.strike, oi: c.oi,
      g: Number(c.gamma.toFixed(6)), v: c.volume || 0,
    }));
  return {
    symbol: displaySymbol(symbol), spot: Number(spot.toFixed(2)), asof, today,
    generated: new Date().toISOString(), floor, strikePct: DEFAULTS.strikePct,
    autoExpiries: [...autoSet].sort(), contracts: reduced,
  };
}

// Sum put vs call volume over front expiries (<=30d) for a put/call ratio.
function putCallRatio(contracts, today) {
  let put = 0, call = 0;
  for (const c of contracts) {
    // enumerateExpiries filters dte>=0; inline the 30d check via date compare.
    const d = (new Date(`${c.expiry}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000;
    if (d < 0 || d > 30) continue;
    if (c.type === 'P') put += c.volume; else call += c.volume;
  }
  return call > 0 ? put / call : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A couple of retries with backoff — CBOE rate-limits (HTTP 429) after a
// burst of requests, and the VIX level feeds the sentiment composite, so
// it's worth a couple of retries rather than silently going blank.
async function fetchQuoteWithRetry(sym, { retries = 2, delayMs = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchQuote(sym);
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

// A 60+ symbol run trips CBOE's rate limit near the tail even with a
// between-request delay — retry a 429 specifically, with a real cooldown,
// rather than letting the last handful of symbols silently drop out of the
// prefetched set (and out of anything, like preset buttons, that assumes
// they're covered).
async function fetchChainWithRetry(sym, { retries = 2, delayMs = 3000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchChain(sym);
    } catch (err) {
      if (attempt >= retries || !/HTTP 429/.test(err.message)) throw err;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

// Fetches VIX + VIX3M up front, before the GEX symbol loop below has a
// chance to trip CBOE's rate limiting on a long run.
async function fetchVixLevels() {
  const [vix, vix3m] = await Promise.all([
    fetchQuoteWithRetry('_VIX').catch(() => NaN),
    fetchQuoteWithRetry('_VIX3M').catch(() => NaN),
  ]);
  return { vix, vix3m };
}

async function buildMacro({ vix, vix3m }, spyContracts, spyToday) {
  const pcr = spyContracts ? putCallRatio(spyContracts, spyToday) : null;

  const sVix = scoreVixLevel(vix);
  const sTerm = scoreTermStructure(vix, vix3m);
  const sPc = scorePutCall(pcr);
  const comp = composite([sVix, sTerm, sPc]);

  const components = [
    { key: 'vix', label: 'VIX Level', reading: Number.isFinite(vix) ? vix.toFixed(2) : '—', raw: vix, score: sVix, read: componentRead(sVix) },
    { key: 'term', label: 'VIX Term Structure', reading: (Number.isFinite(vix) && Number.isFinite(vix3m)) ? `VIX/VIX3M ${(vix / vix3m).toFixed(3)}` : '—', raw: (Number.isFinite(vix) && Number.isFinite(vix3m)) ? vix / vix3m : NaN, score: sTerm, read: componentRead(sTerm) },
    { key: 'pc', label: 'SPY Put/Call (vol)', reading: Number.isFinite(pcr) ? pcr.toFixed(2) : '—', raw: pcr, score: sPc, read: componentRead(sPc) },
  ];

  const out = { generated: new Date().toISOString(), composite: comp, label: bandLabel(comp), components };
  await writeFile(path.join(DATA_DIR, 'macro.json'), JSON.stringify(out, null, 2));
  return out;
}

// Read the existing manifest (if any) so intraday/EOD runs can update their
// own slice without clobbering the other's fields.
async function readManifest() {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const isEod = argv.includes('--eod');
  const symbols = argv.filter((a) => a !== '--eod');
  const useSymbols = symbols.length ? symbols : GEX_SYMBOLS;
  const outDir = isEod ? GEX_EOD_DIR : GEX_DIR;

  await mkdir(outDir, { recursive: true });

  // Fetch VIX/VIX3M before the (long, rate-limit-prone) GEX loop below —
  // otherwise sentiment silently loses its two VIX-based components
  // whenever CBOE starts 429-ing partway through the symbol batch.
  let vixLevels = { vix: NaN, vix3m: NaN };
  if (!isEod) {
    vixLevels = await fetchVixLevels();
  }

  const ok = [];
  let spyContracts = null, spyToday = todayUTC();

  for (const sym of useSymbols) {
    try {
      const raw = await fetchChainWithRetry(sym);
      const parsed = parseChain(raw);
      if (displaySymbol(sym) === 'SPY') { spyContracts = parsed.contracts; spyToday = asofDate(parsed.asof); }
      const out = reduceChain(sym, parsed);
      await writeFile(path.join(outDir, `${out.symbol}.json`), JSON.stringify(out));
      ok.push({ symbol: out.symbol, spot: out.spot, contracts: out.contracts.length });
      console.log(`  ${out.symbol.padEnd(6)} spot=${out.spot}  contracts=${out.contracts.length}`);
    } catch (err) {
      console.error(`  ${displaySymbol(sym).padEnd(6)} FAILED: ${err.message}`);
    }
    // A small gap between requests keeps a 60+ symbol run under CBOE's rate
    // limit — without it, the tail end of the batch starts 429-ing.
    await sleep(200);
  }

  // The EOD run only snapshots GEX chains — sentiment/macro stays on the
  // intraday cadence, so it's skipped here rather than double-computed.
  let macro = null;
  if (!isEod) {
    try {
      macro = await buildMacro(vixLevels, spyContracts, spyToday);
      console.log(`  MACRO  composite=${macro.composite} (${macro.label})`);
    } catch (err) {
      console.error(`  MACRO  FAILED: ${err.message}`);
    }
  }

  const prev = await readManifest();
  const manifest = {
    ...prev,
    generated: new Date().toISOString(),
    ...(isEod
      ? { gexEod: ok.map((s) => s.symbol), eodGenerated: new Date().toISOString() }
      : { gex: ok.map((s) => s.symbol), symbols: ok, macro: macro ? { composite: macro.composite, label: macro.label } : null }),
  };
  await writeFile(path.join(DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${ok.length}/${useSymbols.length} ${isEod ? 'EOD ' : ''}GEX files${isEod ? '' : ' + macro'} + manifest.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
