// gex-page.js — GEX tool page controller.
// Loads the prefetched reduced chain (assets/data/gex/<SYM>.json, or
// assets/data/gex-eod/<SYM>.json for the EOD close snapshot), then runs the
// SAME selection + aggregation as the pipeline (gex.js) so the expiration
// dropdown and OI/Volume toggle are live.

import { fetchJSON, setLoading, setError, setStatus, fmtSignedMoney, fmtStrike, fmtNum, fmtTimestamp, qs } from './common.js';
import { PALETTE, applyTheme, verticalLinePlugin } from './chart-theme.js';
import { fetchChainViaProxy, parseChain, displaySymbol } from './cboe.js';
import {
  enumerateExpiries, expiriesForPreset, selectContracts, computeGex, floorFor, DEFAULTS,
} from './gex.js';

const FALLBACK_SYMBOLS = ['SPX', 'SPY', 'QQQ', 'IWM', 'RUT', 'NDX'];
let coveredSymbols = new Set(FALLBACK_SYMBOLS);
let coveredEodSymbols = new Set();

const state = {
  symbol: null,
  data: null,        // raw JSON
  contracts: [],      // expanded {expiry,type,strike,oi,gamma,volume}
  expInfos: [],       // [{date,dte,opex}]
  expiryMode: 'auto',  // 'auto' | 'all' | '7d' | '30d' | 'YYYY-MM-DD'
  snapshot: 'intraday', // 'intraday' | 'eod'
  weightBy: 'oi',       // 'oi' | 'volume'
  chart: null,
};

const els = {};

function expand(c) {
  return { expiry: c.e, type: c.t, strike: c.k, oi: c.oi, gamma: c.g, volume: c.v || 0 };
}

function shortDate(d) {
  const [y, m, day] = d.split('-');
  return `${m}/${day}`;
}

function monthLabel(dateStr) {
  const [y, m] = dateStr.split('-');
  return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Wait for the Chart.js UMD global (loaded via a separate defer script).
function whenChartReady(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.Chart) return resolve(window.Chart);
    const start = Date.now();
    const iv = setInterval(() => {
      if (window.Chart) { clearInterval(iv); resolve(window.Chart); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('Chart.js failed to load')); }
    }, 50);
  });
}

// ── Presets ─────────────────────────────────────────────────────────────────
// A short curated row of buttons (not all ~60 prefetched symbols), plus a
// <datalist> on the input listing every instantly-available symbol so typing
// shows which tickers are prefetched vs. will need a live lookup. Indices
// first (SPX, SPY, NDX, QQQ), then the megacaps + higher-beta names that see
// the heaviest options volume for swing trades.
const PRESET_ROW = [
  'SPX', 'SPY', 'NDX', 'QQQ',
  'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AVGO', 'NFLX', 'AMD',
  'JPM', 'XOM',
  'PLTR', 'COIN', 'MSTR', 'HOOD', 'SOFI', 'DKNG', 'GME',
];

async function buildPresets() {
  let symbols = FALLBACK_SYMBOLS;
  try {
    const manifest = await fetchJSON('/assets/data/manifest.json', { timeoutMs: 8000 });
    if (Array.isArray(manifest.gex) && manifest.gex.length) symbols = manifest.gex;
    if (Array.isArray(manifest.gexEod)) coveredEodSymbols = new Set(manifest.gexEod);
  } catch { /* fall back to the static list */ }
  coveredSymbols = new Set(symbols);

  els.presets.innerHTML = '';
  const row = PRESET_ROW.filter((s) => coveredSymbols.has(s));
  for (const sym of (row.length ? row : symbols.slice(0, 8))) {
    const b = document.createElement('button');
    b.className = 'tool-btn' + (sym === state.symbol ? ' on' : '');
    b.textContent = sym;
    b.dataset.symbol = sym;
    b.style.padding = '.4rem .7rem';
    b.addEventListener('click', () => { els.input.value = ''; load(sym); });
    els.presets.appendChild(b);
  }

  if (els.datalist) {
    els.datalist.innerHTML = symbols.map((s) => `<option value="${s}">`).join('');
  }
}

