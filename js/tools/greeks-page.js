// greeks-page.js — Options Greeks Lab page controller.
// The only tool on the site with no data dependency: everything is computed in
// the browser from the user's own inputs via js/tools/bs.js.
//
// Two conventions this page is strict about, because they are where option
// calculators mislead:
//   1. Percentages stay percentages in the UI. Volatility, rate and dividend
//      are typed as 25 / 4 / 0.5, converted to decimals at the boundary, and
//      never shown as 0.25 in a form field.
//   2. Greeks are DISPLAY-SCALED here, not in bs.js — vega per volatility
//      point, theta per calendar day, rho per 1% — and every card names the
//      unit it is showing.
//
// The whole input state lives in the URL hash. Unlike the data tools, every
// value here is user-supplied, so a shareable scenario link is the point of the
// thing rather than a nicety.

import { fetchData, setStatus, qs, fmtNum } from './common.js';
import { PALETTE, applyTheme, verticalLinePlugin } from './chart-theme.js';
import {
  bsPrice, bsGreeks, impliedVol, priceBounds, intrinsic, yearsFromDays,
  VEGA_PER_VOL_POINT, THETA_PER_DAY, RHO_PER_PCT,
} from './bs.js';

const DTE_PRESETS = [1, 7, 30, 60, 90, 365];
const GREEK_CURVES = [
  ['price', 'Price'], ['delta', 'Delta'], ['gamma', 'Gamma'],
  ['vega', 'Vega'], ['theta', 'Theta'], ['rho', 'Rho'],
];
const FALLBACK_RATE_PCT = 4.00;
const CURVE_POINTS = 121;
const CURVE_SPAN = 0.30;   // plot the underlying over spot ±30%

const state = {
  type: 'C',
  S: 100, K: 100, days: 30,
  ivPct: 25, ratePct: FALLBACK_RATE_PCT, divPct: 0,
  curve: 'delta',
  rateSource: null,
  payoffChart: null,
  greekChart: null,
};

const els = {};
let hashTimer = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const isCall = () => state.type === 'C';

// Model inputs, in the units bs.js expects.
function modelArgs() {
  return {
    S: state.S,
    K: state.K,
    T: yearsFromDays(state.days),
    r: state.ratePct / 100,
    sigma: state.ivPct / 100,
    q: state.divPct / 100,
  };
}

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

// ── URL state ───────────────────────────────────────────────────────────────
function readHash() {
  const p = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  if (!Array.from(p.keys()).length) return false;
  const num = (key, fallback) => {
    const v = Number(p.get(key));
    return Number.isFinite(v) ? v : fallback;
  };
  const t = String(p.get('type') || '').toUpperCase();
  if (t === 'C' || t === 'P') state.type = t;
  state.S = num('S', state.S);
  state.K = num('K', state.K);
  state.days = num('d', state.days);
  state.ivPct = num('iv', state.ivPct);
  state.ratePct = num('r', state.ratePct);
  state.divPct = num('q', state.divPct);
  const c = p.get('curve');
  if (c && GREEK_CURVES.some(([k]) => k === c)) state.curve = c;
  return p.has('r');   // an explicit rate in the URL wins over the FRED default
}

function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams({
      type: state.type,
      S: String(state.S), K: String(state.K), d: String(state.days),
      iv: String(state.ivPct), r: String(state.ratePct), q: String(state.divPct),
      curve: state.curve,
    });
    history.replaceState(null, '', `#${p.toString()}`);
  }, 250);
}

// ── Rate default ────────────────────────────────────────────────────────────
// Reuse the FRED yield curve the macro tool already prefetches rather than
// hardcoding a rate that silently goes stale.
async function loadDefaultRate() {
  try {
    const data = await fetchData('/assets/data/macro-fred.json', { timeoutMs: 8000 });
    const p = (data.yieldCurveNow || []).find((x) => x.label === '3M');
    if (p && Number.isFinite(p.value)) {
      state.ratePct = p.value;
      state.rateSource = '3-month Treasury via FRED, editable';
      return;
    }
  } catch { /* fall through */ }
  state.rateSource = 'default 4.00%, editable';
}

// ── Inputs ──────────────────────────────────────────────────────────────────
function syncInputs() {
  els.spot.value = state.S;
  els.strike.value = state.K;
  els.dte.value = state.days;
  els.iv.value = state.ivPct;
  els.rate.value = state.ratePct;
  els.div.value = state.divPct;
  if (state.rateSource) els.rateHint.textContent = state.rateSource;
}

