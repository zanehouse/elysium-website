// build-insiders.mjs — prefetch + parse recent SEC Form 4 insider filings for
// the covered symbols and commit rich JSON to assets/data/insiders/<SYM>.json.
//
// The Form 4 XML on www.sec.gov has no CORS header, so the browser can't parse
// transaction detail; this Node job does it (SEC allows automated access with a
// descriptive User-Agent and ≤10 req/s). Insider filings are daily — run this a
// few times a day, not every 15 min (see .github/workflows/insiders-data.yml).
//
// Usage:  node build-insiders.mjs [SYM ...]

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { lookupCik, extractForm4Filings, rawXmlUrl, parseForm4Xml } from './js/tools/insiders.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'assets', 'data');
const OUT_DIR = path.join(DATA_DIR, 'insiders');

const UA = 'Elysium Capital tools (research@elysiumlab.markets)';
const FILINGS_PER_SYMBOL = 15;
const REQ_DELAY_MS = 130; // stay well under SEC's 10 req/s

const DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA', 'AMZN', 'MSFT', 'META', 'GOOGL', 'AMD', 'NFLX'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.text();
}

async function loadTickerMap() {
  return JSON.parse(await readFile(path.join(DATA_DIR, 'ticker-cik.json'), 'utf8'));
}

async function symbolList() {
  const argv = process.argv.slice(2);
  if (argv.length) return argv.map((s) => s.toUpperCase());
  try {
    const manifest = JSON.parse(await readFile(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
    // Only equities have Form 4s (indices like SPX/RUT/NDX don't); filter those.
    const skip = new Set(['SPX', 'RUT', 'NDX', 'DIA', 'IWM', 'VIX', 'SPY', 'QQQ']);
    const eq = (manifest.gex || []).filter((s) => !skip.has(s));
    if (eq.length) return eq;
  } catch { /* fall through */ }
  return DEFAULT_SYMBOLS;
}

async function buildSymbol(symbol, map) {
  const cik = lookupCik(symbol, map);
  if (!cik) throw new Error(`no CIK for ${symbol}`);
  const sub = await getJSON(`https://data.sec.gov/submissions/CIK${cik}.json`);
  await sleep(REQ_DELAY_MS);
  const { name, filings } = extractForm4Filings(sub, { limit: FILINGS_PER_SYMBOL });

  const out = [];
  for (const f of filings) {
    try {
      const xml = await getText(rawXmlUrl(cik, f.accession, f.primaryDocument));
      const parsed = parseForm4Xml(xml);
      const accNoDash = f.accession.replace(/-/g, '');
      const cikDigits = String(cik).replace(/^0+/, '');
      out.push({
        date: f.date,
        owner: parsed.owner,
        roles: parsed.roles,
        title: parsed.title,
        url: `https://www.sec.gov/Archives/edgar/data/${cikDigits}/${accNoDash}/${f.primaryDocument}`,
        tx: parsed.txns,
      });
    } catch (err) {
      // Skip an unreadable filing but keep going.
      console.error(`    ${symbol} ${f.accession}: ${err.message}`);
    }
    await sleep(REQ_DELAY_MS);
  }

  const doc = { symbol, cik, name, generated: new Date().toISOString(), filings: out };
  await writeFile(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(doc));
  return { symbol, filings: out.length };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const map = await loadTickerMap();
  const symbols = await symbolList();
  const ok = [];
  for (const sym of symbols) {
    try {
      const r = await buildSymbol(sym, map);
      ok.push(r.symbol);
      console.log(`  ${sym.padEnd(6)} ${r.filings} Form 4 filings`);
    } catch (err) {
      console.error(`  ${sym.padEnd(6)} FAILED: ${err.message}`);
    }
  }
  await writeFile(path.join(DATA_DIR, 'insiders-manifest.json'),
    JSON.stringify({ generated: new Date().toISOString(), symbols: ok }, null, 2));
  console.log(`Wrote ${ok.length}/${symbols.length} insider files.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