// Highlights whichever preset button matches the currently loaded symbol
// (none, if the symbol was typed in or reached via a live lookup).
function updatePresetActiveState() {
  for (const b of els.presets.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.symbol === state.symbol);
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Normalize a live (proxy-fetched) chain to the same shape as a prefetched
// gex/<SYM>.json file, so the rest of the page doesn't care which path loaded.
function adaptLiveChain(symbol, parsed) {
  return {
    symbol,
    spot: parsed.spot,
    asof: parsed.asof,
    today: todayISO(),
    floor: floorFor(symbol),
    strikePct: DEFAULTS.strikePct,
    autoExpiries: null, // resolved via expiriesForPreset('auto', ...) once expInfos exist
    contracts: parsed.contracts, // already {expiry,type,strike,oi,gamma,volume} — no expand() needed
    live: true,
  };
}

// ── Load a symbol ───────────────────────────────────────────────────────────
async function load(rawSymbol, { resetExpiry = true } = {}) {
  const symbol = String(rawSymbol || '').trim().toUpperCase().replace(/^_/, '');
  if (!symbol) return;
  state.symbol = symbol;
  if (resetExpiry) state.expiryMode = 'auto';
  location.hash = symbol;
  els.results.classList.add('tool-hidden');
  updatePresetActiveState();

  // EOD snapshots only exist for prefetched symbols — silently fall back to
  // intraday rather than erroring, and say so once loaded.
  let fellBackFromEod = false;
  if (state.snapshot === 'eod' && !coveredEodSymbols.has(symbol)) {
    state.snapshot = 'intraday';
    fellBackFromEod = true;
  }

  let data, isLive = false;

  if (state.snapshot === 'eod') {
    setLoading(els.status, `Loading ${symbol} EOD close snapshot…`);
    try {
      data = await fetchJSON(`/assets/data/gex-eod/${symbol}.json`, { timeoutMs: 15000 });
      data.contracts = data.contracts.map(expand);
    } catch (err) {
      setError(els.status, `Couldn't load ${symbol} EOD snapshot (${err.kind || 'error'}).`, () => load(symbol, { resetExpiry: false }));
      return;
    }
  } else if (coveredSymbols.has(symbol)) {
    setLoading(els.status, `Loading ${symbol} chain…`);
    try {
      data = await fetchJSON(`/assets/data/gex/${symbol}.json`, { timeoutMs: 15000 });
      data.contracts = data.contracts.map(expand);
    } catch (err) {
      setError(els.status, `Couldn't load ${symbol} (${err.kind || 'error'}).`, () => load(symbol));
      return;
    }
  } else {
    // Not in the prefetched set — best-effort live lookup, racing several
    // public CORS proxies at once (cdn.cboe.com itself sends no CORS
    // header). Usually resolves in a few seconds; can occasionally be slow
    // or unavailable if every proxy is down at once — that's expected, not
    // a bug.
    setLoading(els.status, `${symbol} isn't prefetched — trying a live lookup…`);
    try {
      const raw = await fetchChainViaProxy(symbol);
      const parsed = parseChain(raw);
      if (!parsed.spot || !parsed.contracts.length) throw new Error('empty chain — check the ticker');
      data = adaptLiveChain(displaySymbol(symbol), parsed);
      isLive = true;
    } catch (err) {
      setError(
        els.status,
        `Live lookup for ${symbol} failed (public proxies are best-effort and can be unavailable). ` +
        `Try again, or use a prefetched symbol.`,
        () => load(symbol)
      );
      return;
    }
  }

  state.data = data;
  state.contracts = data.contracts;
  state.expInfos = enumerateExpiries(state.contracts, data.today);

  setStatus(els.status, 'idle');
  els.results.classList.remove('tool-hidden');
  renderExpirySelect();
  updateSnapshotToggle();
  updateWeightToggle();
  await recompute();
  const src = isLive ? 'live via public proxy' : (state.snapshot === 'eod' ? 'CBOE EOD snapshot' : 'CBOE delayed');
  els.updated.textContent = `${src} · as of ${fmtTimestamp(data.asof)} · spot ${fmtStrike(data.spot)}` +
    (fellBackFromEod ? ' · EOD snapshot unavailable for this symbol, showing intraday' : '');
}

// ── Expiration dropdown ─────────────────────────────────────────────────────
const EXPIRY_PRESETS = [
  ['auto', 'Auto (optimal)'],
  ['all', 'All expirations'],
  ['7d', 'Next 7 days'],
  ['30d', 'Next 30 days'],
];

function renderExpirySelect() {
  const sel = els.expirySelect;
  sel.innerHTML = '';
  for (const [value, label] of EXPIRY_PRESETS) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }

  let group = null, curMonth = null;
  for (const e of state.expInfos) {
    const month = monthLabel(e.date);
    if (month !== curMonth) {
      curMonth = month;
      group = document.createElement('optgroup');
      group.label = month;
      sel.appendChild(group);
    }
    const o = document.createElement('option');
    o.value = e.date;
    o.textContent = `${shortDate(e.date)} · ${e.dte}d${e.opex ? ' · OPEX' : ''}`;
    group.appendChild(o);
  }

  sel.value = state.expiryMode;
}