function readInputs() {
  const num = (el, fallback) => {
    const v = Number(el.value);
    return Number.isFinite(v) ? v : fallback;
  };
  state.S = num(els.spot, state.S);
  state.K = num(els.strike, state.K);
  state.days = Math.max(0, num(els.dte, state.days));
  state.ivPct = Math.max(0, num(els.iv, state.ivPct));
  state.ratePct = num(els.rate, state.ratePct);
  state.divPct = num(els.div, state.divPct);
}

function renderTypeToggle() {
  els.typeToggle.innerHTML = '';
  for (const [value, label] of [['C', 'Call'], ['P', 'Put']]) {
    const b = document.createElement('button');
    b.className = 'tool-chip' + (state.type === value ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      if (state.type === value) return;
      state.type = value;
      renderTypeToggle();
      recompute();
    });
    els.typeToggle.appendChild(b);
  }
}

function renderDteChips() {
  els.dteChips.innerHTML = '';
  for (const d of DTE_PRESETS) {
    const b = document.createElement('button');
    b.className = 'tool-chip' + (state.days === d ? ' on' : '');
    b.textContent = d === 365 ? '1y' : `${d}d`;
    b.addEventListener('click', () => {
      state.days = d;
      els.dte.value = d;
      renderDteChips();
      recompute();
    });
    els.dteChips.appendChild(b);
  }
}

function renderCurveToggle() {
  els.greekToggle.innerHTML = '';
  for (const [value, label] of GREEK_CURVES) {
    const b = document.createElement('button');
    b.className = 'tool-chip' + (state.curve === value ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      if (state.curve === value) return;
      state.curve = value;
      renderCurveToggle();
      recompute();
    });
    els.greekToggle.appendChild(b);
  }
}

// ── Stat cards ──────────────────────────────────────────────────────────────
function statCard(label, value, sub, cls = '') {
  return '<div class="tool-stat">' +
    `<span class="tool-stat-label">${esc(label)}</span>` +
    `<span class="tool-stat-value${cls ? ` ${cls}` : ''}">${value}</span>` +
    `<span class="tool-stat-sub">${esc(sub)}</span>` +
    '</div>';
}

function renderStats(g) {
  const { S, K, T } = modelArgs();
  const cards = [];

  if (!g) {
    els.stats.innerHTML = statCard('Price', '—', 'check the inputs — spot and strike must be positive');
    return;
  }

  // Exactly six cards, which is what fills one row of .tool-stats at this
  // width. A seventh wraps alone and the empty cells in that row render as a
  // solid block, since the grid paints its gaps with the border colour — so
  // breakeven rides in the price card's sub line rather than as its own card.
  const iv = intrinsic(state.type, S, K);
  const be = isCall() ? K + g.price : K - g.price;   // ignores financing on the premium
  cards.push(statCard('Price', fmtNum(g.price, 4),
    `intrinsic ${fmtNum(iv, 2)}, time value ${fmtNum(g.price - iv, 4)}, B/E ${fmtNum(be, 2)}`));

  cards.push(statCard('Delta', fmtNum(g.delta, 4), 'per $1 of underlying',
    g.delta > 0 ? 'bullish' : g.delta < 0 ? 'bearish' : ''));
  cards.push(statCard('Gamma', fmtNum(g.gamma, 5), 'delta change per $1'));
  cards.push(statCard('Vega', fmtNum(g.vega * VEGA_PER_VOL_POINT, 4), 'per 1 volatility point'));
  cards.push(statCard('Theta', fmtNum(g.theta * THETA_PER_DAY, 4), 'per calendar day',
    g.theta * THETA_PER_DAY < 0 ? 'bearish' : ''));
  cards.push(statCard('Rho', fmtNum(g.rho * RHO_PER_PCT, 4), 'per 1% (100bp) rate move'));

  els.stats.innerHTML = cards.join('');
}

