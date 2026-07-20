// common.js — browser-only helpers shared by the tool pages:
// typed fetch with timeout, a status/loading/error line, and formatters.

export class FetchError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;     // 'timeout' | 'network' | 'http'
    this.status = status;
  }
}

export async function fetchJSON(url, { timeoutMs = 30000, headers } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, headers });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new FetchError('timeout', `Request timed out (${url})`);
    // A CORS block or DNS/connection failure surfaces as a TypeError.
    throw new FetchError('network', `Network error (${url})`);
  }
  clearTimeout(timer);
  if (!res.ok) throw new FetchError('http', `HTTP ${res.status} (${url})`, res.status);
  return res.json();
}

// ── Status line ─────────────────────────────────────────────────────────────
// el: the .tool-status element. state: 'idle' | 'loading' | 'error'.
let _elapsedTimer = null;

export function setStatus(el, state, html) {
  if (!el) return;
  clearInterval(_elapsedTimer);
  _elapsedTimer = null;
  el.classList.remove('is-loading', 'is-error');
  if (state === 'idle') { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  if (state === 'loading') el.classList.add('is-loading');
  if (state === 'error') el.classList.add('is-error');
  el.innerHTML = html;
}

// Loading line with a live elapsed-seconds counter.
export function setLoading(el, label) {
  if (!el) return;
  const start = Date.now();
  const render = () => setStatus(el, 'loading', `${label} <span style="opacity:.6">${((Date.now() - start) / 1000).toFixed(0)}s</span>`);
  render();
  clearInterval(_elapsedTimer);
  _elapsedTimer = setInterval(render, 1000);
}

// Error line with a Retry button wired to onRetry.
export function setError(el, message, onRetry) {
  setStatus(el, 'error', message);
  if (onRetry && el) {
    const btn = document.createElement('button');
    btn.className = 'tool-retry';
    btn.textContent = 'Retry';
    btn.addEventListener('click', onRetry);
    el.appendChild(btn);
  }
}

// ── Formatters ──────────────────────────────────────────────────────────────
export function fmtNum(n, dp = 2) {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—';
}

export function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
}

// Human dollar magnitude with sign, e.g. 1.82e9 -> "+$1.82B".
export function fmtSignedMoney(n) {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '+';
  const abs = Math.abs(n);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [scale, suffix] of units) {
    if (abs >= scale) return `${sign}$${(abs / scale).toFixed(2)}${suffix}`;
  }
  return `${sign}$${abs.toFixed(0)}`;
}

export function fmtStrike(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
}

// "Jul 17, 2026, 3:35 PM ET"-ish local rendering of an ISO/CBOE timestamp.
export function fmtTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function qs(sel, root = document) { return root.querySelector(sel); }
