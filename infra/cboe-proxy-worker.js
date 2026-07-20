// cboe-proxy-worker.js — Cloudflare Worker that relays cdn.cboe.com's delayed
// quotes API with a CORS header, so the GEX tool's browser-side "live lookup"
// (js/tools/cboe.js) can read it directly instead of depending solely on
// unauthenticated public CORS proxies. See infra/README.md for deploy steps.
//
// Request shape:  GET https://<your-worker>.workers.dev/?url=<cdn.cboe.com/...>
// Only cdn.cboe.com/api/global/delayed_quotes/ paths are allowed through.

const ALLOWED_PREFIX = 'https://cdn.cboe.com/api/global/delayed_quotes/';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return corsResponse(new Response(null, { status: 204 }));

    const target = new URL(request.url).searchParams.get('url');
    if (!target || !target.startsWith(ALLOWED_PREFIX)) {
      return corsResponse(new Response('bad or missing url param', { status: 400 }));
    }

    const upstream = await fetch(target, {
      headers: { accept: 'application/json' },
      cf: { cacheTtl: 60, cacheEverything: true },
    });

    const res = new Response(upstream.body, upstream);
    return corsResponse(res);
  },
};

function corsResponse(res) {
  const out = new Response(res.body, res);
  out.headers.set('Access-Control-Allow-Origin', '*');
  out.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  out.headers.set('Access-Control-Allow-Headers', 'accept');
  return out;
}
