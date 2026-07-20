// insiders.js — SEC EDGAR Form 4 helpers. Pure functions (no DOM/fetch) shared
// by the Node prefetch pipeline (parses XML) and the browser (Tier-1 metadata).
//
// Why a pipeline: data.sec.gov (filing LISTS) sends CORS `*`, but the Form 4
// XML on www.sec.gov (the actual transactions) sends NO CORS header, so the
// browser can't read transaction detail. The pipeline parses it server-side.

export function lookupCik(ticker, map) {
  const t = String(ticker || '').trim().toUpperCase();
  return (map && map[t]) || null;
}

export function cikDigits(cik) {
  return String(cik || '').replace(/\D/g, '').replace(/^0+/, '') || '0';
}

export function accessionNoDashes(acc) {
  return String(acc || '').replace(/-/g, '');
}

// Human filing-index page (no CORS needed — it's a link target).
export function edgarIndexUrl(cik, acc) {
  return `https://www.sec.gov/Archives/edgar/data/${cikDigits(cik)}/${accessionNoDashes(acc)}/`;
}

// Raw Form 4 XML URL. primaryDocument is usually "xslF345X0N/form4.xml" (the
// XSL-rendered path); the raw XML is the same basename without the xsl folder.
export function rawXmlUrl(cik, acc, primaryDocument) {
  const base = String(primaryDocument || 'form4.xml').split('/').pop();
  return `https://www.sec.gov/Archives/edgar/data/${cikDigits(cik)}/${accessionNoDashes(acc)}/${base}`;
}

// Pull the recent Form 4 filings out of a submissions JSON (parallel arrays).
export function extractForm4Filings(submissionsJson, { limit = 25 } = {}) {
  const name = submissionsJson && submissionsJson.name;
  const cik = submissionsJson && submissionsJson.cik;
  const r = submissionsJson && submissionsJson.filings && submissionsJson.filings.recent;
  if (!r || !Array.isArray(r.form)) return { name, cik, filings: [] };
  const out = [];
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    if (r.form[i] !== '4' && r.form[i] !== '4/A') continue;
    out.push({
      form: r.form[i],
      date: r.filingDate[i],
      accession: r.accessionNumber[i],
      primaryDocument: r.primaryDocument[i],
      cik,
    });
  }
  return { name, cik, filings: out };
}

// ── Transaction code semantics ──────────────────────────────────────────────
const CODE_LABELS = {
  P: 'Buy', S: 'Sell', A: 'Grant', D: 'Disposition', F: 'Tax', M: 'Exercise',
  G: 'Gift', C: 'Conversion', X: 'Exercise', W: 'Will/Inherit', J: 'Other', I: 'Other',
};

export function codeLabel(code) {
  return CODE_LABELS[String(code || '').toUpperCase()] || (code || '—');
}

// Buy/sell side for coloring. Open-market P = buy, S = sell; otherwise use the
// acquired/disposed flag (A = acquired ≈ positive, D = disposed ≈ negative).
export function sideOf(code, ad) {
  const c = String(code || '').toUpperCase();
  if (c === 'P') return 'buy';
  if (c === 'S') return 'sell';
  if (ad === 'A') return 'buy';
  if (ad === 'D') return 'sell';
  return 'neutral';
}

// ── XML parsing (regex-based; SEC Form 4 XML is machine-generated + stable) ──
function tag(block, name) {
  const m = new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, 'i').exec(block);
  return m ? m[1].trim() : '';
}

// <foo><value>X</value></foo> — the SEC "value-wrapped" field.
function valueTag(block, name) {
  const inner = tag(block, name);
  if (!inner) return '';
  const v = /<value>\s*([\s\S]*?)\s*<\/value>/i.exec(inner);
  return v ? v[1].trim() : inner;
}

function blocks(xml, name) {
  const re = new RegExp(`<${name}>[\\s\\S]*?</${name}>`, 'gi');
  return xml.match(re) || [];
}

export function parseForm4Xml(xml) {
  const ownerBlock = (xml.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/i) || [''])[0];
  const owner = tag(ownerBlock, 'rptOwnerName') || '—';
  const roles = [];
  if (/<isDirector>\s*(1|true)\s*<\/isDirector>/i.test(ownerBlock)) roles.push('Director');
  if (/<isOfficer>\s*(1|true)\s*<\/isOfficer>/i.test(ownerBlock)) roles.push('Officer');
  if (/<isTenPercentOwner>\s*(1|true)\s*<\/isTenPercentOwner>/i.test(ownerBlock)) roles.push('10% Owner');
  const title = tag(ownerBlock, 'officerTitle');

  const txns = [];
  for (const b of blocks(xml, 'nonDerivativeTransaction')) {
    const code = valueTag(b, 'transactionCode') || tag(b, 'transactionCode');
    const shares = Number(valueTag(b, 'transactionShares')) || 0;
    const price = Number(valueTag(b, 'transactionPricePerShare')) || 0;
    const ad = valueTag(b, 'transactionAcquiredDisposedCode');
    const date = valueTag(b, 'transactionDate');
    const security = valueTag(b, 'securityTitle') || 'Common Stock';
    txns.push({
      date, code, side: sideOf(code, ad), shares, price,
      value: Math.round(shares * price), security,
    });
  }

  return { owner, roles, title, txns };
}
