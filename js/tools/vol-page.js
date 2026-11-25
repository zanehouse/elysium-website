// vol-page.js — Volatility Surface & Skew page controller.
// Loads the same prefetched chain the GEX tool uses (assets/data/gex/<SYM>.json)
// and runs js/tools/vol.js over it. Uncovered tickers fall back to the live
// CORS-proxied CBOE fetch, exactly as gex-page.js does — and on this page that
// path is strictly better data, since it returns the full unfiltered board
// rather than the ±25% / open-interest-floored committed slice.
//
// One wrinkle worth knowing: `iv` was added to the committed chain shape after
// these files had already been in production for a while, so a snapshot that
// hasn't been refreshed since carries no implied volatility at all. That is
// detected PER FILE at load rather than from a manifest flag — during a refresh
// cycle some symbols have the field and others don't, so a global flag would be
// wrong for ~20 minutes twice an hour.

import {
  fetchData, loadManifest, setLoading, setError, setStatus, fmtStrike, fmtTimestamp, qs,
  watchManifest, startFreshnessTicker, SEP,
} from './common.js';
import { PALETTE, applyTheme, rampColor, SERIES_DASH, verticalLinePlugin } from './chart-theme.js';
import { fetchChainViaProxy, parseChain, displaySymbol } from './cboe.js';
import {
  buildSmiles, termStructure, interpolateAtmIv, termSlope, skewSlope, skewAtMoneyness,
  atmIv, referenceSmile, surfaceGrid, fillGridInTime, densifyGrid, ivColorDomain,
  countIvQuotes, VOL_DEFAULTS, niceTicks,
} from './vol.js';
import { fitSvi, sviCurve, ivAtMoneynessSmoothed } from './svi.js';

const FALLBACK_SYMBOLS = ['SPX', 'SPY', 'QQQ', 'IWM', 'RUT', 'NDX'];

// Same curated row as the GEX tool — indices first, then the megacaps and
// higher-beta names that carry the deepest options volume.
const PRESET_ROW = [
  'SPX', 'SPY', 'NDX', 'QQQ',
  'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AVGO', 'NFLX', 'AMD',
  'JPM', 'XOM',
  'PLTR', 'COIN', 'MSTR', 'HOOD', 'SOFI', 'DKNG', 'GME',
];

// Lightness plus dash pattern separates about six lines on a monochrome page;
// past that the smile chart turns to soup. Enforced in the chip handler.
const MAX_SERIES = 6;

// Human-readable gridlines for the logarithmic term-structure axis.
const TERM_TICKS = [1, 7, 14, 30, 60, 90, 180, 365, 730, 1095];

let coveredSymbols = new Set(FALLBACK_SYMBOLS);

const state = {
  symbol: null,
  data: null,
  spot: null,
  today: null,
  smiles: [],
  term: [],
  selected: new Set(),   // expiry dates plotted on the smile chart
  xAxis: 'moneyness',    // 'moneyness' | 'strike'
  live: false,
  smileChart: null,
  termChart: null,
};

