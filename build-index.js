#!/usr/bin/env node
'use strict';

const matter = require('gray-matter');
const fs     = require('fs');
const path   = require('path');

const POSTS_DIR    = path.resolve(__dirname, 'posts');
const RESEARCH_OUT = path.resolve(__dirname, 'research', 'index.html');

// ─── Rating badge ─────────────────────────────────────────────────────────────
const RATING_CFG = {
  BULLISH: { cls: 'bullish', prefix: '▲' },
  NEUTRAL: { cls: 'neutral', prefix: '—' },
  BEARISH: { cls: 'bearish', prefix: '▼' },
};

function ratingBadge(rating) {
  const key = (rating || '').toUpperCase();
  const cfg = RATING_CFG[key];
  if (!cfg) return '';
  return `<span class="research-item-rating ${cfg.cls}">${cfg.prefix} ${key}</span>`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC avoids off-by-one across timezones
  return isNaN(d) ? dateStr : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// ─── Load & sort posts ────────────────────────────────────────────────────────
function loadPosts() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.warn('  ⚠  posts/ directory not found');
    return [];
  }

  return fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(filename => {
      const slug = path.basename(filename, '.md');
      const raw  = fs.readFileSync(path.join(POSTS_DIR, filename), 'utf-8');
      const { data: fm } = matter(raw);
      return { slug, fm };
    })
    .filter(p => p.fm.title)
    .sort((a, b) => {
      const da = a.fm.date ? new Date(a.fm.date + 'T12:00:00Z') : new Date(0);
      const db = b.fm.date ? new Date(b.fm.date + 'T12:00:00Z') : new Date(0);
      return db - da; // newest first by default
    });
}

// ─── List item HTML ───────────────────────────────────────────────────────────
function listItem({ slug, fm }) {
  const url    = `/output/${slug}.html`;
  const ticker = [fm.ticker, fm.exchange].filter(Boolean).join(' — ');

  return `
      <li class="research-item"
          data-date="${fm.date || ''}"
          data-ticker="${(fm.ticker || '').toUpperCase()}"
          data-rating="${(fm.rating || '').toUpperCase()}">
        <span class="research-item-date">
          ${fmtDate(fm.date)}${fm.rating ? '\n          ' + ratingBadge(fm.rating) : ''}
        </span>
        <div>
          <h2 class="research-item-title"><a href="${url}">${fm.title}</a></h2>
          ${ticker    ? `<p class="research-item-ticker">${ticker}</p>`           : ''}
          ${fm.subtitle ? `<p class="research-item-subtitle">${fm.subtitle}</p>` : ''}
          ${fm.summary  ? `<p class="research-item-summary">${fm.summary}</p>`   : ''}
        </div>
        <a class="research-item-cta" href="${url}">Read →</a>
      </li>`;
}

// ─── Full page ────────────────────────────────────────────────────────────────
function buildPage(posts) {
  const count    = posts.length;
  const listHTML = posts.map(listItem).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Research Archive &ndash; Elysium</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/style.css" />
  <link rel="shortcut icon" href="/assets/favicon.ico" type="image/x-icon">
</head>
<body>

  <header>
    <div class="nav-inner">
      <a class="nav-logo" href="/home/"><img class="nav-logo" src="/assets/logo.png" alt="Elysium Capital"></a>
      <button class="nav-toggle" aria-label="Toggle navigation" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
      <nav>
        <a href="/home/">Home</a>
        <a href="/research/" class="active">Research</a>
        <a href="/framework/">Framework</a>
        <a href="/links/">Links</a>
      </nav>
    </div>
  </header>

  <main>
    <noscript>
      <style>.reveal{opacity:1!important;transform:none!important;transition:none!important}</style>
    </noscript>

    <div class="page-hero reveal">
      <h1>Research Archive</h1>
      <p>Independent macro and equity analysis — regime cycles, cross-asset dynamics, and fundamental research.</p>
    </div>

    <div class="sort-bar reveal">
      <span class="sort-label">Sort by</span>
      <button class="sort-btn active" data-sort="date-desc">Date ↓</button>
      <button class="sort-btn"        data-sort="date-asc">Date ↑</button>
      <button class="sort-btn"        data-sort="ticker">Ticker</button>
      <button class="sort-btn"        data-sort="rating">Rating</button>
      <span class="sort-count">${count} report${count !== 1 ? 's' : ''}</span>
    </div>

    <ul class="research-list reveal">
      ${listHTML}
    </ul>

  </main>

  <footer>
    <div class="footer-inner">
      <span class="footer-copy">&copy; <script>document.write(new Date().getFullYear())</script><noscript>2026</noscript> Elysium Capital. All rights reserved.</span>
      <span class="footer-copy">Independent Macro Research</span>
    </div>
  </footer>

  <script src="/js/script.js"></script>
  <script src="/js/load.js" defer></script>

</body>
</html>`;
}

// ─── Run ──────────────────────────────────────────────────────────────────────
const posts = loadPosts();
console.log(`  Found ${posts.length} post(s) in posts/`);
posts.forEach(p => console.log(`    · ${p.slug} (${p.fm.date || 'no date'})`));

fs.writeFileSync(RESEARCH_OUT, buildPage(posts), 'utf-8');
console.log(`  → research/index.html updated`);
