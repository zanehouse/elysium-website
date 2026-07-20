// insiders-page.js — Insider Trades page controller: two tabs, Company
// Insiders (SEC Form 4) and Congress · House (House Clerk PTR filings), each
// independently filterable client-side over already-loaded data.
//
// Covered company tickers load rich prefetched detail (assets/data/insiders/
// <SYM>.json). Any other ticker falls back to a LIVE EDGAR filing list
// (data.sec.gov sends CORS `*`); transaction detail for those opens on EDGAR,
// since the Form 4 XML on www.sec.gov is not browser-readable. Congress data
// is entirely prefetched (assets/data/congress.json) — the House publishes no
// machine-readable transaction detail, only filing metadata + PDF links.

import { fetchJSON, setLoading, setError, setStatus, fmtInt, fmtNum, fmtTimestamp, qs } from './common.js';
import { lookupCik, extractForm4Filings, edgarIndexUrl, codeLabel } from './insiders.js';

const FALLBACK_PRESETS = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'META'];

const els = {};
let tickerMap = null;
let coveredSet = new Set();

// Company tab state: the currently-loaded rows (flattened one-per-transaction)
// and the active filters, re-applied client-side without a refetch.
const company = { rows: [], mode: null, companyLine: '', filters: { side: 'all', minValue: 0, name: '' } };

// Congress tab state.
const congress = { rows: [], loaded: false, filters: { name: '', state: '' } };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function getTickerMap() {
  if (!tickerMap) tickerMap = await fetchJSON('/assets/data/ticker-cik.json', { timeoutMs: 15000 });
  return tickerMap;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function switchTab(name) {
  els.tabs.forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  els.panelCompany.classList.toggle('tool-hidden', name !== 'company');
  els.panelCongress.classList.toggle('tool-hidden', name !== 'congress');
  if (name === 'congress' && !congress.loaded) loadCongress();
}

// ── Company: presets ─────────────────────────────────────────────────────────
async function buildPresets() {
  let symbols = FALLBACK_PRESETS;
  try {
    const m = await fetchJSON('/assets/data/insiders-manifest.json', { timeoutMs: 8000 });
    if (Array.isArray(m.symbols) && m.symbols.length) symbols = m.symbols;
  } catch { /* keep fallback */ }
  coveredSet = new Set(symbols);
  els.presets.innerHTML = '';
  for (const sym of symbols) {
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.textContent = sym;
    b.style.padding = '.4rem .7rem';
    b.addEventListener('click', () => { els.input.value = ''; loadCompany(sym); });
    els.presets.appendChild(b);
  }
}

// ── Company: load ────────────────────────────────────────────────────────────
async function loadCompany(rawTicker) {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker) return;
  location.hash = ticker;
  setLoading(els.status, `Loading ${ticker} insider filings…`);
  els.results.classList.add('tool-hidden');
  company.rows = [];

  if (coveredSet.has(ticker)) {
    try {
      const data = await fetchJSON(`/assets/data/insiders/${ticker}.json`, { timeoutMs: 12000 });
      setStatus(els.status, 'idle');
      buildRichRows(data);
      return;
    } catch (err) {
      setError(els.status, `Couldn't load ${ticker} (${err.kind || 'error'}).`, () => loadCompany(ticker));
      return;
    }
  }

  // Live EDGAR filing list for an uncovered ticker.
  try {
    const map = await getTickerMap();
    const cik = lookupCik(ticker, map);
    if (!cik) {
      setError(els.status, `Unknown ticker “${ticker}”. Try a preset above.`);
      return;
    }
    const sub = await fetchJSON(`https://data.sec.gov/submissions/CIK${cik}.json`, { timeoutMs: 15000 });
    const { name, filings } = extractForm4Filings(sub, { limit: 25 });
    setStatus(els.status, 'idle');
    buildLiveRows(ticker, name, cik, filings);
  } catch (err) {
    setError(els.status, `EDGAR lookup failed for ${ticker} (${err.kind || 'error'}).`, () => loadCompany(ticker));
  }
}

