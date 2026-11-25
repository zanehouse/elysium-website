// common.js — browser-only helpers shared by the tool pages:
// typed fetch with timeout, a status/loading/error line, and formatters.

export class FetchError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;     // 'timeout' | 'network' | 'http'
    this.status = status;
  }
}

export async function fetchJSON(url, { timeoutMs = 30000, headers, cache } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, headers, ...(cache ? { cache } : {}) });
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

// ── Data freshness ──────────────────────────────────────────────────────────
// GitHub Pages serves every file with a fixed `cache-control: max-age=600` and
// there is no way to override it, so a visitor could see JSON up to ten minutes
// staler than what the refresh job had already committed.
//
// The fix is to make the URL change whenever the data changes. manifest.json is
// small and is fetched `no-store`, so it's always current; its `generated`
// stamp then versions every other data URL. Unchanged data keeps caching
// normally — and since the build scripts now skip writing unchanged payloads,
// `generated` only moves when the numbers actually moved.

let _manifestPromise = null;

// Memoised for the page's lifetime. Rejections aren't cached, so a failed load
// doesn't poison later callers.
export function loadManifest() {
  if (!_manifestPromise) {
    _manifestPromise = fetchJSON('/assets/data/manifest.json', { timeoutMs: 8000, cache: 'no-store' });
    _manifestPromise.catch(() => { _manifestPromise = null; });
  }
  return _manifestPromise;
}

let _version;
async function dataVersion() {
  if (_version !== undefined) return _version;
  try {
    _version = (await loadManifest()).generated || '';
  } catch {
    _version = '';   // manifest unreachable: fall back to an unversioned URL
  }
  return _version;
}

// Fetch a file under assets/data/ with a cache-busting version token.
export async function fetchData(path, opts) {
  const v = await dataVersion();
  return fetchJSON(v ? `${path}?v=${encodeURIComponent(v)}` : path, opts);
}

// ── Live freshness ───────────────────────────────────────────────────────────
// Every tool page today loads its data once and never checks again — an open
// tab can sit on a stale snapshot indefinitely even after the prefetch
// pipeline has committed something newer. watchManifest() polls the same
// manifest.json the cache-busting above already reads, and calls back only
// when `generated` actually moves past what the caller already has, so a
// page can silently pick up new data without a manual reload.
//
// Pauses while the tab is hidden (Page Visibility API) rather than burning
// fetches nobody can see, and checks immediately on refocus instead of
// resuming whatever was left of a stale interval — the visible effect is
// that returning to a backgrounded tab feels current right away, not up to
// intervalMs stale.
export function watchManifest(sinceGenerated, onChange, opts = {}) {
  const {
    intervalMs = 60000,
    path = '/assets/data/manifest.json',
    fetchImpl = typeof fetch === 'function' ? fetch : undefined,
  } = opts;

  let current = sinceGenerated;
  let timer = null;
  let stopped = false;
  const hasDoc = typeof document !== 'undefined';

  async function check() {
    if (stopped || !fetchImpl) return;
    try {
      const res = await fetchImpl(path, { cache: 'no-store' });
      if (!res.ok) return;
      const manifest = await res.json();
      if (manifest && manifest.generated && manifest.generated !== current) {
        current = manifest.generated;
        onChange(manifest);
      }
    } catch {
      // Best-effort — the next tick tries again. A background poll failing
      // silently is the correct behaviour here; the caller keeps showing
      // whatever it already loaded and nothing about that is wrong yet.
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => { check().then(schedule); }, intervalMs);
  }

  function onVisibility() {
    if (!hasDoc) return;
    if (document.hidden) {
      if (timer) { clearTimeout(timer); timer = null; }
    } else {
      if (timer) { clearTimeout(timer); timer = null; }
      check().then(schedule);
    }
  }

  if (hasDoc) document.addEventListener('visibilitychange', onVisibility);
  if (!hasDoc || !document.hidden) schedule();

  return {
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (hasDoc) document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

// Live "Xs ago" / "Xm ago" ticker, the same Date.now()-diffing shape as
// setLoading()'s elapsed counter below but on its own interval handle, so it
// can run for the page's whole lifetime concurrently with (short-lived)
// loading-state timers without the two fighting over one handle. Rounds DOWN
// — "how long ago, at minimum" reads honestly; rounding to nearest would
// occasionally claim data is fresher than it is.
export function startFreshnessTicker(el, sinceMs) {
  if (!el) return () => {};
  const render = () => {
    const secs = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
    el.textContent = secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`;
  };
  render();
  const timer = setInterval(render, 1000);
  return () => clearInterval(timer);
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

// Divider between inline items in generated HTML (.sep in style.css); never a middle dot.
export const SEP = '<span class="sep"></span>';