const els = {};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Compact {e,t,k,oi,g,v,iv} -> the shape vol.js and gex.js expect. Unlike the
// GEX page's expand(), this one carries iv through.
function expand(c) {
  return {
    expiry: c.e, type: c.t, strike: c.k, oi: c.oi, gamma: c.g, volume: c.v || 0,
    ...(c.iv != null ? { iv: c.iv } : {}),
  };
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function pct(x, dp = 2) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(dp)}%` : '—';
}

function shortDate(d) {
  const [, m, day] = d.split('-');
  return `${m}/${day}`;
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

// ── Presets ─────────────────────────────────────────────────────────────────
async function buildPresets() {
  let symbols = FALLBACK_SYMBOLS;
  try {
    const manifest = await loadManifest();
    if (Array.isArray(manifest.gex) && manifest.gex.length) symbols = manifest.gex;
  } catch { /* keep the static fallback */ }
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
  if (els.datalist) els.datalist.innerHTML = symbols.map((s) => `<option value="${esc(s)}">`).join('');
}

function updatePresetActiveState() {
  for (const b of els.presets.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.symbol === state.symbol);
  }
}

// ── Load ────────────────────────────────────────────────────────────────────
function adaptLiveChain(symbol, parsed) {
  return {
    symbol, spot: parsed.spot, asof: parsed.asof, today: todayISO(),
    contracts: parsed.contracts, live: true,
  };
}

// The two acquisition paths, each returning the same shape or throwing, so the
// caller can try one and fall through to the other.
async function loadPrefetched(symbol) {
  const data = await fetchData(`/assets/data/gex/${symbol}.json`, { timeoutMs: 15000 });
  data.contracts = data.contracts.map(expand);
  return data;
}

async function loadLive(symbol) {
  const raw = await fetchChainViaProxy(symbol);
  const parsed = parseChain(raw);
  if (!parsed.spot || !parsed.contracts.length) throw new Error('empty chain — check the ticker');
  return adaptLiveChain(displaySymbol(symbol), parsed);
}

// Default selection: the expiries nearest one week, one month and one quarter.
// Deliberately NOT "front, 30d, longest" — the front is usually tomorrow, and
// a 1-DTE smile swings across a range several times wider than every other
// expiry, which flattens the rest of the chart into the axis. The longest
// listed expiry can be three years out and is just as distorting. A 7/30/90
// ladder shows the term structure over the range people actually trade; the
// front and the LEAPS are one chip-click away.
function defaultSelection(smiles) {
  const sel = new Set(
    [7, 30, 90].map((d) => referenceSmile(smiles, d)).filter(Boolean).map((s) => s.date),
  );
  return sel.size ? sel : new Set([smiles[0].date]);
}

let stopFreshnessTicker = null;

// Shared by load() (user-initiated, full status/error UI) and silentReload()
// (manifest-triggered, no UI beyond the live "updated" line) so the two can
// never render differently for the same data. `silent: true` additionally
// preserves whatever the user was looking at — selected expiries, camera
// orbit — rather than resetting to defaults, so a background refresh reads
// as a live tick rather than the page reloading under them.
async function applyLoadedData(symbol, data, isLive, opts = {}) {
  const { silent = false } = opts;

  state.data = data;
  state.spot = data.spot;
  state.today = data.today;
  state.live = isLive;

  const withIv = countIvQuotes(data.contracts);

  // Attach a per-expiry SVI fit alongside each smile. `svi.ok` is checked
  // (never assumed) at every read site — a rejected fit means that expiry
  // keeps drawing exactly today's plain-linear-interpolation behavior; see
  // js/tools/svi.js's header for why a fit is accepted or rejected outright
  // rather than degraded.
  state.smiles = buildSmiles(data.contracts, data.spot, data.today)
    .map((s) => ({ ...s, svi: fitSvi(s) }));
  if (!state.smiles.length) {
    if (silent) return; // keep showing whatever was already on screen
    setError(
      els.status,
      `${esc(symbol)} has implied-volatility quotes but not enough of them to build a smile ` +
      `(${withIv} quoted contracts, none forming ${VOL_DEFAULTS.minPointsPerExpiry}+ out-of-the-money ` +
      'strikes on a single expiration). This is normal for thinly-traded names.',
      () => load(symbol),
    );
    return;
  }
  state.term = termStructure(state.smiles);

  if (silent) {
    // Keep the user's chip selection, dropping only expiries that rolled off
    // the board entirely.
    const stillListed = new Set(state.smiles.map((s) => s.date));
    const kept = new Set([...state.selected].filter((d) => stillListed.has(d)));
    state.selected = kept.size ? kept : defaultSelection(state.smiles);
  } else {
    state.selected = defaultSelection(state.smiles);
    setStatus(els.status, 'idle');
    els.results.classList.remove('tool-hidden');
  }

  renderStats();
  renderExpiryChips();
  renderXAxisToggle();
  renderSummary(withIv);
  // The surface uses every listed expiry, not just the chips' selection — the
  // chips control the 2D smile overlay, the surface shows the whole board.
  // keepRotation on a silent refresh: this is the SAME symbol's surface being
  // updated in place, not a switch — snapping the camera's auto-spin angle
  // back to 0 here would read as a jump, not a live tick.
  updateSurface({ keepRotation: silent });
  await drawCharts();

  const src = isLive ? 'live via public proxy (full board)' : 'CBOE delayed';
  if (stopFreshnessTicker) stopFreshnessTicker();
  els.updated.innerHTML =
    `${src}${SEP}as of ${fmtTimestamp(data.asof)}${SEP}spot ${fmtStrike(data.spot)}${SEP}` +
    `<span id="freshness-tick"></span>`;
  stopFreshnessTicker = startFreshnessTicker(els.updated.querySelector('#freshness-tick'), Date.now());
}

async function load(rawSymbol) {
  const symbol = String(rawSymbol || '').trim().toUpperCase().replace(/^_/, '');
  if (!symbol) return;
  state.symbol = symbol;
  location.hash = symbol;
  els.results.classList.add('tool-hidden');
  updatePresetActiveState();

  let data, isLive = false;
  if (coveredSymbols.has(symbol)) {
    setLoading(els.status, `Loading ${symbol} chain…`);
    try {
      data = await loadPrefetched(symbol);
    } catch (err) {
      setError(els.status, `Couldn't load ${esc(symbol)} (${err.kind || 'error'}).`, () => load(symbol));
      return;
    }

    /* A prefetched snapshot taken before `iv` was added to the committed chain
       shape carries no implied volatility at all. That used to be a dead end.
       It is worth one live lookup instead: the proxy path returns the full
       board and self-heals the page while the next scheduled refresh catches
       up. The cost is honest — a fast failure becomes a several-second proxy
       race — which is why it sits behind its own status line. */
    if (countIvQuotes(data.contracts) === 0) {
      setLoading(els.status, `${symbol}'s stored snapshot has no implied volatility — trying a live lookup…`);
      try {
        data = await loadLive(symbol);
        isLive = true;
      } catch {
        setError(
          els.status,
          `This ${esc(symbol)} chain snapshot predates the implied-volatility field ` +
          `(spot ${fmtStrike(data.spot)}, as of ${fmtTimestamp(data.asof)}), and the live lookup also ` +
          'failed. Chains refresh every 15 minutes during US market hours, so it will populate on the ' +
          'next run. Dealer gamma for this same chain is available now on the ' +
          '<a href="/tools/gex/">GEX tool</a>.',
          () => load(symbol),
        );
        return;
      }
    }
  } else {
    setLoading(els.status, `${symbol} isn't prefetched — trying a live lookup…`);
    try {
      data = await loadLive(symbol);
      isLive = true;
    } catch {
      setError(
        els.status,
        `Live lookup for ${esc(symbol)} failed (public proxies are best-effort and can be unavailable). ` +
        'Try again, or use a prefetched symbol.',
        () => load(symbol),
      );
      return;
    }
  }

  await applyLoadedData(symbol, data, isLive, { silent: false });
}