// Flatten the rich prefetched payload to one row per transaction (filings
// with no parsed transactions still get one metadata-only row).
function buildRichRows(data) {
  company.mode = 'rich';
  company.companyLine = `<b>${esc(data.name || data.symbol)}</b> · CIK ${esc(data.cik)}`;
  company.updatedLine = `SEC EDGAR · parsed ${new Date(data.generated).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const rows = [];
  for (const f of (data.filings || [])) {
    const role = [...(f.roles || []), f.title].filter(Boolean).join(', ') || '—';
    if (!f.tx || !f.tx.length) {
      rows.push({ date: f.date, owner: f.owner, role, side: null, code: null, shares: null, price: null, value: null, url: f.url });
      continue;
    }
    for (const t of f.tx) {
      rows.push({ date: f.date, owner: f.owner, role, side: t.side, code: t.code, shares: t.shares, price: t.price, value: t.value, url: f.url });
    }
  }
  company.rows = rows;
  els.modeNote.textContent = '';
  els.company.innerHTML = company.companyLine;
  els.results.classList.remove('tool-hidden');
  renderCompanyTable();
}

function buildLiveRows(ticker, name, cik, filings) {
  company.mode = 'live';
  company.companyLine = `<b>${esc(name || ticker)}</b> · CIK ${esc(cik)}`;
  company.updatedLine = 'SEC EDGAR · live';
  company.rows = (filings || []).map((f) => ({
    date: f.date, owner: null, role: null, side: null, code: f.form, shares: null, price: null, value: null,
    url: edgarIndexUrl(cik, f.accession),
  }));
  els.company.innerHTML = company.companyLine;
  els.modeNote.textContent = 'Live from EDGAR — transaction detail opens on each filing (in-browser parsing is blocked for uncovered tickers). Side/value filters don’t apply here.';
  els.results.classList.remove('tool-hidden');
  renderCompanyTable();
}

// ── Company: filter + render ─────────────────────────────────────────────────
function filteredCompanyRows() {
  if (company.mode === 'live') return company.rows; // no tx-level fields to filter on
  const { side, minValue, name } = company.filters;
  const q = name.trim().toLowerCase();
  return company.rows.filter((r) => {
    if (side !== 'all' && r.side !== side) return false;
    if (minValue > 0 && !(r.value >= minValue)) return false;
    if (q && !(r.owner || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderCompanyTable() {
  const rows = filteredCompanyRows();
  els.filterCount.textContent = company.rows.length ? `${rows.length} of ${company.rows.length} rows` : '';

  if (company.mode === 'live') {
    els.thead.innerHTML = '<tr><th>Filed</th><th>Form</th><th>Filing</th></tr>';
    els.tbody.innerHTML = rows.map((r) =>
      `<tr><td>${esc(r.date)}</td><td>${esc(r.code)}</td>` +
      `<td><a href="${esc(r.url)}" target="_blank" rel="noopener">EDGAR →</a></td></tr>`
    ).join('') || '<tr><td colspan="3">No recent Form 4 filings.</td></tr>';
  } else {
    els.thead.innerHTML = '<tr><th>Filed</th><th>Insider</th><th>Role</th><th>Type</th>' +
      '<th>Shares</th><th>Price</th><th>Value</th><th>Filing</th></tr>';
    els.tbody.innerHTML = rows.map((r) => {
      if (r.side == null) {
        return `<tr><td>${esc(r.date)}</td><td>${esc(r.owner)}</td><td>${esc(r.role)}</td>` +
          `<td>—</td><td>—</td><td>—</td><td>—</td><td><a href="${esc(r.url)}" target="_blank" rel="noopener">EDGAR →</a></td></tr>`;
      }
      const cls = r.side === 'buy' ? 'buy' : (r.side === 'sell' ? 'sell' : '');
      const price = r.price ? '$' + fmtNum(r.price, 2) : '—';
      const value = r.value ? '$' + fmtInt(r.value) : '—';
      return `<tr><td>${esc(r.date)}</td><td>${esc(r.owner)}</td><td>${esc(r.role)}</td>` +
        `<td class="${cls}">${esc(codeLabel(r.code))}</td><td>${fmtInt(r.shares)}</td>` +
        `<td>${price}</td><td>${value}</td><td><a href="${esc(r.url)}" target="_blank" rel="noopener">EDGAR →</a></td></tr>`;
    }).join('') || '<tr><td colspan="8">No recent Form 4 filings.</td></tr>';
  }
  els.updated.textContent = company.updatedLine || '';
}

// ── Congress: load + filter + render ────────────────────────────────────────
async function loadCongress() {
  setLoading(els.congressStatus, 'Loading House financial disclosures…');
  els.congressResults.classList.add('tool-hidden');
  try {
    const data = await fetchJSON('/assets/data/congress.json', { timeoutMs: 15000 });
    congress.rows = data.filings || [];
    congress.loaded = true;
    congress.generated = data.generated;
    setStatus(els.congressStatus, 'idle');
    els.congressResults.classList.remove('tool-hidden');
    renderCongressTable();
    els.congressUpdated.textContent = `House Clerk · parsed ${fmtTimestamp(data.generated)}`;
  } catch (err) {
    setError(els.congressStatus, `Couldn't load congressional filings (${err.kind || 'error'}).`, loadCongress);
  }
}