// Resolve the current dropdown selection to a set of expiry dates. Prefers
// the pipeline's precomputed autoExpiries for 'auto' (matches the committed
// file exactly); falls back to computing fresh for live chains.
function resolveExpirySet() {
  if (state.expiryMode === 'auto' && Array.isArray(state.data.autoExpiries) && state.data.autoExpiries.length) {
    const valid = new Set(state.expInfos.map((e) => e.date));
    return new Set(state.data.autoExpiries.filter((d) => valid.has(d)));
  }
  return expiriesForPreset(state.expInfos, state.expiryMode);
}

// ── Toggle groups (snapshot, weighting) ─────────────────────────────────────
function renderToggleGroup(container, options, current, onSelect, disabledValue) {
  container.innerHTML = '';
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool-chip' + (value === current ? ' on' : '');
    b.textContent = label;
    if (value === disabledValue) {
      b.disabled = true;
      b.title = 'Not available for this symbol';
    }
    b.addEventListener('click', () => onSelect(value));
    container.appendChild(b);
  }
}

function updateSnapshotToggle() {
  const eodAvailable = coveredEodSymbols.has(state.symbol);
  renderToggleGroup(
    els.snapshotToggle,
    [['intraday', 'Intraday'], ['eod', 'EOD Close']],
    state.snapshot,
    (value) => {
      if (value === state.snapshot) return;
      state.snapshot = value;
      updateSnapshotToggle(); // reflect the click instantly, before the async reload finishes
      load(state.symbol, { resetExpiry: false });
    },
    eodAvailable ? null : 'eod'
  );
}

function updateWeightToggle() {
  renderToggleGroup(
    els.weightToggle,
    [['oi', 'Open Interest'], ['volume', 'Volume']],
    state.weightBy,
    (value) => {
      if (value === state.weightBy) return;
      state.weightBy = value;
      updateWeightToggle(); // reflect the click instantly, before recompute finishes
      recompute();
    }
  );
}

// ── Compute + render ────────────────────────────────────────────────────────
async function recompute() {
  const spot = state.data.spot;
  const minOI = state.data.floor ?? floorFor(state.symbol);
  const strikePct = state.data.strikePct ?? DEFAULTS.strikePct;
  const minVolume = DEFAULTS.minVolumeDefault;
  const expirySet = resolveExpirySet();
  const { selected, summary } = selectContracts(state.contracts, {
    expirySet, spot, strikePct, minOI, minVolume,
  });

  if (!selected.length) {
    els.summary.innerHTML = `<b>0</b> contracts selected — choose a different expiration.`;
    renderStats(null, spot);
    await drawChart({ byStrike: [], cumulative: [], flip: null }, spot);
    return;
  }

  const result = computeGex(selected, spot, state.weightBy);
  const range = summary.strikeMin != null ? `${fmtStrike(summary.strikeMin)}–${fmtStrike(summary.strikeMax)}` : '—';
  const weightLabel = state.weightBy === 'volume' ? 'volume' : 'open interest';
  els.summary.innerHTML =
    `Auto-selected <b>${summary.nSelected}</b> contracts · <b>${summary.nExpiries}</b> expiries · ` +
    `strikes <b>${range}</b> · OI ≥ <b>${minOI}</b> · vol ≥ <b>${minVolume}</b> · ` +
    `±${(strikePct * 100).toFixed(0)}% of spot · weighted by <b>${weightLabel}</b>`;
  renderStats(result, spot);
  await drawChart(result, spot);
}

function statCard(label, value, cls, sub) {
  return `<div class="tool-stat"><span class="tool-stat-label">${label}</span>` +
    `<span class="tool-stat-value${cls ? ' ' + cls : ''}">${value}</span>` +
    (sub ? `<span class="tool-stat-sub">${sub}</span>` : '') + `</div>`;
}

function renderStats(r, spot) {
  if (!r) {
    els.stats.innerHTML = statCard('Spot', fmtStrike(spot)) +
      statCard('Net GEX', '—') + statCard('Zero-Gamma Flip', '—') +
      statCard('Call Wall', '—') + statCard('Put Wall', '—');
    return;
  }
  const netCls = r.totalNet >= 0 ? 'bullish' : 'bearish';
  // When the cumulative profile never crosses zero, the whole window is one
  // gamma regime — report that rather than a bare dash.
  let flipVal, flipCls, flipSub;
  if (r.flip != null) {
    flipVal = fmtStrike(Math.round(r.flip));
    flipCls = 'neutral';
    flipSub = spot >= r.flip ? 'spot above — stabilizing' : 'spot below — amplifying';
  } else {
    flipVal = r.totalNet >= 0 ? 'Long γ' : 'Short γ';
    flipCls = netCls;
    flipSub = 'no crossing in window';
  }
  els.stats.innerHTML =
    statCard('Spot', fmtStrike(spot)) +
    statCard('Net GEX', fmtSignedMoney(r.totalNet), netCls, 'per 1% move') +
    statCard('Zero-Gamma Flip', flipVal, flipCls, flipSub) +
    statCard('Call Wall', r.callWall != null ? fmtStrike(r.callWall) : '—', 'bullish') +
    statCard('Put Wall', r.putWall != null ? fmtStrike(r.putWall) : '—', 'bearish');
}

