# Elysium Website — Working Notes

## Environment Prerequisites
- Node 22 (matches `actions/setup-node@v4` in `.github/workflows/*.yml`).
- Run `npm install` once — installs `puppeteer` (drives the markdown→PDF pipeline in `build.js`), `marked`, `gray-matter`, `node-fetch`.
- `gh` CLI — not used by any script or workflow in this repo today, but required if a task ends with opening a PR (`gh pr create`). Check it's installed before promising an end-to-end PR workflow; a past session dead-ended here.
- `npm test` runs `scripts/preflight.mjs` first (tooling checks + duplicate-CSS scan, both fatal) followed by an endpoint health report (informational only) and the `js/tools/test/*.test.js` suite.

## Visual Verification
After any CSS/HTML/animation change, take a full-viewport browser screenshot (desktop AND mobile widths) before reporting done. Never report a UI change complete based on code alone — a past session shipped a clipped screenshot that had to be redone at full viewport.

## Writing Style
No spaced em-dashes in any site copy. Match the existing voice on the page. Never edit section headers unless explicitly asked.

## Animation & Canvas Rules
- Guard every `requestAnimationFrame` loop against duplicate starts — store the rAF id and cancel it before starting a new loop. (A duplicate rAF loop previously made the IV surface's rotation speed jump on button press.)
- Scale canvas drawing by `window.devicePixelRatio`, or particle/line work blurs on hi-DPI screens.
- Use CSS transforms/opacity for transitions, never `margin`.
- Flex children using `flex-basis: 50%` next to a `gap` overflow their row and silently stack on mobile — use `calc(50% - <half-gap>)` instead.

## Before Refactoring UI
Run `npm test` (or `node scripts/preflight.mjs` directly) before adding new CSS rules — it flags any selector already defined in the same scope (top-level, or the same `@media` block) across `css/style.css` and `css/cursor.css`. This is the automated version of the check that would have caught the duplicate `.page-hero` rule collision before it shipped.

## Data Fetching
Prefer the prefetch pipeline over live client-side lookups for market/macro data. The `npm run data:*` scripts (`build-market-data.mjs`, `build-fred.mjs`, `build-congress.mjs`, `build-insiders.mjs`, `build-tickers.js`) hit CBOE/FRED/House Clerk/SEC directly server-side and commit JSON into `assets/data/`, scheduled via `.github/workflows/daily-data.yml` and `market-data.yml` — extend this pattern for new data sources rather than fetching live from the browser.

Public CORS proxy pools are unreliable — don't build new features that depend on one being up. The fallback chain in `js/tools/cboe.js` (`cors-get-proxy.sirjosh.workers.dev`, `api.allorigins.win`, `api.codetabs.com`, `r.jina.ai`) exists only as a best-effort last resort for GEX symbols not in the prefetched set, and two prior entries (`corsproxy.io`, `thingproxy`) already went dead and were removed. `npm test` reports current proxy/endpoint liveness — check it before relying on any of them.

## Scope Confirmation
When a request is ambiguous about which element it refers to, ask one clarifying question before reading files. Do not infer scope from an IDE selection — a past session chased h1 scaling from an editor selection when the user meant the canvas particles.

## Known Hazards
Recurring bug classes that have each cost a full debugging cycle on this repo:

- **marked.js parses bare `~text~` as GFM strikethrough** (`<del>` tags), producing stray tags in generated research HTML/PDF output. Fix: disable the `del` tokenizer, e.g. `marked.use({ tokenizer: { del() { return false; } } })`, or escape tildes in source markdown.
- **Duplicate `requestAnimationFrame` loops** — re-binding an animation handler without cancelling the previous frame id causes visible speed jumps (hit the IV surface). Always store and cancel the previous rAF id before starting a new loop.
- **Canvas without `devicePixelRatio` scaling** blurs on hi-DPI screens (hit the particle system).
- **`flex-basis: 50%` + `gap`** overflows the row and silently stacks columns on mobile instead of erroring — use `calc()` to account for the gap.
- **Duplicate CSS selectors at the same scope** (e.g. the `.page-hero` collision) silently override earlier rules instead of erroring. Run `npm test` / `scripts/preflight.mjs` before adding new rules to a shared stylesheet — it now checks this automatically.
- **Dead public CORS proxies** (`corsproxy.io`, `thingproxy`) were shipped as part of a "working" feature and only failed at runtime. Don't add a new proxy to `js/tools/cboe.js` without first confirming with `scripts/preflight.mjs` that it's actually reachable, and prefer extending the server-side prefetch pipeline instead (see Data Fetching above).