let silentReloadInFlight = false;

// Triggered by the manifest watcher (see initFreshnessWatch) when
// assets/data/manifest.json's `generated` stamp advances past what this page
// already loaded. Best-effort and quiet by design: no status line, no error
// UI, and a failure here just waits for the next poll rather than disturbing
// whatever is already on screen.
async function silentReload(symbol) {
  if (!symbol || silentReloadInFlight) return;
  silentReloadInFlight = true;
  try {
    let data, isLive = false;
    if (coveredSymbols.has(symbol)) {
      try {
        data = await loadPrefetched(symbol);
      } catch (err) {
        console.debug('[vol] silent refresh: prefetched load failed', err);
        return;
      }
      if (countIvQuotes(data.contracts) === 0) {
        // Don't chase the several-second live-lookup race in the background —
        // that trade-off belongs to an explicit user action (see load()). A
        // silent refresh just waits for the next scheduled snapshot instead.
        return;
      }
    } else {
      try {
        data = await loadLive(symbol);
        isLive = true;
      } catch (err) {
        console.debug('[vol] silent refresh: live lookup failed', err);
        return;
      }
    }
    if (symbol !== state.symbol) return; // the user switched tickers mid-fetch
    await applyLoadedData(symbol, data, isLive, { silent: true });
  } finally {
    silentReloadInFlight = false;
  }
}

let manifestWatcher = null;

// Page-lifetime freshness watch — started once in init(), independent of
// which symbol is currently loaded. See js/tools/common.js's watchManifest
// for the polling/visibility mechanics.
function initFreshnessWatch() {
  loadManifest().then((manifest) => {
    manifestWatcher = watchManifest(manifest.generated, () => silentReload(state.symbol), { intervalMs: 60000 });
  }).catch(() => { /* manifest unreachable — the page still works from what it already loaded */ });
}

// ── Stat cards ──────────────────────────────────────────────────────────────
function statCard(label, value, sub, cls = '') {
  return '<div class="tool-stat">' +
    `<span class="tool-stat-label">${esc(label)}</span>` +
    `<span class="tool-stat-value${cls ? ` ${cls}` : ''}">${value}</span>` +
    `<span class="tool-stat-sub">${sub}</span>` +
    '</div>';
}