// ── Implied-volatility solver ───────────────────────────────────────────────
function solveIv() {
  const { S, K, T, r, q } = modelArgs();
  const target = Number(els.market.value);
  if (!Number.isFinite(target)) {
    els.solveResult.textContent = 'Enter a market price to solve.';
    return;
  }
  const solved = impliedVol(state.type, target, S, K, T, r, q);
  if (solved === null) {
    const b = priceBounds(state.type, S, K, T, r, q);
    els.solveResult.textContent = b && T > 0
      ? `No solution — a ${isCall() ? 'call' : 'put'} here must price between ` +
        `${fmtNum(b.lo, 2)} and ${fmtNum(b.hi, 2)}, and must carry some time value.`
      : 'No solution — with zero days to expiry there is no volatility to imply.';
    return;
  }
  state.ivPct = solved * 100;
  els.iv.value = Number(state.ivPct.toFixed(4));
  els.solveResult.textContent = `Implied volatility ${(solved * 100).toFixed(2)}% — written into the field above.`;
  recompute();
}

// ── Charts ──────────────────────────────────────────────────────────────────
// Spot, strike and breakeven reference lines, staggered onto separate label
// rows and de-duplicated. At the money these all sit on the same pixel, so
// without this their labels overprint into an unreadable smear.
function referenceLines(K, breakeven, premium) {
  const lines = [{ x: state.S, label: `Spot ${fmtNum(state.S, 2)}`, color: PALETTE.text }];
  const near = (a, b) => Math.abs(a - b) < Math.max(1e-9, state.S * 1e-4);

  if (!near(K, state.S)) {
    lines.push({ x: K, label: `Strike ${fmtNum(K, 2)}`, color: PALETTE.muted });
  }
  if (Number.isFinite(breakeven) && premium > 0 && !near(breakeven, state.S) && !near(breakeven, K)) {
    lines.push({ x: breakeven, label: `B/E ${fmtNum(breakeven, 2)}`, color: PALETTE.bullish, dash: [2, 3] });
  }
  return lines.map((ln, i) => ({ ...ln, labelRow: i }));
}

function spotGrid() {
  const lo = state.S * (1 - CURVE_SPAN), hi = state.S * (1 + CURVE_SPAN);
  const step = (hi - lo) / (CURVE_POINTS - 1);
  return Array.from({ length: CURVE_POINTS }, (_, i) => lo + i * step);
}

async function drawCharts(g) {
  const Chart = await whenChartReady().catch(() => null);
  if (!Chart) return;
  applyTheme(Chart);
  drawPayoff(Chart, g);
  drawGreekCurve(Chart);
}

function drawPayoff(Chart, g) {
  const { K, T, r, sigma, q } = modelArgs();
  const grid = spotGrid();
  const premium = g ? g.price : 0;

  // Three views of the same position: what it is worth now, halfway to expiry,
  // and at expiry — all net of the premium paid, so zero is breakeven.
  const now = grid.map((s) => ({ x: s, y: (bsPrice(state.type, s, K, T, r, sigma, q) ?? 0) - premium }));
  const half = grid.map((s) => ({ x: s, y: (bsPrice(state.type, s, K, T / 2, r, sigma, q) ?? 0) - premium }));
  const expiry = grid.map((s) => ({ x: s, y: intrinsic(state.type, s, K) - premium }));

  const breakeven = isCall() ? K + premium : K - premium;

  if (state.payoffChart) state.payoffChart.destroy();
  state.payoffChart = new Chart(els.payoffCanvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'Now', data: now, borderColor: PALETTE.text, borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
        { label: 'Halfway', data: half, borderColor: 'rgba(212,212,212,0.55)', borderWidth: 1.2, borderDash: [6, 3], pointRadius: 0, tension: 0.2 },
        { label: 'At expiry', data: expiry, borderColor: PALETTE.neutral, borderWidth: 1.5, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, color: PALETTE.muted, text: 'Underlying' },
          ticks: { color: PALETTE.muted, callback: (v) => fmtNum(Number(v), 0) },
          grid: { color: PALETTE.grid },
        },
        y: {
          title: { display: true, color: PALETTE.muted, text: 'Profit / loss' },
          ticks: { color: PALETTE.muted, callback: (v) => fmtNum(Number(v), 0) },
          grid: { color: (ctx) => (ctx.tick.value === 0 ? PALETTE.border : PALETTE.grid) },
        },
      },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: PALETTE.text, usePointStyle: true } },
        tooltip: {
          callbacks: {
            title: (items) => `Underlying ${fmtNum(Number(items[0].parsed.x), 2)}`,
            label: (i) => `${i.dataset.label}: ${fmtNum(Number(i.parsed.y), 2)}`,
          },
        },
        vlines: { lines: referenceLines(K, breakeven, premium) },
      },
    },
    plugins: [verticalLinePlugin],
  });
}

