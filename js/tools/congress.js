// congress.js — House Clerk financial disclosure helpers. Pure functions (no
// fetch, no zlib) shared by the Node prefetch pipeline and unit tests.
//
// Source: https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.zip
// contains {YEAR}FD.xml, one <Member> block per filing. FilingType 'P' is a
// Periodic Transaction Report (the stock-trade disclosure); other types are
// annual/amended financial disclosures, not trades. The XML carries no
// per-transaction detail (ticker, amount) — that's only inside the linked PDF.

function tag(block, name) {
  const m = new RegExp(`<${name}>\\s*([^<]*)\\s*</${name}>`, 'i').exec(block);
  return m ? m[1].trim() : '';
}

// Parse the {YEAR}FD.xml text into one row per <Member> block.
export function parseDisclosureXml(xml) {
  const blocks = xml.match(/<Member>[\s\S]*?<\/Member>/g) || [];
  const rows = [];
  for (const b of blocks) {
    rows.push({
      last: tag(b, 'Last'),
      first: tag(b, 'First'),
      suffix: tag(b, 'Suffix'),
      filingType: tag(b, 'FilingType'),
      stateDst: tag(b, 'StateDst'),
      year: tag(b, 'Year'),
      filingDate: tag(b, 'FilingDate'),
      docId: tag(b, 'DocID'),
    });
  }
  return rows;
}

// Keep only Periodic Transaction Reports (stock trades).
export function filterPTR(rows) {
  return rows.filter((r) => r.filingType === 'P' && r.docId);
}

// FilingDate is "M/D/YYYY" — parse to a comparable ISO string for sorting.
export function filingDateToISO(filingDate) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(filingDate || '').trim());
  if (!m) return null;
  const [, mo, day, yr] = m;
  return `${yr}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function sortByDateDesc(rows) {
  return [...rows].sort((a, b) => {
    const da = filingDateToISO(a.filingDate) || '0000-00-00';
    const db = filingDateToISO(b.filingDate) || '0000-00-00';
    return db.localeCompare(da);
  });
}

export function ptrPdfUrl(year, docId) {
  return `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
}

export function memberName(row) {
  return [row.first, row.last, row.suffix].filter(Boolean).join(' ');
}
