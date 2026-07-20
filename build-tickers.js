'use strict';

// build-tickers.js — download SEC's ticker→CIK map and write a slim version to
// assets/data/ticker-cik.json. Committed to the repo so the Insiders tool never
// depends on www.sec.gov CORS at runtime (www.sec.gov sends no CORS header).
//
// Run manually to refresh:  node build-tickers.js
// SEC requires a descriptive User-Agent with contact info.

const fs = require('fs');
const path = require('path');

const UA = 'Elysium Capital tools (research@elysiumlab.markets)';
const SRC = 'https://www.sec.gov/files/company_tickers.json';
const OUT = path.resolve(__dirname, 'assets', 'data', 'ticker-cik.json');

async function main() {
  const fetchImpl = globalThis.fetch || (await import('node-fetch')).default;
  const res = await fetchImpl(SRC, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`SEC ${res.status}`);
  const raw = await res.json();

  // raw: { "0": { cik_str, ticker, title }, ... }
  const map = {};
  for (const key of Object.keys(raw)) {
    const row = raw[key];
    if (!row || !row.ticker) continue;
    map[String(row.ticker).toUpperCase()] = String(row.cik_str).padStart(10, '0');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(map));
  console.log(`Wrote ${Object.keys(map).length} tickers to ${path.relative(__dirname, OUT)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
