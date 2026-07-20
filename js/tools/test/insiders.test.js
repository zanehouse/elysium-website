import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lookupCik, cikDigits, accessionNoDashes, edgarIndexUrl, rawXmlUrl,
  extractForm4Filings, codeLabel, sideOf, parseForm4Xml,
} from '../insiders.js';

test('lookupCik is case-insensitive', () => {
  const map = { AAPL: '0000320193' };
  assert.equal(lookupCik('aapl', map), '0000320193');
  assert.equal(lookupCik('ZZZZ', map), null);
});

test('cik + accession helpers', () => {
  assert.equal(cikDigits('0000320193'), '320193');
  assert.equal(accessionNoDashes('0001140361-26-025622'), '000114036126025622');
  assert.equal(edgarIndexUrl('0000320193', '0001140361-26-025622'),
    'https://www.sec.gov/Archives/edgar/data/320193/000114036126025622/');
  assert.equal(rawXmlUrl('0000320193', '0001140361-26-025622', 'xslF345X06/form4.xml'),
    'https://www.sec.gov/Archives/edgar/data/320193/000114036126025622/form4.xml');
});

test('extractForm4Filings pulls 4 and 4/A only', () => {
  const sub = {
    name: 'Apple Inc.', cik: '0000320193',
    filings: { recent: {
      form: ['4', '10-K', '4/A', '8-K', '4'],
      filingDate: ['2026-06-17', '2026-05-01', '2026-06-16', '2026-04-01', '2026-05-29'],
      accessionNumber: ['a1', 'a2', 'a3', 'a4', 'a5'],
      primaryDocument: ['d1', 'd2', 'd3', 'd4', 'd5'],
    } },
  };
  const { name, filings } = extractForm4Filings(sub, { limit: 10 });
  assert.equal(name, 'Apple Inc.');
  assert.deepEqual(filings.map((f) => f.accession), ['a1', 'a3', 'a5']);
});

test('codeLabel + sideOf', () => {
  assert.equal(codeLabel('P'), 'Buy');
  assert.equal(codeLabel('S'), 'Sell');
  assert.equal(sideOf('P'), 'buy');
  assert.equal(sideOf('S'), 'sell');
  assert.equal(sideOf('M', 'A'), 'buy');   // acquired
  assert.equal(sideOf('F', 'D'), 'sell');  // disposed
  assert.equal(sideOf('J', ''), 'neutral');
});

test('parseForm4Xml extracts owner, roles, non-derivative transactions', () => {
  const xml = `<?xml version="1.0"?>
    <ownershipDocument>
      <reportingOwner>
        <reportingOwnerId><rptOwnerName>Doe John</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship>
          <isDirector>0</isDirector><isOfficer>1</isOfficer>
          <officerTitle>CEO</officerTitle><isTenPercentOwner>0</isTenPercentOwner>
        </reportingOwnerRelationship>
      </reportingOwner>
      <nonDerivativeTable>
        <nonDerivativeTransaction>
          <securityTitle><value>Common Stock</value></securityTitle>
          <transactionDate><value>2026-06-15</value></transactionDate>
          <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
          <transactionAmounts>
            <transactionShares><value>1000</value></transactionShares>
            <transactionPricePerShare><value>210.5</value></transactionPricePerShare>
            <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
          </transactionAmounts>
        </nonDerivativeTransaction>
      </nonDerivativeTable>
    </ownershipDocument>`;
  const r = parseForm4Xml(xml);
  assert.equal(r.owner, 'Doe John');
  assert.deepEqual(r.roles, ['Officer']);
  assert.equal(r.title, 'CEO');
  assert.equal(r.txns.length, 1);
  assert.deepEqual(r.txns[0], { date: '2026-06-15', code: 'P', side: 'buy', shares: 1000, price: 210.5, value: 210500, security: 'Common Stock' });
});
