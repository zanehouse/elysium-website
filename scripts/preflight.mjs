#!/usr/bin/env node
// Preflight checks — catches the "environmental" class of bug that has
// repeatedly cost full debugging cycles on this repo: a dead CORS proxy
// pool shipped as a live feature, a missing CLI dead-ending a PR, or a
// duplicate CSS selector silently colliding with an earlier rule (see the
// `.page-hero` collision documented in CLAUDE.md's Known Hazards section).
//
// Runs automatically before the test suite (`npm test`). CLI and CSS
// checks are fatal (exit 1) — they're deterministic, not network-flaky.
// External endpoint checks are informational only (never fail the run) —
// this project already treats live third-party lookups as best-effort
// fallbacks, not requirements (see CLAUDE.md's Data Fetching section), so
// a transient outage here shouldn't block local dev or CI.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const OK = '[OK]  ';
const WARN = '[WARN]';
const FAIL = '[FAIL]';

let hasFailure = false;
const log = (tag, msg) => console.log(`${tag} ${msg}`);
const fail = (msg) => { hasFailure = true; log(FAIL, msg); };

// ─── 1. Required tooling ───────────────────────────────────────────────────

async function checkTooling() {
  console.log('\n== Tooling ==');

  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 22) {
    log(OK, `node ${process.version} (workflows are pinned to node 22 — see .github/workflows/*.yml)`);
  } else {
    fail(`node ${process.version} — this repo's GitHub Actions workflows run on node 22; local behavior may diverge`);
  }

  try {
    await access(path.join(ROOT, 'node_modules'), fsConstants.F_OK);
    log(OK, 'node_modules present (npm install has been run)');
  } catch {
    fail('node_modules missing — run `npm install` (needed for puppeteer/marked/gray-matter, used by the PDF pipeline in build.js)');
  }

  try {
    await execFileAsync('git', ['--version']);
    log(OK, 'git available');
  } catch {
    fail('git not found on PATH — required for everything in this workflow');
  }

  try {
    const { stdout } = await execFileAsync('gh', ['--version']);
    log(OK, `gh available (${stdout.split('\n')[0]})`);
  } catch {
    log(WARN, 'gh CLI not found — not used by any script in this repo today, but required if you plan to open a PR via `gh pr create` (a past session dead-ended here)');
  }
}

// ─── 2. External endpoint health (informational, 3s timeout) ──────────────

const ENDPOINTS = [
  { url: 'https://cdn.cboe.com/', note: 'CBOE option chains/quotes — hit directly by build-market-data.mjs (server-side, no CORS header needed)' },
  { url: 'https://fred.stlouisfed.org/', note: 'FRED macro series — build-fred.mjs' },
  { url: 'https://disclosures-clerk.house.gov/', note: 'House financial disclosures — build-congress.mjs' },
  { url: 'https://data.sec.gov/', note: 'SEC submissions API — build-insiders.mjs' },
  { url: 'https://www.sec.gov/', note: 'SEC EDGAR archives — build-insiders.mjs' },
  { url: 'https://cors-get-proxy.sirjosh.workers.dev/', note: 'browser-side CBOE proxy fallback #1 — js/tools/cboe.js' },
  { url: 'https://api.allorigins.win/', note: 'browser-side CBOE proxy fallback #2 — js/tools/cboe.js' },
  { url: 'https://api.codetabs.com/', note: 'browser-side CBOE proxy fallback #3 — js/tools/cboe.js' },
  { url: 'https://r.jina.ai/', note: 'browser-side CBOE proxy fallback #4 — js/tools/cboe.js' },
];

async function checkEndpoint({ url, note }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    log(res.ok ? OK : WARN, `${url} → HTTP ${res.status} (${note})`);
  } catch (err) {
    log(WARN, `${url} → unreachable (${err.name === 'AbortError' ? 'timeout after 3s' : err.message}) (${note})`);
  } finally {
    clearTimeout(timer);
  }
}

async function checkEndpoints() {
  console.log('\n== External endpoints (informational — never fails the build) ==');
  await Promise.all(ENDPOINTS.map(checkEndpoint));
}

// ─── 3. Duplicate CSS selector check ───────────────────────────────────────
// Heuristic scan: flags a selector defined more than once at the same
// nesting context (top-level, or inside the same @media block). This is
// the check that would have caught the duplicate `.page-hero` rule
// collision before it shipped. It's not a full CSS parser — deliberately
// simple, tuned to catch accidental re-declarations, not to be a linter.