function renderStats() {
  const front = state.smiles[0];
  const frontAtm = front ? atmIv(front) : null;
  const iv30 = interpolateAtmIv(state.term, VOL_DEFAULTS.targetDays);
  const shape = termSlope(state.term, VOL_DEFAULTS.targetDays);
  const ref = referenceSmile(state.smiles, VOL_DEFAULTS.targetDays);
  const slope = ref ? skewSlope(ref) : null;
  const skew10 = ref ? skewAtMoneyness(ref, VOL_DEFAULTS.skewMoneyness) : null;

  const cards = [];
  cards.push(statCard('Spot', fmtStrike(state.spot), esc(state.symbol)));

  cards.push(statCard(
    'Front ATM IV',
    pct(frontAtm),
    front ? `${esc(shortDate(front.date))} (${front.dte}d)` : 'unavailable',
  ));

  cards.push(statCard(
    '30d ATM IV',
    iv30 ? pct(iv30.iv) : '—',
    iv30
      ? (iv30.method === 'interp'
        ? `interpolated ${iv30.loDte}–${iv30.hiDte}d`
        : `nearest listed (${iv30.loDte}d)`)
      : 'unavailable',
  ));

  // Backwardation = front vol above the 30-day, the stress/event shape.
  if (shape) {
    const label = shape.shape === 'backwardation' ? 'Backwardation'
      : shape.shape === 'contango' ? 'Contango' : 'Flat';
    const cls = shape.shape === 'backwardation' ? 'bearish'
      : shape.shape === 'contango' ? 'bullish' : 'neutral';
    const pts = (shape.diff * 100).toFixed(2);
    cards.push(statCard('Term Shape', label,
      `front − 30d = ${shape.diff >= 0 ? '+' : '−'}${Math.abs(pts)}pt`, cls));
  } else {
    cards.push(statCard('Term Shape', '—', 'not enough expirations'));
  }

  // Negative slope is the normal equity shape (downside bid).
  if (slope) {
    cards.push(statCard('Skew Slope',
      `${slope.slope >= 0 ? '+' : '−'}${Math.abs(slope.slope).toFixed(4)}`,
      `per σ${SEP}R² ${slope.r2.toFixed(2)}${SEP}${slope.n} pts${SEP}${ref.dte}d`,
      slope.slope < 0 ? 'bearish' : slope.slope > 0 ? 'bullish' : 'neutral'));
  } else {
    cards.push(statCard('Skew Slope', '—', 'no ATM level to normalise by'));
  }

  cards.push(statCard('Skew ±10%',
    skew10 == null ? '—' : `${(skew10 * 100).toFixed(2)}pt`,
    skew10 == null ? 'a wing is outside the strike window' : `put minus call${SEP}${ref.dte}d`));

  els.stats.innerHTML = cards.join('');
}

function renderSummary(withIv) {
  const quoted = state.smiles.reduce((n, s) => n + s.n, 0);
  const total = state.data.contracts.length;
  const src = state.live
    ? 'full unfiltered board via live lookup'
    : 'strikes within ±25% of spot, above the open-interest floor';
  els.summary.innerHTML =
    `${withIv.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} contracts carry a usable IV quote${SEP}` +
    `${quoted.toLocaleString('en-US')} out-of-the-money strikes across ${state.smiles.length} expirations${SEP}${src}`;
}

// ── Controls ────────────────────────────────────────────────────────────────
function renderExpiryChips() {
  els.chips.innerHTML = '';
  for (const s of state.smiles) {
    const b = document.createElement('button');
    const on = state.selected.has(s.date);
    b.className = 'tool-chip' + (on ? ' on' : '');
    b.textContent = `${shortDate(s.date)} (${s.dte}d)`;
    b.dataset.date = s.date;
    b.title = `${s.date} — ${s.n} out-of-the-money strikes`;
    if (!on && state.selected.size >= MAX_SERIES) {
      b.disabled = true;
      b.title = 'Deselect an expiration first — six lines is the legibility limit';
    }
    b.addEventListener('click', () => toggleExpiry(s.date));
    els.chips.appendChild(b);
  }
}

function toggleExpiry(date) {
  if (state.selected.has(date)) {
    if (state.selected.size === 1) return;   // never leave the chart empty
    state.selected.delete(date);
  } else {
    if (state.selected.size >= MAX_SERIES) return;
    state.selected.add(date);
  }
  renderExpiryChips();
  drawCharts();
}

function renderXAxisToggle() {
  const opts = [['moneyness', 'Moneyness'], ['strike', 'Strike']];
  els.xToggle.innerHTML = '';
  for (const [value, label] of opts) {
    const b = document.createElement('button');
    b.className = 'tool-chip' + (state.xAxis === value ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      if (state.xAxis === value) return;
      state.xAxis = value;
      renderXAxisToggle();
      drawCharts();
    });
    els.xToggle.appendChild(b);
  }
}

// ── Charts ──────────────────────────────────────────────────────────────────
async function drawCharts() {
  const Chart = await whenChartReady().catch(() => null);
  if (!Chart) return;
  applyTheme(Chart);
  drawSmile(Chart);
  drawTerm(Chart);
}

