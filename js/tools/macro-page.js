// macro-page.js — Macro Dashboard page controller.
// Loads assets/data/macro.json (sentiment, from CBOE) and assets/data/
// macro-fred.json (regime matrix, inflation, policy, bonds, liquidity, from
// FRED) independently — either can fail without breaking the other blocks.

import { fetchJSON, setLoading, setError, setStatus, fmtNum, fmtTimestamp, qs } from './common.js';
import { PALETTE, applyTheme, centerTextPlugin } from './chart-theme.js';
import { bandLabel, bandColor, componentRead, QUADRANTS, matrixDotPosition, THRESHOLDS } from './macro.js';

const els = {};
const charts = {};

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

function shortDate(d) {
  if (!d) return '—';
  const [y, m] = d.split('-');
  return `${m}/${y.slice(2)}`;
}

function statCard(label, value, cls, sub) {
  return `<div class="tool-stat"><span class="tool-stat-label">${label}</span>` +
    `<span class="tool-stat-value${cls ? ' ' + cls : ''}">${value}</span>` +
    (sub ? `<span class="tool-stat-sub">${sub}</span>` : '') + `</div>`;
}

// ── Sentiment (CBOE) ─────────────────────────────────────────────────────────
async function loadSentiment() {
  try {
    const data = await fetchJSON('/assets/data/macro.json', { timeoutMs: 12000 });
    renderMeters(data.components || []);
    await drawGauge(data.composite, data.label);
    return data;
  } catch (err) {
    els.meters.innerHTML = `<div class="tool-stat"><span class="tool-stat-label">Sentiment</span><span class="tool-stat-value bearish">Unavailable</span></div>`;
    return null;
  }
}

// One horizontal meter per component, positioned by where its RAW reading
// sits between the metric's own greed/fear thresholds (js/tools/macro.js
// THRESHOLDS) — not the abstract 0-100 score. A radar/bar of the score alone
// made an out-of-range reading like a put/call ratio past its 1.30 ceiling
// indistinguishable from one sitting right at the ceiling; clamping the fill
// at 100% while still printing the raw value keeps that visible.
function renderMeters(components) {
  els.meters.innerHTML = components.map((c) => {
    const t = THRESHOLDS[c.key];
    const color = bandColor(c.score);
    let pct = 50;
    if (t && Number.isFinite(c.raw)) {
      pct = ((c.raw - t.greed) / (t.fear - t.greed)) * 100;
      pct = Math.max(0, Math.min(100, pct));
    }
    return `<div class="tool-meter">` +
      `<div class="tool-meter-head">` +
      `<span class="tool-meter-label">${c.label}</span>` +
      `<span class="tool-meter-value" style="color:${color}">${c.reading} <span class="tool-meter-sub">score ${Number.isFinite(c.score) ? c.score : '—'} · ${c.read || componentRead(c.score)}</span></span>` +
      `</div>` +
      `<div class="tool-meter-track"><div class="tool-meter-fill" style="width:${pct}%;background:${color}"></div></div>` +
      (t ? `<div class="tool-meter-scale"><span>${t.greed} (calm)</span><span>${t.fear} (fear)</span></div>` : '') +
      `</div>`;
  }).join('');
}

async function drawGauge(score, label) {
  const Chart = await whenChartReady().catch(() => null);
  if (!Chart) return;
  applyTheme(Chart);
  const val = Number.isFinite(score) ? score : 0;
  const color = bandColor(score);
  if (charts.gauge) charts.gauge.destroy();
  charts.gauge = new Chart(els.gauge.getContext('2d'), {
    type: 'doughnut',
    data: { datasets: [{ data: [val, 100 - val], backgroundColor: [color, '#1a1a1a'], borderColor: PALETTE.border, borderWidth: 1, circumference: 180, rotation: 270, cutout: '68%' }] },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false }, tooltip: { enabled: false },
        centerText: { line1: Number.isFinite(score) ? String(score) : '—', line2: label || bandLabel(score), color },
      },
    },
    plugins: [centerTextPlugin],
  });
}