function filteredCongressRows() {
  const { name, state } = congress.filters;
  const qName = name.trim().toLowerCase();
  const qState = state.trim().toLowerCase();
  return congress.rows.filter((r) => {
    if (qName && !(r.name || '').toLowerCase().includes(qName)) return false;
    if (qState && !(r.stateDst || '').toLowerCase().includes(qState)) return false;
    return true;
  });
}

function renderCongressTable() {
  const rows = filteredCongressRows();
  els.congressFilterCount.textContent = congress.rows.length ? `${rows.length} of ${congress.rows.length} filings` : '';
  const isFallback = (url) => url.includes('PublicDisclosure');
  els.congressTbody.innerHTML = rows.map((r) =>
    `<tr><td>${esc(r.filingDate)}</td><td>${esc(r.name)}</td><td>${esc(r.stateDst)}</td>` +
    `<td><a href="${esc(r.url)}" target="_blank" rel="noopener">${isFallback(r.url) ? 'Search EDGAR →' : 'Report →'}</a></td></tr>`
  ).join('') || '<tr><td colspan="4">No filings match.</td></tr>';
}

// ── Init ────────────────────────────────────────────────────────────────────
function init() {
  els.tabs = Array.from(document.querySelectorAll('.tool-tab'));
  els.panelCompany = qs('#panel-company');
  els.panelCongress = qs('#panel-congress');

  els.presets = qs('#preset-btns');
  els.input = qs('#ticker-input');
  els.loadBtn = qs('#load-btn');
  els.status = qs('#status');
  els.results = qs('#results');
  els.company = qs('#company');
  els.modeNote = qs('#mode-note');
  els.thead = qs('#thead');
  els.tbody = qs('#tbody');
  els.updated = qs('#updated');
  els.sideFilter = qs('#side-filter');
  els.valueFilter = qs('#value-filter');
  els.nameFilter = qs('#name-filter');
  els.filterCount = qs('#company-filter-count');

  els.congressStatus = qs('#congress-status');
  els.congressResults = qs('#congress-results');
  els.congressTbody = qs('#congress-tbody');
  els.congressUpdated = qs('#congress-updated');
  els.congressNameFilter = qs('#congress-name-filter');
  els.congressStateFilter = qs('#congress-state-filter');
  els.congressFilterCount = qs('#congress-filter-count');

  els.tabs.forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  els.loadBtn.addEventListener('click', () => loadCompany(els.input.value));
  els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadCompany(els.input.value); });
  els.sideFilter.addEventListener('change', () => { company.filters.side = els.sideFilter.value; renderCompanyTable(); });
  els.valueFilter.addEventListener('change', () => { company.filters.minValue = Number(els.valueFilter.value) || 0; renderCompanyTable(); });
  els.nameFilter.addEventListener('input', () => { company.filters.name = els.nameFilter.value; renderCompanyTable(); });

  els.congressNameFilter.addEventListener('input', () => { congress.filters.name = els.congressNameFilter.value; renderCongressTable(); });
  els.congressStateFilter.addEventListener('input', () => { congress.filters.state = els.congressStateFilter.value; renderCongressTable(); });

  buildPresets().finally(() => {
    const initial = (location.hash || '').replace('#', '').toUpperCase() || 'AAPL';
    loadCompany(initial);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
