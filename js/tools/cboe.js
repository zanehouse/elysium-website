// cboe.js — CBOE delayed-quote chain fetching + parsing.
// Pure parsers run in the browser AND Node; fetchChain runs in the Node
// prefetch pipeline (cdn.cboe.com sends no CORS header, so the browser can
// never read it directly — see build-market-data.mjs).

// Index products are exposed under an underscore-prefixed symbol on CBOE.
const INDEX_SYMBOLS = {
  SPX: '_SPX', VIX: '_VIX', VIX3M: '_VIX3M', VIX9D: '_VIX9D',
  RUT: '_RUT', NDX: '_NDX', XSP: '_XSP', DJX: '_DJX', OEX: '_OEX',
};

export function symbolToCboe(userInput) {
  const s = String(userInput || '').trim().toUpperCase().replace(/^_/, '');
  return INDEX_SYMBOLS[s] || s;
}

// Display symbol (strip the underscore) for UI/filenames.
export function displaySymbol(userInput) {
  return String(userInput || '').trim().toUpperCase().replace(/^_/, '');
}

const CBOE_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const CBOE_QUOTE_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes';

// Lightweight index/stock level (no option chain). VIX3M/VIX9D have no listed
// options, so the options endpoint 403s — this quote endpoint serves their level.
export async function fetchQuote(userInput, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const sym = symbolToCboe(userInput);
  const url = `${CBOE_QUOTE_BASE}/${sym}.json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'accept': 'application/json' } });
    if (!res.ok) throw new Error(`CBOE quote ${sym} HTTP ${res.status}`);
    const json = await res.json();
    const d = (json && json.data) || {};
    return Number(d.current_price ?? d.close ?? 0) || 0;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchChain(userInput, { fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
  const sym = symbolToCboe(userInput);
  const url = `${CBOE_BASE}/${sym}.json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'accept': 'application/json' } });
    if (!res.ok) throw new Error(`CBOE ${sym} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Optional first-party proxy (e.g. a Cloudflare Worker relaying cdn.cboe.com
// with a proper CORS header — see infra/cboe-proxy-worker.js). Empty by
// default — the site ships as a pure static GitHub Pages deploy with no
// backend of its own, so this is an opt-in escape hatch, not a requirement.
// If set, paste the workers.dev URL here (with a trailing `?url=`, matching
// the `build` shape below) and it joins the race as an extra entrant.
const CUSTOM_PROXY_URL = '';

// Public relays to race for a symbol NOT in the prefetched set (see
// build-market-data.mjs's GEX_SYMBOLS). cdn.cboe.com sends no CORS header at
// all, so an uncovered ticker has no reliable direct path — these are
// best-effort, unauthenticated, third-party services with independent,
// uncorrelated failure modes (downtime, rate limits, IP-range blocks by
// cdn.cboe.com itself). Racing several structurally different services at
// once is the mitigation, since any single one can and does go dark —
// verified against live traffic on 2026-07-17: corsproxy.io now paywalls
// (permanent, removed), thingproxy no longer resolves (removed), allorigins
// and codetabs were both mid-outage (kept — outages are often transient).
// `unwrap` is only needed when a relay wraps the body instead of passing it
// through untouched (Jina's Reader API returns the fetched page wrapped in
// its own envelope, with the real JSON as a string under data.content).
const PROXIES = [
  ...(CUSTOM_PROXY_URL ? [{ build: (url) => `${CUSTOM_PROXY_URL}${encodeURIComponent(url)}` }] : []),
  // Community-hosted Cloudflare Worker relay — fast, passes the CBOE
  // response through byte-for-byte.
  { build: (url) => `https://cors-get-proxy.sirjosh.workers.dev/?url=${encodeURIComponent(url)}` },
  { build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
  { build: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}` },
  // Jina AI's Reader API — slower on a huge chain (~20s for SPX) but a
  // structurally independent fallback that needs no signup.
  {
    build: (url) => `https://r.jina.ai/${url}`,
    unwrap: (json) => JSON.parse(json.data.content),
  },
];

// Best-effort live chain fetch through a public relay, for tickers that
// aren't in the prefetched assets/data/gex/ set. Races every relay at once
// and returns the first one that resolves with a usable body — since these
// are unauthenticated third-party services with independent, uncorrelated
// failure modes, racing them is far more reliable than trying them one at a
// time against a single timeout. timeoutMs is generous (25s default) so the
// slower-but-independent Jina fallback still has a fair shot on large chains
// when the faster relays are down; in the common case a fast relay wins the
// race in a second or two and the rest are simply discarded.
export async function fetchChainViaProxy(userInput, { timeoutMs = 25000 } = {}) {
  const sym = symbolToCboe(userInput);
  const target = `${CBOE_BASE}/${sym}.json`;

  const attempts = PROXIES.map(({ build, unwrap }) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(build(target), { signal: ctrl.signal, headers: { accept: 'application/json' } })
      .then((res) => {
        if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        const out = unwrap ? unwrap(json) : json;
        if (!out || !out.data) throw new Error('proxy returned no data');
        return out;
      })
      .finally(() => clearTimeout(timer));
  });

  return firstSuccessful(attempts);
}

// Promise.any polyfill-free equivalent: resolves with the first fulfilled
// promise, rejects only if every promise rejects (with the last error).
function firstSuccessful(promises) {
  return new Promise((resolve, reject) => {
    let remaining = promises.length;
    let lastErr;
    for (const p of promises) {
      p.then(resolve).catch((err) => {
        lastErr = err;
        remaining -= 1;
        if (remaining === 0) reject(lastErr || new Error('all proxies failed'));
      });
    }
  });
}

// OCC-style option symbol: ROOT + YYMMDD + C/P + strike*1000 (8 digits).
// e.g. "SPX260717C05900000" -> { root:'SPX', expiry:'2026-07-17', type:'C', strike:5900 }
const OCC_RE = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseOccSymbol(occ) {
  const m = OCC_RE.exec(String(occ || '').trim());
  if (!m) return null;
  const [, root, yy, mm, dd, type, strikeRaw] = m;
  const expiry = `20${yy}-${mm}-${dd}`;
  const strike = Number(strikeRaw) / 1000;
  return { root, expiry, type, strike };
}

// Normalize a raw CBOE payload to { spot, asof, contracts:[{expiry,type,strike,oi,gamma,volume}] }.
export function parseChain(json) {
  const data = (json && json.data) || {};
  const spot = Number(data.current_price ?? data.close ?? data.prev_day_close ?? 0) || 0;
  const asof = json && json.timestamp ? String(json.timestamp) : null;
  const rows = Array.isArray(data.options) ? data.options : [];
  const contracts = [];
  for (const o of rows) {
    const parsed = parseOccSymbol(o.option);
    if (!parsed) continue;
    const gamma = Number(o.gamma);
    const oi = Number(o.open_interest);
    if (!Number.isFinite(gamma) || !Number.isFinite(oi)) continue;
    contracts.push({
      expiry: parsed.expiry,
      type: parsed.type,
      strike: parsed.strike,
      oi,
      gamma,
      volume: Number(o.volume) || 0,
    });
  }
  return { spot, asof, contracts };
}