// One or two Chart.js datasets per plotted expiry. An expiry with an
// accepted SVI fit gets a smooth curve (sampled from sviCurve, never past
// the smile's own quoted range) PLUS the raw quoted points as a separate
// dot-only overlay — the fit is never allowed to hide the quotes it was
// built from. An expiry without a fit draws exactly what this page has
// always drawn: a single line straight through the quoted points.
function smileDatasets(s, i, n, byMoneyness) {
  const color = rampColor(i, n);
  const xOf = (moneyness, strike) => (byMoneyness ? moneyness * 100 : strike);
  const label = `${shortDate(s.date)} (${s.dte}d${s.svi && s.svi.ok ? ', SVI' : ''})`;

  if (!s.svi || !s.svi.ok) {
    return [{
      label,
      data: s.points.map((p) => ({ x: xOf(p.moneyness, p.strike), y: p.iv * 100 })),
      borderColor: color,
      backgroundColor: color,
      borderDash: SERIES_DASH[i % SERIES_DASH.length],
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.25,
    }];
  }

  const curve = sviCurve(s.svi, { steps: 60 });
  return [
    {
      label,
      data: curve.map((c) => ({ x: xOf(c.moneyness, state.spot * (1 + c.moneyness)), y: c.iv * 100 })),
      borderColor: color,
      backgroundColor: color,
      borderDash: SERIES_DASH[i % SERIES_DASH.length],
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 0,
      tension: 0,
    },
    {
      label: `${label} quotes`,
      skipLegend: true,
      data: s.points.map((p) => ({ x: xOf(p.moneyness, p.strike), y: p.iv * 100 })),
      showLine: false,
      borderColor: color,
      backgroundColor: color,
      pointRadius: 2.5,
      pointHoverRadius: 4,
      pointStyle: 'circle',
    },
  ];
}

// date -> index of that expiry's PRIMARY dataset (the curve/line one, never
// the raw-quotes overlay) in the smile chart's current dataset array — how
// the 3D surface's hover crosshair (onSurfaceHover, below) finds what to
// highlight. Rebuilt on every draw since chip selection changes the array.
let smileDatasetIndex = new Map();
let crosshairKey = null;

function drawSmile(Chart) {
  const chosen = state.smiles.filter((s) => state.selected.has(s.date));
  const byMoneyness = state.xAxis === 'moneyness';

  smileDatasetIndex = new Map();
  crosshairKey = null;   // the chart instance below is fresh; no stale highlight to track
  const datasets = [];
  for (let i = 0; i < chosen.length; i++) {
    smileDatasetIndex.set(chosen[i].date, datasets.length);
    for (const d of smileDatasets(chosen[i], i, chosen.length, byMoneyness)) datasets.push(d);
  }

  if (state.smileChart) state.smileChart.destroy();
  state.smileChart = new Chart(els.smileCanvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: {
          type: 'linear',
          title: {
            display: true,
            color: PALETTE.muted,
            text: byMoneyness ? 'Moneyness — strike vs. spot (%)' : 'Strike',
          },
          ticks: {
            color: PALETTE.muted,
            callback: (v) => (byMoneyness ? `${Number(v).toFixed(0)}%` : fmtStrike(Number(v))),
          },
          grid: { color: PALETTE.grid },
        },
        y: {
          title: { display: true, color: PALETTE.muted, text: 'Implied volatility' },
          ticks: { color: PALETTE.muted, callback: (v) => `${Number(v).toFixed(0)}%` },
          grid: { color: PALETTE.grid },
        },
      },
      plugins: {
        legend: {
          display: true, position: 'bottom',
          labels: {
            color: PALETTE.text, usePointStyle: true,
            filter: (item, data) => !data.datasets[item.datasetIndex].skipLegend,
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => (byMoneyness
              ? `Moneyness ${Number(items[0].parsed.x).toFixed(2)}%`
              : `Strike ${fmtStrike(Number(items[0].parsed.x))}`),
            label: (i) => `${i.dataset.label}: ${Number(i.parsed.y).toFixed(2)}% IV`,
          },
        },
        vlines: {
          lines: [{
            x: byMoneyness ? 0 : state.spot,
            label: `Spot ${fmtStrike(state.spot)}`,
            color: PALETTE.text,
          }],
        },
      },
    },
    plugins: [verticalLinePlugin],
  });
}

function drawTerm(Chart) {
  const pts = state.term;
  const iv30 = interpolateAtmIv(pts, VOL_DEFAULTS.targetDays);

  if (state.termChart) state.termChart.destroy();
  state.termChart = new Chart(els.termCanvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [{
        label: 'ATM implied volatility',
        data: pts.map((p) => ({ x: p.dte, y: p.atmIv * 100 })),
        borderColor: PALETTE.text,
        backgroundColor: PALETTE.text,
        // The 1-day point is flagged red: it is retained, but expiring
        // volatility is the least trustworthy reading on the curve.
        pointBackgroundColor: pts.map((p) => (p.dte <= 1 ? PALETTE.bearish : PALETTE.text)),
        pointBorderColor: pts.map((p) => (p.dte <= 1 ? PALETTE.bearish : PALETTE.text)),
        borderWidth: 1.5,
        pointRadius: 3,
        tension: 0.2,
      }],
    },
    options: {
      responsive: true,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        // Logarithmic in DTE. Chains list expiries out to three years, so a
        // linear axis spends 90% of its width on LEAPS nobody is reading and
        // crushes the entire front of the curve — where the term structure
        // actually says something — into the left edge. Log spacing is the
        // conventional way to plot a term structure for exactly this reason.
        x: {
          type: 'logarithmic',
          min: 1,
          title: { display: true, color: PALETTE.muted, text: 'Days to expiration (log scale)' },
          ticks: {
            color: PALETTE.muted,
            autoSkip: false,
            callback: (v) => (TERM_TICKS.includes(Number(v)) ? `${Number(v)}d` : ''),
          },
          afterBuildTicks: (axis) => {
            const max = axis.max;
            axis.ticks = TERM_TICKS.filter((d) => d <= max * 1.05).map((value) => ({ value }));
          },
          grid: { color: PALETTE.grid },
        },
        y: {
          title: { display: true, color: PALETTE.muted, text: 'ATM implied volatility' },
          ticks: { color: PALETTE.muted, callback: (v) => `${Number(v).toFixed(0)}%` },
          grid: { color: PALETTE.grid },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `${Number(items[0].parsed.x).toFixed(0)} days`,
            label: (i) => `ATM ${Number(i.parsed.y).toFixed(2)}%`,
          },
        },
        vlines: {
          lines: iv30
            ? [{ x: VOL_DEFAULTS.targetDays, label: `30d ${pct(iv30.iv)}`, color: PALETTE.muted }]
            : [],
        },
      },
    },
    plugins: [verticalLinePlugin],
  });
}