// Display-scaled so the curve matches the stat card beside it.
function greekAt(spot, key) {
  const { K, T, r, sigma, q } = modelArgs();
  const g = bsGreeks(state.type, spot, K, T, r, sigma, q);
  if (!g) return null;
  if (key === 'vega') return g.vega * VEGA_PER_VOL_POINT;
  if (key === 'theta') return g.theta * THETA_PER_DAY;
  if (key === 'rho') return g.rho * RHO_PER_PCT;
  return g[key];
}

function drawGreekCurve(Chart) {
  const label = (GREEK_CURVES.find(([k]) => k === state.curve) || [])[1] || 'Delta';
  els.greekTitle.textContent = `${label} vs. Spot`;

  const data = spotGrid().map((s) => ({ x: s, y: greekAt(s, state.curve) }))
    .filter((p) => Number.isFinite(p.y));

  if (state.greekChart) state.greekChart.destroy();
  state.greekChart = new Chart(els.greekCanvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [{
        label,
        data,
        borderColor: PALETTE.text,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
      }],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, color: PALETTE.muted, text: 'Underlying' },
          ticks: { color: PALETTE.muted, callback: (v) => fmtNum(Number(v), 0) },
          grid: { color: PALETTE.grid },
        },
        y: {
          title: { display: true, color: PALETTE.muted, text: label },
          ticks: { color: PALETTE.muted, callback: (v) => fmtNum(Number(v), 3) },
          grid: { color: (ctx) => (ctx.tick.value === 0 ? PALETTE.border : PALETTE.grid) },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `Underlying ${fmtNum(Number(items[0].parsed.x), 2)}`,
            label: (i) => `${label}: ${fmtNum(Number(i.parsed.y), 5)}`,
          },
        },
        vlines: { lines: referenceLines(state.K, null, 0) },
      },
    },
    plugins: [verticalLinePlugin],
  });
}

// ── Recompute ───────────────────────────────────────────────────────────────
function recompute() {
  const { S, K, T, r, sigma, q } = modelArgs();
  const g = bsGreeks(state.type, S, K, T, r, sigma, q);

  if (!g) {
    setStatus(els.status, 'error', 'Spot and strike must both be positive numbers.');
  } else if (T === 0) {
    // 'note' is neither 'loading' nor 'error', so setStatus shows it plainly —
    // no pulsing animation, no red. This is information, not a problem.
    setStatus(els.status, 'note',
      'Zero days to expiry — showing the limiting case: price is intrinsic value and delta is a step, ' +
      'which is exactly the shape the payoff curve converges to.');
  } else {
    setStatus(els.status, 'idle');
  }

  renderStats(g);
  drawCharts(g);
  writeHash();
}

// ── Init ────────────────────────────────────────────────────────────────────
function init() {
  els.typeToggle = qs('#type-toggle');
  els.spot = qs('#in-spot');
  els.strike = qs('#in-strike');
  els.dte = qs('#in-dte');
  els.iv = qs('#in-iv');
  els.rate = qs('#in-rate');
  els.rateHint = qs('#rate-hint');
  els.div = qs('#in-div');
  els.dteChips = qs('#dte-chips');
  els.status = qs('#status');
  els.stats = qs('#stats');
  els.market = qs('#in-market');
  els.solveBtn = qs('#solve-btn');
  els.solveResult = qs('#solve-result');
  els.greekToggle = qs('#greek-toggle');
  els.payoffCanvas = qs('#payoff-chart');
  els.greekCanvas = qs('#greek-chart');
  els.greekTitle = qs('#greek-chart-title');

  const rateFromUrl = readHash();

  for (const el of [els.spot, els.strike, els.dte, els.iv, els.rate, els.div]) {
    el.addEventListener('input', () => {
      readInputs();
      renderDteChips();
      recompute();
    });
  }
  els.solveBtn.addEventListener('click', solveIv);
  els.market.addEventListener('keydown', (e) => { if (e.key === 'Enter') solveIv(); });

  renderTypeToggle();
  renderDteChips();
  renderCurveToggle();
  syncInputs();
  recompute();

  // The FRED rate is a default, so it must not clobber a rate the user shared
  // in a link.
  if (!rateFromUrl) {
    loadDefaultRate().then(() => {
      syncInputs();
      recompute();
    });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
