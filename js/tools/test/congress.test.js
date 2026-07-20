import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDisclosureXml, filterPTR, filingDateToISO, sortByDateDesc, ptrPdfUrl, memberName,
} from '../congress.js';

const SAMPLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<FinancialDisclosure>
  <Member>
    <Prefix />
    <Last>Alford</Last>
    <First>Mark</First>
    <Suffix />
    <FilingType>P</FilingType>
    <StateDst>MO04</StateDst>
    <Year>2026</Year>
    <FilingDate>3/31/2026</FilingDate>
    <DocID>20034201</DocID>
  </Member>
  <Member>
    <Prefix />
    <Last>Aaron</Last>
    <First>Richard</First>
    <Suffix />
    <FilingType>W</FilingType>
    <StateDst>MI04</StateDst>
    <Year>2026</Year>
    <FilingDate>4/15/2026</FilingDate>
    <DocID>8068</DocID>
  </Member>
  <Member>
    <Prefix>Hon.</Prefix>
    <Last>Crenshaw</Last>
    <First>Daniel</First>
    <Suffix />
    <FilingType>P</FilingType>
    <StateDst>TX02</StateDst>
    <Year>2026</Year>
    <FilingDate>7/16/2026</FilingDate>
    <DocID>20035024</DocID>
  </Member>
</FinancialDisclosure>`;

test('parseDisclosureXml extracts all member blocks', () => {
  const rows = parseDisclosureXml(SAMPLE_XML);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].last, 'Alford');
  assert.equal(rows[0].filingType, 'P');
  assert.equal(rows[0].docId, '20034201');
  assert.equal(rows[1].filingType, 'W');
});

test('filterPTR keeps only FilingType P with a docId', () => {
  const rows = parseDisclosureXml(SAMPLE_XML);
  const ptr = filterPTR(rows);
  assert.equal(ptr.length, 2);
  assert.ok(ptr.every((r) => r.filingType === 'P'));
});

test('filingDateToISO parses M/D/YYYY', () => {
  assert.equal(filingDateToISO('3/31/2026'), '2026-03-31');
  assert.equal(filingDateToISO('7/16/2026'), '2026-07-16');
  assert.equal(filingDateToISO('bogus'), null);
});

test('sortByDateDesc orders newest first', () => {
  const rows = parseDisclosureXml(SAMPLE_XML);
  const sorted = sortByDateDesc(filterPTR(rows));
  assert.equal(sorted[0].last, 'Crenshaw'); // 7/16 > 3/31
  assert.equal(sorted[1].last, 'Alford');
});

test('ptrPdfUrl + memberName', () => {
  assert.equal(ptrPdfUrl(2026, '20034201'), 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034201.pdf');
  assert.equal(memberName({ first: 'Daniel', last: 'Crenshaw', suffix: '' }), 'Daniel Crenshaw');
  assert.equal(memberName({ first: 'John', last: 'Smith', suffix: 'Jr.' }), 'John Smith Jr.');
});