async function drawChart(r, spot) {
  const Chart = await whenChartReady().catch(() => null);
  if (!Chart) { setError(els.status, 'Chart library failed to load.', () => load(state.symbol)); return; }
  applyTheme(Chart);

  // Strikes are rarely evenly spaced (tight near spot, wide far out), so a
  // true-numeric (linear) x-axis stretches the chart out with mostly-empty
  // space at the tails. A category axis gives every strike equal width
  // instead — spot/flip reference lines are interpolated onto it by
  // pixelForValue() in chart-theme.js since they're continuous values that
  // rarely land exactly on a listed strike.
  const strikes = r.byStrike.map((s) => s.strike);
  const bars = r.byStrike.map((s) => s.netGex / 1e9);
  const line = r.cumulative.map((c) => c.cum / 1e9);
  const barColors = r.byStrike.map((s) => (s.netGex >= 0 ? 'rgba(74,222,128,.75)' : 'rgba(248,113,113,.75)'));

  const vlines = [];
  if (Number.isFinite(spot)) vlines.push({ x: spot, label: `Spot ${fmtStrike(spot)}`, color: PALETTE.text });
  if (r.flip != null) vlines.push({ x: r.flip, label: `Flip ${fmtStrike(Math.round(r.flip))}`, color: PALETTE.neutral });

  const cfg = {
    data: {
      labels: strikes,
      datasets: [
        { type: 'bar', label: 'Net GEX ($B / 1%)', data: bars, backgroundColor: barColors, borderWidth: 0, yAxisID: 'y', order: 2 },
        { type: 'line', label: 'Cumulative', data: line, borderColor: PALETTE.text, borderWidth: 1.5, pointRadius: 0, tension: 0.15, yAxisID: 'y2', order: 1 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: {
          type: 'category',
          title: { display: true, text: 'Strike', color: PALETTE.muted },
          grid: { display: false },
          ticks: { color: PALETTE.muted, callback: (val, idx) => fmtStrike(strikes[idx]), autoSkip: true, maxRotation: 0 },
        },
        y: { position: 'left', title: { display: true, text: 'Net GEX ($B / 1%)', color: PALETTE.muted }, grid: { color: PALETTE.grid }, ticks: { color: PALETTE.muted } },
        y2: { position: 'right', title: { display: true, text: 'Cumulative ($B)', color: PALETTE.muted }, grid: { display: false }, ticks: { color: PALETTE.muted } },
      },
      plugins: {
        legend: { labels: { color: PALETTE.muted } },
        tooltip: {
          callbacks: {
            title: (items) => `Strike ${fmtStrike(strikes[items[0].dataIndex])}`,
            label: (item) => `${item.dataset.label}: ${fmtNum(item.parsed.y, 2)}B`,
          },
        },
        vlines: { lines: vlines },
      },
    },
    plugins: [verticalLinePlugin],
  };

  if (state.chart) {
    state.chart.data = cfg.data;
    state.chart.options = cfg.options;
    state.chart.update();
  } else {
    state.chart = new Chart(els.canvas.getContext('2d'), cfg);
  }
}

// ── Init ────────────────────────────────────────────────────────────────────
function init() {
  els.presets = qs('#preset-btns');
  els.input = qs('#symbol-input');
  els.datalist = qs('#gex-symbol-list');
  els.loadBtn = qs('#load-btn');
  els.status = qs('#status');
  els.results = qs('#results');
  els.summary = qs('#selection-summary');
  els.expirySelect = qs('#expiry-select');
  els.snapshotToggle = qs('#snapshot-toggle');
  els.weightToggle = qs('#weight-toggle');
  els.stats = qs('#stats');
  els.canvas = qs('#gex-chart');
  els.updated = qs('#updated');

  els.loadBtn.addEventListener('click', () => load(els.input.value || state.symbol));
  els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(els.input.value); });
  els.expirySelect.addEventListener('change', () => {
    state.expiryMode = els.expirySelect.value;
    recompute();
  });

  updateWeightToggle();

  buildPresets().finally(() => {
    const initial = (location.hash || '').replace('#', '').toUpperCase() || 'SPX';
    load(initial);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