// ── Generic line chart (category x-axis of date/label strings) ─────────────
async function drawLineChart(canvas, key, { datasets, yLabel, suffix = '', maxTicks = 8 }) {
  const Chart = await whenChartReady().catch(() => null);
  if (!Chart) return;
  applyTheme(Chart);
  const labels = datasets[0].points.map((p) => shortDate(p.date));
  if (charts[key]) charts[key].destroy();
  charts[key] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((d) => ({
        label: d.label, data: d.points.map((p) => p.value), borderColor: d.color, backgroundColor: d.color,
        borderWidth: 1.5, pointRadius: 0, tension: 0.15, borderDash: d.dash || undefined,
      })),
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: PALETTE.muted, maxTicksLimit: maxTicks, autoSkip: true } },
        y: { title: { display: !!yLabel, text: yLabel, color: PALETTE.muted }, grid: { color: PALETTE.grid }, ticks: { color: PALETTE.muted } },
      },
      plugins: {
        legend: { display: datasets.length > 1, labels: { color: PALETTE.muted } },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${fmtNum(item.parsed.y, 2)}${suffix}` } },
      },
    },
  });
}

// ── Fed Regime Matrix ────────────────────────────────────────────────────────
// Fixed visual layout: rows = rate level (Low top, High bottom), columns =
// balance-sheet trend (Expanding left, Shrinking right).
const MATRIX_LAYOUT = [['A', 'C'], ['B', 'D']];

function renderMatrix(fred) {
  const m = fred && fred.matrix;
  const quadrant = m ? m.quadrant : null;

  els.matrixGrid.innerHTML = MATRIX_LAYOUT.flat().map((letter) => {
    const q = QUADRANTS[letter];
    const active = letter === quadrant;
    return `<div class="tool-matrix-cell${active ? ' active' : ''}" data-letter="${letter}">` +
      `<span class="tool-matrix-letter">${letter}${active ? ' · CURRENT' : ''}</span>` +
      `<span class="tool-matrix-label">${q.label}</span>` +
      `<span class="tool-matrix-strategy">${q.strategy}</span>` +
      `</div>`;
  }).join('');

  if (!m || !m.fedFunds) {
    els.matrixStats.innerHTML = statCard('Fed Regime', 'Unavailable');
    return;
  }

  const pos = matrixDotPosition(m.fedFunds.value, m.walclDeltaPct3mo, { highThreshold: m.rateHighThreshold });
  if (pos) renderMatrixDot(pos, m, quadrant);

  const rateCls = m.rateRegime === 'high' ? 'bearish' : 'bullish';
  const bsCls = m.bsTrend === 'expanding' ? 'bullish' : 'bearish';
  els.matrixStats.innerHTML =
    statCard('Fed Funds Rate', `${fmtNum(m.fedFunds.value, 2)}%`, rateCls, `${m.rateRegime} (≥ ${m.rateHighThreshold}% = high)`) +
    statCard('Balance Sheet, 3mo Δ', `${m.walclDeltaPct3mo >= 0 ? '+' : ''}${fmtNum(m.walclDeltaPct3mo, 2)}%`, bsCls, m.bsTrend) +
    statCard('Current Quadrant', quadrant || '—', '', quadrant ? QUADRANTS[quadrant].label : '');
}

// Plots a translucent dot at the market's {x,y} position inside the grid,
// plus dashed crosshair lines (hidden by default) reaching to each axis.
// Hovering a non-active quadrant hides the dot; hovering the dot itself
// reveals the crosshairs. The active quadrant (where the dot lives) doesn't
// hide it, so the mouse can travel through that cell to reach the dot.
function renderMatrixDot(pos, m, quadrant) {
  const xPct = (pos.x * 100).toFixed(2), yPct = (pos.y * 100).toFixed(2);
  const rateLabel = `${fmtNum(m.fedFunds.value, 2)}%`;
  const bsLabel = `${m.walclDeltaPct3mo >= 0 ? '+' : ''}${fmtNum(m.walclDeltaPct3mo, 2)}%`;

  const wrap = document.createElement('div');
  wrap.innerHTML =
    `<div class="tool-matrix-cross-h" style="top:${yPct}%;width:${xPct}%"></div>` +
    `<div class="tool-matrix-cross-v" style="left:${xPct}%;top:${yPct}%;height:${(100 - pos.y * 100).toFixed(2)}%"></div>` +
    `<span class="tool-matrix-cross-label tool-matrix-cross-label-y" style="top:${yPct}%">${rateLabel}</span>` +
    `<span class="tool-matrix-cross-label tool-matrix-cross-label-x" style="left:${xPct}%">${bsLabel}</span>` +
    `<div class="tool-matrix-dot" style="left:${xPct}%;top:${yPct}%" tabindex="0" aria-label="Current market position: ${rateLabel} Fed Funds, ${bsLabel} balance-sheet 3mo change"></div>`;
  while (wrap.firstChild) els.matrixGrid.appendChild(wrap.firstChild);

  const dot = els.matrixGrid.querySelector('.tool-matrix-dot');
  const showCross = () => els.matrixGrid.classList.add('show-cross');
  const hideCross = () => els.matrixGrid.classList.remove('show-cross');
  dot.addEventListener('mouseenter', showCross);
  dot.addEventListener('mouseleave', hideCross);
  dot.addEventListener('focus', showCross);
  dot.addEventListener('blur', hideCross);

  for (const cell of els.matrixGrid.querySelectorAll('.tool-matrix-cell')) {
    if (cell.dataset.letter === quadrant) continue;
    cell.addEventListener('mouseenter', () => els.matrixGrid.classList.add('dot-hidden'));
    cell.addEventListener('mouseleave', () => els.matrixGrid.classList.remove('dot-hidden'));
  }
}

// ── Inflation ────────────────────────────────────────────────────────────────
function renderInflationStats(fred) {
  const L = fred.latest;
  els.inflationStats.innerHTML =
    statCard('CPI YoY', L.cpiYoy ? `${fmtNum(L.cpiYoy.value, 1)}%` : '—', '', L.cpiYoy ? shortDate(L.cpiYoy.date) : '') +
    statCard('Core CPI YoY', L.coreCpiYoy ? `${fmtNum(L.coreCpiYoy.value, 1)}%` : '—', '', L.coreCpiYoy ? shortDate(L.coreCpiYoy.date) : '') +
    statCard('Core PCE YoY', L.corePceYoy ? `${fmtNum(L.corePceYoy.value, 1)}%` : '—', '', L.corePceYoy ? shortDate(L.corePceYoy.date) : '') +
    statCard('Unemployment', L.unrate ? `${fmtNum(L.unrate.value, 1)}%` : '—', '', L.unrate ? shortDate(L.unrate.date) : '');
}

// ── Bonds ────────────────────────────────────────────────────────────────────
function renderBondsStats(fred) {
  const L = fred.latest;
  const spreadCls = L.t10y2y && L.t10y2y.value < 0 ? 'bearish' : 'bullish';
  els.bondsStats.innerHTML =
    statCard('10Y − 2Y Spread', L.t10y2y ? `${fmtNum(L.t10y2y.value, 2)}%` : '—', spreadCls, L.t10y2y && L.t10y2y.value < 0 ? 'inverted' : 'normal') +
    statCard('3M Yield', `${fmtNum(fred.yieldCurveNow[0]?.value, 2)}%`) +
    statCard('10Y Yield', `${fmtNum(fred.yieldCurveNow[3]?.value, 2)}%`) +
    statCard('30Y Yield', `${fmtNum(fred.yieldCurveNow[4]?.value, 2)}%`);
}

async function drawYieldCurve(fred) {
  const Chart = await whenChartReady().catch(() => null);
  if (!Chart) return;
  applyTheme(Chart);
  if (charts.curve) charts.curve.destroy();
  charts.curve = new Chart(els.curveChart.getContext('2d'), {
    type: 'line',
    data: {
      labels: fred.yieldCurveNow.map((p) => p.label),
      datasets: [
        { label: 'Now', data: fred.yieldCurveNow.map((p) => p.value), borderColor: PALETTE.text, backgroundColor: PALETTE.text, borderWidth: 2, pointRadius: 2, tension: 0.1 },
        { label: '1Y Ago', data: fred.yieldCurve1yAgo.map((p) => p.value), borderColor: PALETTE.muted, backgroundColor: PALETTE.muted, borderWidth: 1.5, borderDash: [4, 4], pointRadius: 2, tension: 0.1 },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { title: { display: true, text: 'Maturity', color: PALETTE.muted }, grid: { display: false }, ticks: { color: PALETTE.muted } },
        y: { title: { display: true, text: 'Yield %', color: PALETTE.muted }, grid: { color: PALETTE.grid }, ticks: { color: PALETTE.muted } },
      },
      plugins: { legend: { labels: { color: PALETTE.muted } }, tooltip: { callbacks: { label: (i) => `${i.dataset.label}: ${fmtNum(i.parsed.y, 2)}%` } } },
    },
  });
}

// ── Init ────────────────────────────────────────────────────────────────────
async function loadFred() {
  let fred;
  try {
    fred = await fetchJSON('/assets/data/macro-fred.json', { timeoutMs: 15000 });
  } catch {
    for (const id of ['matrix-stats', 'matrix-grid', 'inflation-stats', 'bonds-stats']) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = statCard('FRED data', 'Unavailable');
    }
    return null;
  }

  renderMatrix(fred);
  renderInflationStats(fred);
  renderBondsStats(fred);

  await drawLineChart(els.inflationChart, 'inflation', {
    yLabel: '% YoY',
    datasets: [
      { label: 'CPI', points: fred.series.cpiYoy, color: PALETTE.text },
      { label: 'Core CPI', points: fred.series.coreCpiYoy, color: PALETTE.neutral },
      { label: 'Core PCE', points: fred.series.corePceYoy, color: PALETTE.bearish },
    ],
  });

  await drawLineChart(els.policyChart, 'policy', {
    yLabel: 'Fed Funds %',
    datasets: [
      { label: 'Fed Funds Rate (%)', points: fred.series.fedFunds, color: PALETTE.text },
      { label: 'Balance Sheet ($T)', points: fred.series.walcl, color: PALETTE.neutral },
    ],
  });

  await drawYieldCurve(fred);

  await drawLineChart(els.spreadChart, 'spread', {
    yLabel: '%',
    datasets: [{ label: '10Y − 2Y', points: fred.series.t10y2y, color: PALETTE.text }],
  });

  await drawLineChart(els.m2Chart, 'm2', {
    yLabel: '% YoY',
    datasets: [{ label: 'M2 YoY', points: fred.series.m2Yoy, color: PALETTE.text }],
  });

  await drawLineChart(els.rrpChart, 'rrp', {
    yLabel: '$B',
    datasets: [{ label: 'Overnight RRP', points: fred.series.rrp, color: PALETTE.text }],
  });

  return fred;
}

async function load() {
  setLoading(els.status, 'Loading dashboard…');
  els.results.classList.add('tool-hidden');

  // Both loaders catch their own errors and resolve with null on failure
  // (each block degrades independently), so failure is read from the
  // resolved value, not promise rejection.
  const [sentiment, fred] = await Promise.all([loadSentiment(), loadFred()]);

  if (!sentiment && !fred) {
    setError(els.status, "Couldn't load dashboard data.", load);
    return;
  }

  setStatus(els.status, 'idle');
  els.results.classList.remove('tool-hidden');

  els.updated.textContent = fred
    ? `CBOE delayed + FRED · generated ${fmtTimestamp(fred.generated)}`
    : 'CBOE delayed';
}

function init() {
  els.status = qs('#status');
  els.results = qs('#results');
  els.meters = qs('#meters');
  els.gauge = qs('#gauge-chart');
  els.matrixStats = qs('#matrix-stats');
  els.matrixGrid = qs('#matrix-grid');
  els.inflationStats = qs('#inflation-stats');
  els.inflationChart = qs('#inflation-chart');
  els.policyChart = qs('#policy-chart');
  els.bondsStats = qs('#bonds-stats');
  els.curveChart = qs('#curve-chart');
  els.spreadChart = qs('#spread-chart');
  els.m2Chart = qs('#m2-chart');
  els.rrpChart = qs('#rrp-chart');
  els.updated = qs('#updated');
  load();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
