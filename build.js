#!/usr/bin/env node
'use strict';

const puppeteer  = require('puppeteer');
const matter     = require('gray-matter');
const { marked } = require('marked');
const fetch      = require('node-fetch');
const fs         = require('fs');
const path       = require('path');

// ─── Paths ────────────────────────────────────────────────────────────────────
const ROOT       = path.resolve(__dirname);
const CACHE_DIR  = path.join(ROOT, 'cache', 'fonts');
const OUTPUT_DIR = path.join(ROOT, 'output');
const LOGO_PATH  = path.join(ROOT, 'assets', 'logo.png');
const HN_PATH    = path.join(ROOT, 'assets', 'fonts', 'HelveticaNeue-Roman.otf');
const TPL_PATH   = path.join(ROOT, 'template.html');

// ─── Setup ────────────────────────────────────────────────────────────────────
[CACHE_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

marked.use({ gfm: true, breaks: false });

// ─── Font fetching / caching ──────────────────────────────────────────────────
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

async function fetchCached(url, cacheKey) {
  const cachePath = path.join(CACHE_DIR, cacheKey);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = await res.buffer();
  fs.writeFileSync(cachePath, buf);
  return buf;
}

async function buildFontCSS() {
  // Google-hosted fonts: Inter (header title), JetBrains Mono (header labels),
  // Libre Baskerville (body pull-quotes / serif).
  const specs = [
    {
      url: 'https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;1,400&display=swap',
      key: 'inter.css',
    },
    {
      url: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap',
      key: 'jetbrainsmono.css',
    },
    {
      url: 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap',
      key: 'librebaskerville.css',
    },
  ];

  let combined = '';

  for (const spec of specs) {
    const cssBuf = await fetchCached(spec.url, spec.key);
    let css = cssBuf.toString('utf-8');

    const fontUrls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)]
      .map(m => m[1])
      .filter((v, i, a) => a.indexOf(v) === i);

    for (const fontUrl of fontUrls) {
      const filename = fontUrl.replace(/[^a-z0-9.]/gi, '_');
      const buf = await fetchCached(fontUrl, filename);
      css = css.split(fontUrl).join(`data:font/woff2;base64,${buf.toString('base64')}`);
    }

    combined += css + '\n';
  }

  // Local Helvetica Neue — embed as base64 @font-face (body sans-serif)
  if (fs.existsSync(HN_PATH)) {
    const b64 = fs.readFileSync(HN_PATH).toString('base64');
    combined += `
@font-face {
  font-family: 'Helvetica Neue';
  src: url(data:font/otf;base64,${b64}) format('opentype');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
`;
  }

  return combined;
}

// ─── Asset helpers ────────────────────────────────────────────────────────────
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
};

function fileToDataURI(absPath) {
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mime = EXT_MIME[ext] || 'image/png';
  return `data:${mime};base64,${fs.readFileSync(absPath).toString('base64')}`;
}

function embedImages(html, mdDir) {
  return html.replace(
    /src="((?:\.\/|\.\.\/)[^"]+\.(?:png|jpg|jpeg|gif|svg|webp))"/gi,
    (match, src) => {
      const abs = path.resolve(mdDir, src);
      if (fs.existsSync(abs)) return `src="${fileToDataURI(abs)}"`;
      console.warn(`  ⚠  Image not found: ${abs}`);
      return match;
    }
  );
}

// ─── HTML post-processing ─────────────────────────────────────────────────────

// Blockquotes → .pull-quote (matching post-1.html's class)
function processBlockquotes(html) {
  return html.replace(/<blockquote>/g, '<blockquote class="pull-quote">');
}

// ─── Header builders ──────────────────────────────────────────────────────────
const BADGES = {
  BULLISH: { bg: '#166534', color: '#4ade80', prefix: '▲' },
  NEUTRAL: { bg: '#713f12', color: '#facc15', prefix: '—' },
  BEARISH: { bg: '#7f1d1d', color: '#f87171', prefix: '▼' },
};

function ratingBadge(rating) {
  const key = (rating || '').toUpperCase();
  const b = BADGES[key] || BADGES.NEUTRAL;
  return (
    `<span class="rating-badge" style="background:${b.bg};color:${b.color}">` +
    `${b.prefix} ${key}</span>`
  );
}