// ── 3D surface ──────────────────────────────────────────────────────────────
// Strictly additive. three is dynamically imported inside a try/catch: a
// missing importmap, a CDN outage, or a
// machine with no WebGL2 context all land in the catch, the section hides
// itself, and the 2D charts carry on untouched.

let surface = null;
let surfaceGridData = null;   // the DENSE lattice handed to the renderer
let surfaceAudit = null;      // the listed lattice, for the measured fill caption
let surfaceColor = null;
let surfaceFailed = false;
let surfaceObserver = null;
let surfaceOnScreen = false;

const reducedMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

function hideSurface(why) {
  surfaceFailed = true;
  if (els.surfaceSection) els.surfaceSection.hidden = true;
  if (window.console) console.debug('[vol] 3D surface unavailable:', why);
}

function renderSurfaceMeta() {
  const a = surfaceAudit, c = surfaceColor;
  if (!a || !c) {
    els.surfaceLegend.hidden = true;
    els.surfaceNote.textContent = '';
    return;
  }
  els.surfaceLegend.hidden = false;

  // The ramp saturates outside the clamped domain, so say so rather than
  // printing a number the colour no longer distinguishes.
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const trueRange = `true range ${pct(c.ivMin)}–${pct(c.ivMax)}`;
  els.legendLo.textContent = c.clampedLo ? `≤${pct(c.lo)}` : pct(c.ivMin);
  els.legendHi.textContent = c.clampedHi ? `≥${pct(c.hi)}` : pct(c.ivMax);
  els.legendLo.title = trueRange;
  els.legendHi.title = trueRange;
  renderLegendTicks(c);

  const quotedPct = Math.round((100 * a.quoted) / a.cells);
  const coveredPct = Math.round((100 * a.covered) / a.cells);
  const sviCount = state.smiles.filter((s) => s.svi && s.svi.ok).length;
  const sviNote = state.smiles.length
    ? (sviCount
      ? `SVI smile fit on ${sviCount}/${state.smiles.length} expirations (arbitrage-checked — see the raw quotes ` +
        'plotted against each fit in the smile chart below); the rest use the plain linear interpolation between ' +
        'quoted strikes (too few points, or the fit failed the no-arbitrage check).'
      : 'No expiration cleared the SVI fit this load — every column uses the plain linear interpolation between ' +
        'quoted strikes.')
    : '';
  els.surfaceNote.textContent =
    `${a.rows.length} listed expirations × ${a.moneyness.length} moneyness columns; ` +
    `${quotedPct}% of the lattice carries a quote, ${coveredPct}% after filling gaps in TIME ONLY ` +
    '(linear in total variance σ²T between the nearest quoted expirations above and below, never ' +
    'past either end). Wings are never extrapolated — a ragged edge is a strike the board does not ' +
    'list. Height shows implied volatility on the full range; colour is clamped to the 2nd–98th ' +
    'percentile so the body of the surface keeps usable contrast, and anything beyond it reads its ' +
    `true value on hover. Time runs on a log scale. ${sviNote}`;
}

