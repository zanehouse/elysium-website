# infra/

## cboe-proxy-worker.js

A tiny Cloudflare Worker that relays `cdn.cboe.com`'s delayed-quotes API with
a CORS header attached, so the GEX tool's browser-side "live lookup" (for
tickers not in the prefetched `assets/data/gex/` set) doesn't depend entirely
on flaky public CORS proxies. It only forwards requests whose `url` param
starts with `https://cdn.cboe.com/api/global/delayed_quotes/`, and caches
responses at the edge for 60s.

### Deploy (dashboard, no CLI)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Create Worker**.
2. Give it a name (e.g. `elysium-cboe-proxy`) and deploy the default template.
3. Click **Edit code**, delete the placeholder, and paste in the contents of `cboe-proxy-worker.js`.
4. **Deploy**. You'll get a URL like `https://elysium-cboe-proxy.<your-subdomain>.workers.dev`.

### Deploy (CLI, if you have `wrangler`)

```bash
npm install -g wrangler
wrangler login
wrangler deploy infra/cboe-proxy-worker.js --name elysium-cboe-proxy --compatibility-date 2026-07-17
```

### Wire it into the site

Open `js/tools/cboe.js` and set:

```js
const CUSTOM_PROXY_URL = 'https://elysium-cboe-proxy.<your-subdomain>.workers.dev/?url=';
```

(Keep the trailing `?url=` — the Worker expects the target CBOE URL as that
query param.) Once set, it's included in the proxy race in
`fetchChainViaProxy` alongside the public fallbacks, and — being first-party
and cached — should win most races.

Free Cloudflare Workers plan covers 100,000 requests/day, comfortably enough
for this tool's live-lookup traffic.
