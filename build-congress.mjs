// build-congress.mjs — prefetch House financial-disclosure filings and commit
// a filterable feed to assets/data/congress.json.
//
// Source: the official House Clerk index (no API key, no CORS issue since a
// Node job fetches it, not the browser). It's a ZIP containing one XML per
// year; this script unzips it with only Node's built-in zlib (no dependency),
// keeps Periodic Transaction Reports (stock trades), and links each to its
// PDF report — the House publishes no machine-readable transaction detail,
// so the PDF is the source of truth for what was actually bought or sold.
//
// Usage:  node build-congress.mjs [YEAR]

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import path from 'node:path';

import { parseDisclosureXml, filterPTR, sortByDateDesc, ptrPdfUrl, memberName } from './js/tools/congress.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'assets', 'data');

const UA = 'Elysium Capital tools (research@elysiumlab.markets)';
const MAX_FILINGS = 250;
const HEAD_CONCURRENCY = 6;
const HEAD_DELAY_MS = 60;

async function fetchZip(year) {
  const url = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Minimal ZIP reader: locate the End-Of-Central-Directory record, walk the
// central directory to find `${year}FD.xml`, then inflate its local entry.
// Handles the single-disk, non-Zip64 case, which is all the Clerk's ZIPs use.
function extractXml(buf, entryName) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid zip (no EOCD)');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);

  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central-directory signature at entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === entryName) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const compressed = buf.slice(dataStart, dataStart + compSize);
      const raw = method === 8 ? zlib.inflateRawSync(compressed) : compressed; // 0 = stored
      return raw.toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`entry ${entryName} not found in zip`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HEAD-check PDF URLs with limited concurrency; the House publishes a PDF for
// almost every electronic PTR, but a small number remain paper-only and 404 —
// those fall back to the Clerk's public search page.
async function checkPdfUrls(rows) {
  const searchFallback = 'https://disclosures-clerk.house.gov/PublicDisclosure/FinancialDisclosure';
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      const row = rows[idx];
      try {
        const res = await fetch(row.url, { method: 'HEAD', headers: { 'User-Agent': UA } });
        if (!res.ok) row.url = searchFallback;
      } catch {
        row.url = searchFallback;
      }
      await sleep(HEAD_DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: HEAD_CONCURRENCY }, worker));
}

async function main() {
  const year = process.argv[2] || new Date().getUTCFullYear();
  await mkdir(DATA_DIR, { recursive: true });

  const zipBuf = await fetchZip(year);
  const xml = extractXml(zipBuf, `${year}FD.xml`);
  const all = parseDisclosureXml(xml);
  const ptr = sortByDateDesc(filterPTR(all)).slice(0, MAX_FILINGS);

  const rows = ptr.map((r) => ({
    name: memberName(r),
    stateDst: r.stateDst,
    filingDate: r.filingDate,
    docId: r.docId,
    url: ptrPdfUrl(year, r.docId),
  }));

  console.log(`  Found ${ptr.length} PTR filings for ${year}; checking PDF links…`);
  await checkPdfUrls(rows);

  const out = { year: Number(year), generated: new Date().toISOString(), source: 'House Clerk (disclosures-clerk.house.gov)', filings: rows };
  await writeFile(path.join(DATA_DIR, 'congress.json'), JSON.stringify(out));
  console.log(`  Wrote ${rows.length} congress filings to assets/data/congress.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