// Intermediate tick marks + labels along the legend bar, positioned by
// linear interpolation between the clamped colour domain's lo/hi — the same
// values the endpoint labels already use, so the two can never disagree.
function renderLegendTicks(c) {
  if (!els.legendTicks) return;
  els.legendTicks.innerHTML = '';
  if (!(c.hi > c.lo)) return;
  const narrow = els.surfaceWrap && els.surfaceWrap.clientWidth < 420;
  const ticks = niceTicks(c.lo, c.hi, narrow ? 3 : 4).filter((t) => t > c.lo + 1e-9 && t < c.hi - 1e-9);
  for (const t of ticks) {
    const left = ((t - c.lo) / (c.hi - c.lo)) * 100;
    const mark = document.createElement('span');
    mark.className = 'tool-surface-legend-tick';
    mark.style.left = `${left}%`;
    const label = document.createElement('span');
    label.className = 'tool-surface-legend-tick-label';
    label.style.left = `${left}%`;
    label.textContent = `${(t * 100).toFixed(0)}%`;
    els.legendTicks.appendChild(mark);
    els.legendTicks.appendChild(label);
  }
}

// Highlights the point on the 2D smile chart nearest the 3D surface's
// current hover, so the two views read as one instrument rather than two.
// Only the 3D -> 2D direction; see the surface note's own header comment in
// vol-surface.js for why the reverse direction is out of scope for now.
function updateCrosshair(hit) {
  const chart = state.smileChart;
  if (!chart) return;

  if (!hit || !state.selected.has(hit.date)) {
    if (crosshairKey !== null) {
      chart.setActiveElements([]);
      chart.tooltip.setActiveElements([], { x: 0, y: 0 });
      chart.update();
      crosshairKey = null;
    }
    return;
  }

  const dsIndex = smileDatasetIndex.get(hit.date);
  if (dsIndex == null) return;
  const points = chart.data.datasets[dsIndex].data;
  if (!points || !points.length) return;

  const byMoneyness = state.xAxis === 'moneyness';
  const targetX = byMoneyness ? hit.moneyness * 100 : state.spot * (1 + hit.moneyness);
  let idx = 0, best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i].x - targetX);
    if (d < best) { best = d; idx = i; }
  }

  const key = `${dsIndex}:${idx}`;
  if (key === crosshairKey) return;
  crosshairKey = key;

  const meta = chart.getDatasetMeta(dsIndex);
  const el = meta && meta.data && meta.data[idx];
  chart.setActiveElements([{ datasetIndex: dsIndex, index: idx }]);
  chart.tooltip.setActiveElements([{ datasetIndex: dsIndex, index: idx }], { x: el ? el.x : 0, y: el ? el.y : 0 });
  chart.update();
}

function onSurfaceHover(hit) {
  updateCrosshair(hit);
  if (!hit) { els.surfaceTip.hidden = true; return; }
  const wrap = els.surfaceWrap.getBoundingClientRect();
  els.surfaceTip.innerHTML =
    `<b>${(hit.iv * 100).toFixed(2)}%</b> implied vol<br>` +
    `${(hit.moneyness * 100).toFixed(1)}% moneyness<br>` +
    `${esc(hit.date)} (${hit.dte}d)`;
  els.surfaceTip.hidden = false;
  // Flip the tip to the other side of the cursor near the right/bottom edges so
  // it never runs outside the canvas.
  const tw = els.surfaceTip.offsetWidth, th = els.surfaceTip.offsetHeight;
  let x = hit.clientX - wrap.left + 14;
  let y = hit.clientY - wrap.top + 14;
  if (x + tw > wrap.width - 4) x = hit.clientX - wrap.left - tw - 14;
  if (y + th > wrap.height - 4) y = hit.clientY - wrap.top - th - 14;
  els.surfaceTip.style.left = `${Math.max(4, x)}px`;
  els.surfaceTip.style.top = `${Math.max(4, y)}px`;
}

async function ensureSurface() {
  if (surface || surfaceFailed || !els.surfaceCanvas) return;
  try {
    const mod = await import('./vol-surface.js');
    if (surfaceFailed) return;
    surface = mod.createSurface(els.surfaceCanvas, { maxDpr: 2, onHover: onSurfaceHover });
    surface.setActive(surfaceOnScreen);
    surface.resize();
    if (surfaceGridData) {
      surface.setGrid(surfaceGridData, { color: surfaceColor });
    }
    // A slow idle spin makes it obvious the thing is three-dimensional and
    // invites the drag. It stops for good on first interaction, and never
    // starts at all under reduced motion.
    if (!reducedMotionMQ.matches) {
      surface.setAutoRotate(true);
      els.surfaceSpin.classList.add('on');
    }
  } catch (err) {
    hideSurface(err && err.message);
  }
}

