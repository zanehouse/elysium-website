// signals-page.js — Smart-Money Signals page controller.
// Composes a per-ticker "smart money" read from data the site already
// prefetches for other tools:
//   - insider Form 4 detail (assets/data/insiders/<T>.json — the ~9 richly
//     parsed names in insiders-manifest.json)
//   - options chain (assets/data/gex/<T>.json — the ~60 names in manifest.gex)
// Each leg degrades independently (like macro-page.js's two sources): a ticker
// with a chain but no parsed insider file still gets 2 of 3 axes. Congressional
// filings are shown as a separate, market-wide, UNSCORED pulse (no ticker/amount
// exists in machine-readable form — see js/tools/congress.js).

import { fetchData, loadManifest, setLoading, setError, setStatus, fmtTimestamp, fmtSignedMoney, qs, SEP } from './common.js';
import { PALETTE, applyTheme } from './chart-theme.js';
import { bandColor } from './macro.js';
import { insiderScore, skewScore, gammaRegimeScore, compositeScore, readLabel } from './signals.js';

const FALLBACK_INSIDER = ['AAPL', 'NVDA', 'TSLA', 'AMZN', 'MSFT', 'META', 'GOOGL', 'AMD', 'NFLX'];

const els = {};
let insiderCovered = new Set();
let gexCovered = new Set();
let radarChart = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Compact GEX contract {e,t,k,oi,g,v} -> {expiry,type,strike,oi,gamma,volume},
// same expansion the GEX tool uses.
function expandContract(c) {
  return { expiry: c.e, type: c.t, strike: c.k, oi: c.oi, gamma: c.g, volume: c.v || 0 };
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

// ── Presets ───────────────────────────────────────────────────────────────
async function buildPresets() {
  let symbols = FALLBACK_INSIDER;
  try {
    const m = await fetchData('/assets/data/insiders-manifest.json', { timeoutMs: 8000 });
    if (Array.isArray(m.symbols) && m.symbols.length) symbols = m.symbols;
  } catch { /* keep fallback */ }
  insiderCovered = new Set(symbols);

  try {
    const manifest = await loadManifest();
    if (Array.isArray(manifest.gex)) gexCovered = new Set(manifest.gex);
  } catch { /* gexCovered stays empty; a load will just fail gracefully */ }

  els.presets.innerHTML = '';
  // Fully-scored names first (insider file AND chain), the richest experience.
  for (const sym of symbols) {
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.textContent = sym;
    b.style.padding = '.4rem .7rem';
    b.addEventListener('click', () => { els.input.value = ''; load(sym); });
    els.presets.appendChild(b);
  }
}

// ── Load + score ─────────────────────────────────────────────────────────
async function load(rawTicker) {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker) return;
  location.hash = ticker;
  setLoading(els.status, `Scoring ${ticker}…`);
  els.results.classList.add('tool-hidden');

  // Both legs resolve to null on any failure so a partial read still renders.
  const [insiderData, gexData] = await Promise.all([
    insiderCovered.has(ticker)
      ? fetchData(`/assets/data/insiders/${ticker}.json`, { timeoutMs: 12000 }).catch(() => null)
      : Promise.resolve(null),
    gexCovered.has(ticker)
      ? fetchData(`/assets/data/gex/${ticker}.json`, { timeoutMs: 15000 }).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (!insiderData && !gexData) {
    setError(
      els.status,
      `No prefetched data for “${ticker}”. Try a preset above (options coverage spans ~60 large caps; ` +
      `full insider detail covers the highlighted names).`,
    );
    return;
  }

  const contracts = gexData ? gexData.contracts.map(expandContract) : null;
  const spot = gexData ? gexData.spot : null;

  const legs = {
    insider: insiderData ? insiderScore(insiderData) : null,
    skew: contracts ? skewScore(contracts, spot) : null,
    gamma: contracts ? gammaRegimeScore(contracts, spot, ticker) : null,
  };
  const composite = compositeScore([legs.insider, legs.skew, legs.gamma]);

  setStatus(els.status, 'idle');
  els.results.classList.remove('tool-hidden');
  els.company.innerHTML = `<b>${esc(insiderData?.name || ticker)}</b>` +
    (insiderData?.cik ? `${SEP}CIK ${esc(insiderData.cik)}` : '');

  renderComposite(composite);
  renderBreakdown(legs, { insiderData, gexData, spot });
  await drawRadar(legs);

  const parts = [];
  if (gexData) parts.push(`CBOE delayed, chain as of ${fmtTimestamp(gexData.asof)}`);
  if (insiderData) parts.push(`SEC Form 4, parsed ${fmtTimestamp(insiderData.generated)}`);
  els.updated.innerHTML = parts.join(SEP);
}

function renderComposite(score) {
  const color = bandColor(score);
  const label = readLabel(score);
  els.composite.innerHTML =
    `<div class="tool-stat">` +
    `<span class="tool-stat-label">Smart-Money Composite</span>` +
    `<span class="tool-stat-value" style="color:${color}">${Number.isFinite(score) ? score : '—'}</span>` +
    `<span class="tool-stat-sub" style="color:${color}">${label}</span>` +
    `</div>`;
}

// Each leg gets a stat card with its score, a plain-language read, and the raw
// figure that drove it, so the composite is never a black box.
function renderBreakdown(legs, ctx) {
  const cards = [];

  // Insider leg.
  if (Number.isFinite(legs.insider)) {
    const net = insiderNetValue(ctx.insiderData);
    cards.push(legCard('Insider Buying', legs.insider,
      `Net ${fmtSignedMoney(net)} over ~180d (Form 4)`));
  } else {
    cards.push(legCardUnavailable('Insider Buying',
      ctx.insiderData ? 'No valued trades in window' : 'No parsed insider file'));
  }

  // Options skew leg.
  if (Number.isFinite(legs.skew)) {
    cards.push(legCard('Options Positioning', legs.skew, 'Near-the-money put/call OI'));
  } else {
    cards.push(legCardUnavailable('Options Positioning',
      ctx.gexData ? 'Thin near-money chain' : 'No options chain'));
  }

  // Gamma regime leg.
  if (Number.isFinite(legs.gamma)) {
    const read = legs.gamma >= 55 ? 'Dealers long gamma (stabilizing)'
      : legs.gamma <= 45 ? 'Dealers short gamma (amplifying)'
      : 'Balanced dealer gamma';
    cards.push(legCard('Gamma Regime', legs.gamma, read));
  } else {
    cards.push(legCardUnavailable('Gamma Regime',
      ctx.gexData ? 'No selectable contracts' : 'No options chain'));
  }

  els.breakdown.innerHTML = cards.join('');
}

function legCard(label, score, sub) {
  const color = bandColor(score);
  return `<div class="tool-stat">` +
    `<span class="tool-stat-label">${label}</span>` +
    `<span class="tool-stat-value" style="color:${color}">${score}</span>` +
    `<span class="tool-stat-sub">${sub}${SEP}${readLabel(score)}</span>` +
    `</div>`;
}

function legCardUnavailable(label, why) {
  return `<div class="tool-stat">` +
    `<span class="tool-stat-label">${label}</span>` +
    `<span class="tool-stat-value" style="color:${PALETTE.muted}">—</span>` +
    `<span class="tool-stat-sub">${why}</span>` +
    `</div>`;
}

function insiderNetValue(data) {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() - 180 * 86400000;
  let net = 0;
  for (const f of (data && data.filings) || []) {
    for (const t of f.tx || []) {
      if (!t.value) continue;
      if (new Date(`${t.date}T00:00:00Z`).getTime() < cutoff) continue;
      net += t.side === 'buy' ? t.value : (t.side === 'sell' ? -t.value : 0);
    }
  }
  return net;
}

// ── Radar ─────────────────────────────────────────────────────────────────
async function drawRadar(legs) {
  const Chart = await whenChartReady().catch(() => null);
  if (!Chart) return;
  applyTheme(Chart);

  // Chart.js radar can't render a null point; a missing leg plots at 0 but is
  // clearly flagged in the breakdown cards, and its axis label is marked "n/a".
  const axes = [
    { key: 'insider', label: 'Insider Buying' },
    { key: 'skew', label: 'Options Positioning' },
    { key: 'gamma', label: 'Gamma Regime' },
  ];
  const labels = axes.map((a) => Number.isFinite(legs[a.key]) ? a.label : `${a.label} (n/a)`);
  const values = axes.map((a) => Number.isFinite(legs[a.key]) ? legs[a.key] : 0);

  if (radarChart) radarChart.destroy();
  radarChart = new Chart(els.radar.getContext('2d'), {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: 'Smart-money score',
        data: values,
        borderColor: PALETTE.text,
        backgroundColor: 'rgba(212,212,212,0.12)',
        borderWidth: 1.5,
        pointBackgroundColor: values.map((v) => bandColor(v)),
        pointBorderColor: values.map((v) => bandColor(v)),
        pointRadius: 4,
      }],
    },
    options: {
      responsive: true,
      // Reserve room inside the canvas so the three point labels (which sit
      // outside the outer ring) aren't clipped by the canvas edge.
      layout: { padding: 24 },
      scales: {
        r: {
          min: 0, max: 100,
          ticks: { stepSize: 25, color: PALETTE.muted, backdropColor: 'transparent', font: { size: 9 } },
          grid: { color: PALETTE.grid },
          angleLines: { color: PALETTE.grid },
          pointLabels: { color: PALETTE.text, font: { family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", size: 11 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (i) => `${i.label}: ${i.parsed.r}` } },
      },
    },
  });
}

// ── Congress pulse (market-wide, unscored) ─────────────────────────────────
async function loadCongress() {
  try {
    const data = await fetchData('/assets/data/congress.json', { timeoutMs: 15000 });
    const rows = (data.filings || []).slice(0, 12);
    els.congress.innerHTML = rows.map((r) =>
      `<li class="tool-pulse-item">` +
      `<span class="tool-pulse-date">${esc(r.filingDate)}</span>` +
      `<a class="tool-pulse-name" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>` +
      `<span class="tool-pulse-meta">${esc(r.stateDst)}</span>` +
      `</li>`
    ).join('');
    els.congressUpdated.innerHTML = `House Clerk${SEP}parsed ${fmtTimestamp(data.generated)}`;
  } catch {
    els.congress.innerHTML = '<li class="tool-pulse-item">Congressional filings unavailable.</li>';
  }
}

// ── Init ────────────────────────────────────────────────────────────────────
function init() {
  els.presets = qs('#preset-btns');
  els.input = qs('#ticker-input');
  els.loadBtn = qs('#load-btn');
  els.status = qs('#status');
  els.results = qs('#results');
  els.company = qs('#company');
  els.composite = qs('#composite');
  els.breakdown = qs('#breakdown');
  els.radar = qs('#radar-chart');
  els.updated = qs('#updated');
  els.congress = qs('#congress-pulse');
  els.congressUpdated = qs('#congress-updated');

  els.loadBtn.addEventListener('click', () => load(els.input.value));
  els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(els.input.value); });

  loadCongress();
  buildPresets().finally(() => {
    const initial = (location.hash || '').replace('#', '').toUpperCase() || 'AAPL';
    load(initial);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