function splitTopLevelCommas(selectorText) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of selectorText) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function extractProps(body) {
  const props = new Set();
  for (const decl of body.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    if (prop) props.add(prop);
  }
  return props;
}

// "A, B { shared props } A { specific } B { specific }" is a common,
// intentional idiom (a shared group declaration followed by per-selector
// specialization) — not a collision. So a selector that was EVER part of a
// multi-selector group is never flagged again in that context. What's
// flagged is a selector declared standalone more than once in the same
// scope: FAIL if the two blocks set an overlapping property (the second
// silently wins, which is exactly the `.page-hero` collision class of
// bug), WARN if they don't overlap (redundant but harmless).
function findDuplicateSelectors(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const seen = new Map(); // key -> { line, isGroup, props: Set }
  const dups = [];
  const contextStack = ['top'];
  let buf = '';
  let line = 1;
  let depth = 0;
  let bodyStart = -1;
  let currentSelectors = [];
  let currentCtx = 'top';

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '\n') line++;
    if (ch === '{') {
      const selectorText = buf.trim();
      buf = '';
      depth++;
      if (/^@media\b/i.test(selectorText)) {
        contextStack.push(selectorText.replace(/\s+/g, ' '));
      } else if (selectorText.startsWith('@')) {
        contextStack.push('__skip__'); // @keyframes/@font-face/@supports bodies aren't selector lists
      } else {
        currentCtx = contextStack[contextStack.length - 1];
        currentSelectors = splitTopLevelCommas(selectorText).map((s) => s.trim()).filter(Boolean);
        bodyStart = i + 1;
        contextStack.push('__rule__');
      }
      continue;
    }
    if (ch === '}') {
      const poppedCtx = contextStack.pop();
      if (poppedCtx === '__rule__' && currentCtx !== '__skip__' && depth <= 2) {
        const props = extractProps(stripped.slice(bodyStart, i));
        const isGroup = currentSelectors.length > 1;
        for (const sel of currentSelectors) {
          const key = `${currentCtx}::${sel}`;
          const prior = seen.get(key);
          if (prior) {
            if (!prior.isGroup && !isGroup) {
              const overlap = [...props].some((p) => prior.props.has(p));
              dups.push({ selector: sel, context: currentCtx, firstLine: prior.line, line, severity: overlap ? 'FAIL' : 'WARN' });
            }
            seen.set(key, { line: prior.line, isGroup: prior.isGroup || isGroup, props: new Set([...prior.props, ...props]) });
          } else {
            seen.set(key, { line, isGroup, props });
          }
        }
      }
      depth = Math.max(0, depth - 1);
      buf = '';
      continue;
    }
    buf += ch;
  }
  return dups;
}

async function checkCss() {
  console.log('\n== Duplicate CSS selectors ==');
  const cssFiles = ['css/style.css']; // cache/fonts/*.css is generated, not source
  let anyDup = false;
  for (const rel of cssFiles) {
    const abs = path.join(ROOT, rel);
    let content;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      log(WARN, `${rel} not found, skipping`);
      continue;
    }
    const dups = findDuplicateSelectors(content);
    for (const d of dups) {
      const scope = d.context === 'top' ? 'top-level' : d.context;
      if (d.severity === 'FAIL') {
        anyDup = true;
        fail(`${rel}:${d.line} — "${d.selector}" already defined at line ${d.firstLine} in the same scope (${scope}) with an overlapping property — the second declaration silently wins`);
      } else {
        log(WARN, `${rel}:${d.line} — "${d.selector}" redeclared from line ${d.firstLine} in the same scope (${scope}); no overlapping properties, but consider merging`);
      }
    }
  }
  if (!anyDup) log(OK, 'no colliding duplicate selectors found in css/style.css');
}

// ─── run ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Running preflight checks (see CLAUDE.md → Environment Prerequisites / Known Hazards)...');
  await checkTooling();
  await checkEndpoints();
  await checkCss();

  console.log();
  if (hasFailure) {
    console.error('Preflight FAILED — see [FAIL] lines above.');
    process.exit(1);
  }
  console.log('Preflight passed.');
}

main();