function metaStrip(fm) {
  const parts = [];
  if (fm.price)      parts.push(fm.price);
  if (fm.price_date) parts.push(fm.price_date);
  if (fm.week52)     parts.push(`52-Wk Range: ${fm.week52}`);
  if (fm.mkt_cap)    parts.push(`Mkt Cap: ${fm.mkt_cap}`);
  if (fm.base_pt)    parts.push(`Base PT: ${fm.base_pt}`);
  if (fm.horizon)    parts.push(`Horizon: ${fm.horizon}`);
  return parts.join(' &nbsp;·&nbsp; ');
}

function keyFactsHTML(keyfacts) {
  if (!Array.isArray(keyfacts) || !keyfacts.length) return '';
  const rows = keyfacts
    .map(
      (kf, i) =>
        `<tr class="${i % 2 === 1 ? 'alt' : ''}">` +
        `<td class="kf-label">${kf.label}</td>` +
        `<td class="kf-value">${kf.value}</td>` +
        `</tr>`
    )
    .join('');
  return (
    `<div class="keyfacts-card">` +
    `<table class="keyfacts-table"><tbody>${rows}</tbody></table>` +
    `</div>`
  );
}

// ─── Puppeteer footer ─────────────────────────────────────────────────────────
function footerTemplate(fm) {
  const year = fm.date
    ? new Date(fm.date).getFullYear()
    : new Date().getFullYear();
  const disclaimer = (fm.disclaimer || '').replace(/"/g, '&quot;');
  return `
    <div style="
      width: 100%;
      padding: 0 0.75in;
      box-sizing: border-box;
      font-size: 8px;
      color: #999;
      font-family: 'Courier New', monospace;
    ">
      <div style="
        border-top: 1px solid #d0d0d0;
        padding-top: 5px;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 24px;
      ">
        <span style="font-style:italic;flex:1;line-height:1.4">${disclaimer}</span>
        <span style="white-space:nowrap">Elysium &middot; ${year}</span>
      </div>
    </div>
  `;
}

// ─── Main build ───────────────────────────────────────────────────────────────
async function build(mdFile) {
  const mdAbs = path.resolve(mdFile);
  const mdDir = path.dirname(mdAbs);
  const slug  = path.basename(mdAbs, '.md');

  console.log(`\nBuilding: ${mdFile}`);

  const raw = fs.readFileSync(mdAbs, 'utf-8');
  const { data: fm, content: mdBody } = matter(raw);

  // 1. Logo
  const logoSrc = fs.existsSync(LOGO_PATH) ? fileToDataURI(LOGO_PATH) : '';

  // 2. Fonts
  console.log('  Loading fonts…');
  const fontCSS = await buildFontCSS();

  // 3. Markdown → HTML
  let bodyHTML = marked.parse(mdBody);
  bodyHTML = embedImages(bodyHTML, mdDir);
  bodyHTML = processBlockquotes(bodyHTML);

  // 4. Assemble template
  let html = fs.readFileSync(TPL_PATH, 'utf-8');
  html = html
    .replace('{{FONT_CSS}}',      fontCSS)
    .replace('{{LOGO_SRC}}',      logoSrc)
    .replace('{{TITLE}}',         fm.title    || '')
    .replace('{{SUBTITLE}}',      fm.subtitle || '')
    .replace('{{RATING_BADGE}}',  fm.rating   ? ratingBadge(fm.rating) : '')
    .replace('{{META_STRIP}}',    metaStrip(fm))
    .replace('{{PUBLISH_DATE}}',  fm.date     || '')
    .replace('{{KEYFACTS_HTML}}', keyFactsHTML(fm.keyfacts))
    .replace('{{BODY_HTML}}',     bodyHTML);

  // 5. Save debug HTML
  const htmlOut = path.join(OUTPUT_DIR, `${slug}.html`);
  fs.writeFileSync(htmlOut, html, 'utf-8');
  console.log(`  HTML → ${htmlOut}`);

  // 6. Render PDF
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfOut = path.join(OUTPUT_DIR, `${slug}.pdf`);
    await page.pdf({
      path:                pdfOut,
      format:              'Letter',
      margin:              { top: '0.75in', right: '0.75in', bottom: '0.85in', left: '0.75in' },
      printBackground:     true,
      displayHeaderFooter: true,
      headerTemplate:      '<div></div>',
      footerTemplate:      footerTemplate(fm),
    });

    console.log(`  PDF  → ${pdfOut}`);
  } finally {
    await browser.close();
  }
}

// ─── CLI entry ────────────────────────────────────────────────────────────────
const mdFile = process.argv[2];
if (!mdFile) {
  console.error('Usage: node build.js posts/some-report.md');
  process.exit(1);
}

build(mdFile).catch(err => {
  console.error(err);
  process.exit(1);
});