function updateSurface(opts = {}) {
  if (surfaceFailed || !els.surfaceSection) return;
  const { keepRotation = false } = opts;

  /* maxRows 512 rather than the 22 default: that cap existed only to bound mesh
     cost, and the mesh row count is now set by densifyGrid instead. Feeding
     every listed expiry means the interpolation bridges true adjacent weeklies
     rather than whatever survived thinning, which is strictly better. */
  const listed = surfaceGrid(state.smiles, {
    maxRows: 512,
    ivReader: (s, m) => ivAtMoneynessSmoothed(s, m, s.svi),
  });
  surfaceAudit = listed ? fillGridInTime(listed) : null;
  surfaceGridData = listed ? densifyGrid(listed) : null;
  surfaceColor = surfaceGridData ? ivColorDomain(surfaceGridData) : null;

  if (!surfaceGridData) {
    // A single expiry is a curve, not a surface — no reason to show an empty box.
    els.surfaceSection.hidden = true;
    return;
  }
  els.surfaceSection.hidden = false;
  renderSurfaceMeta();
  if (surface) {
    surface.setGrid(surfaceGridData, { color: surfaceColor, keepRotation });
  } else if (surfaceOnScreen) ensureSurface();
}

function initSurface() {
  if (!els.surfaceCanvas) return;

  // WebGL2 or nothing — three dropped WebGL1, and probing here avoids fetching
  // ~600KB of library on a machine that could never render it.
  try {
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl2')) { hideSurface('no WebGL2 context'); return; }
  } catch (err) {
    hideSurface('WebGL probe threw'); return;
  }

  // Don't pay for three until the section is actually approached.
  if (typeof IntersectionObserver === 'function') {
    surfaceObserver = new IntersectionObserver((entries) => {
      surfaceOnScreen = entries[0].isIntersecting;
      if (surfaceOnScreen && surfaceGridData) ensureSurface();
      // Stop the loop outright while the surface is scrolled away — most of a
      // reading session has it off screen, which is where the saving is.
      if (surface) {
        surface.setActive(surfaceOnScreen);
        if (!surfaceOnScreen) {
          surface.setAutoRotate(false);
          els.surfaceSpin.classList.remove('on');
        }
      }
    }, { rootMargin: '200px' });
    surfaceObserver.observe(els.surfaceSection);
  } else {
    surfaceOnScreen = true;
  }

  document.addEventListener('visibilitychange', () => {
    if (surface) surface.setActive(surfaceOnScreen && !document.hidden);
  });

  let rzTimer = 0;
  const onResize = () => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => { if (surface) surface.resize(); }, 120);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe(els.surfaceWrap);
  else window.addEventListener('resize', onResize);

  // Without preventDefault three can never restore and the canvas stays black.
  els.surfaceCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (surface) { surface.dispose(); surface = null; }
  }, false);

  els.surfaceSpin.addEventListener('click', () => {
    if (!surface) return;
    const on = !els.surfaceSpin.classList.contains('on');
    els.surfaceSpin.classList.toggle('on', on);
    surface.setAutoRotate(on);
  });
  els.surfaceReset.addEventListener('click', () => {
    if (!surface) return;
    els.surfaceSpin.classList.remove('on');
    surface.setAutoRotate(false);
    surface.resetView();
  });

  // OrbitControls turns auto-rotate off itself on first drag; keep the chip in
  // sync so the button never lies about the state.
  els.surfaceCanvas.addEventListener('pointerdown', () => {
    els.surfaceSpin.classList.remove('on');
  });

  if (window.matchMedia('(pointer: coarse)').matches) {
    els.surfaceHint.textContent = 'Two fingers to orbit, pinch to zoom';
  }
}

// ── Init ────────────────────────────────────────────────────────────────────
function init() {
  els.presets = qs('#preset-btns');
  els.input = qs('#symbol-input');
  els.datalist = qs('#vol-symbol-list');
  els.loadBtn = qs('#load-btn');
  els.status = qs('#status');
  els.results = qs('#results');
  els.stats = qs('#stats');
  els.chips = qs('#expiry-chips');
  els.xToggle = qs('#xaxis-toggle');
  els.summary = qs('#selection-summary');
  els.smileCanvas = qs('#smile-chart');
  els.termCanvas = qs('#term-chart');
  els.updated = qs('#updated');
  els.surfaceSection = qs('#surface-section');
  els.surfaceWrap = qs('#surface-wrap');
  els.surfaceCanvas = qs('#surface-canvas');
  els.surfaceTip = qs('#surface-tip');
  els.surfaceLegend = qs('#surface-legend');
  els.legendLo = qs('#legend-lo');
  els.legendHi = qs('#legend-hi');
  els.legendTicks = qs('#legend-ticks');
  els.surfaceNote = qs('#surface-note');
  els.surfaceHint = qs('#surface-hint');
  els.surfaceSpin = qs('#surface-spin');
  els.surfaceReset = qs('#surface-reset');

  initSurface();

  els.loadBtn.addEventListener('click', () => load(els.input.value));
  els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(els.input.value); });
  window.addEventListener('hashchange', () => {
    const sym = (location.hash || '').replace('#', '').toUpperCase();
    if (sym && sym !== state.symbol) load(sym);
  });

  buildPresets().finally(() => {
    load((location.hash || '').replace('#', '').toUpperCase() || 'SPY');
  });

  initFreshnessWatch();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
