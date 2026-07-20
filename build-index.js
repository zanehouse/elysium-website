#!/usr/bin/env node
'use strict';

const fs     = require('fs');
const path   = require('path');
const report = require('./lib/report');

const ROOT          = path.resolve(__dirname);
const RESEARCH_DIR   = path.join(ROOT, 'research');
const RESEARCH_OUT   = path.join(RESEARCH_DIR, 'index.html');
const HOME_OUT        = path.join(ROOT, 'home', 'index.html');
const LOGO_SRC        = '/assets/logo.png';

// ─── Load posts as sorted archive items ──────────────────────────────────────
function buildItems() {
  return report.loadPosts().map(({ slug, fm, mdBody }) => ({
    slug,
    mdBody,
    url: `/research/${slug}.html`,
    date: fm.date || '',
    title: fm.title,
    subtitle: fm.subtitle || '',
    summary: fm.summary || '',
    ticker: [fm.ticker, fm.exchange].filter(Boolean).join(' — '),
    tickerSort: fm.ticker || '',
    rating: fm.rating || '',
    fm,
  }));
}

// ─── Archive list item (research/index.html) ─────────────────────────────────
function archiveListItem(item) {
  return `
      <li class="research-item"
          data-date="${item.date}"
          data-ticker="${item.tickerSort.toUpperCase()}"
          data-rating="${item.rating.toUpperCase()}">
        <span class="research-item-date">
          ${report.fmtDate(item.date)}${item.rating ? '\n          ' + report.ratingLabel(item.rating, 'research-item-rating') : ''}
        </span>
        <div>
          <h2 class="research-item-title"><a href="${item.url}">${item.title}</a></h2>
          ${item.ticker   ? `<p class="research-item-ticker">${item.ticker}</p>`     : ''}
          ${item.subtitle ? `<p class="research-item-subtitle">${item.subtitle}</p>` : ''}
          ${item.summary  ? `<p class="research-item-summary">${item.summary}</p>`   : ''}
        </div>
        <a class="research-item-cta" href="${item.url}">Read →</a>
      </li>`;
}

// ─── research/index.html ──────────────────────────────────────────────────────
function buildArchivePage(items) {
  const count    = items.length;
  const listHTML = items.map(archiveListItem).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Research Archive &ndash; Elysium</title>
${report.metaTags({ title: 'Elysium Research Archive', description: 'Independent equity research and macro frameworks. Company coverage, sector screening, and market structure, kept clear and data-backed.', urlPath: '/research/' })}
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
        <a href="/tools/">Tools</a>
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
      <p>Independent equity research — company coverage, sector screening, and process notes.</p>
    </div>

    <div class="sort-bar reveal">
      <span class="sort-label">Sort by</span>
      <button class="sort-btn active" data-sort="date-desc">Date ↓</button>
      <button class="sort-btn"        data-sort="date-asc">Date ↑</button>
      <button class="sort-btn"        data-sort="ticker">Ticker</button>
      <button class="sort-btn"        data-sort="rating">Rating</button>
      <input class="search-input" type="search" placeholder="Search" aria-label="Search research" />
      <span class="sort-count">${count} report${count !== 1 ? 's' : ''}</span>
    </div>

    <ul class="research-list reveal">
      ${listHTML}
    </ul>

  </main>

${report.siteFooter()}

  <script src="/js/script.js"></script>
  <script src="/js/load.js" defer></script>

</body>
</html>`;
}

// ─── research/[slug].html — clean web article page for equity reports ───────
function buildArticlePage(item) {
  const { fm, mdBody, slug } = item;
  const bodyHTML   = report.renderBodyForWeb(mdBody);
  const ratingHTML = fm.rating ? report.ratingLabel(fm.rating, 'rating-badge') : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${fm.title} &ndash; Elysium Research</title>
${report.metaTags({ title: `${fm.title}${fm.ticker ? ' (' + fm.ticker + ')' : ''} · Elysium Research`, description: fm.summary || fm.subtitle || 'Independent equity research from Elysium.', urlPath: `/research/${slug}.html`, type: 'article' })}
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
        <a href="/tools/">Tools</a>
        <a href="/links/">Links</a>
      </nav>
    </div>
  </header>

  <main>
    <noscript>
      <style>.reveal{opacity:1!important;transform:none!important;transition:none!important}</style>
    </noscript>

    <div class="report-header reveal">
      <div class="header-top">
        <div class="header-row1">
          <a href="/home/" class="header-logo-link">
            <div class="header-logo"><img src="${LOGO_SRC}" alt="Elysium" /></div>
          </a>
          <div class="header-label">${report.headerLabel(fm)}</div>
        </div>
        <div class="header-row2">
          <div class="header-title-block">
            <div class="header-title">${fm.title}</div>
            <div class="header-subtitle">${fm.subtitle || ''}</div>
          </div>
          ${ratingHTML}
        </div>
      </div>
      ${report.metaStripBlock(fm)}
      <div class="header-published">Published by Elysium &nbsp;·&nbsp; ${report.fmtDateLong(fm.date)}</div>
    </div>

    ${report.keyFactsHTML(fm.keyfacts)}

    <div class="article-body reveal">
      <a class="download-pdf-btn" href="/output/${slug}.pdf" download>Download PDF ↓</a>
      ${bodyHTML}
      <a class="back-link" href="/research/">← Back to Research Archive</a>
    </div>

  </main>

${report.siteFooter()}

  <script src="/js/script.js"></script>
  <script src="/js/load.js" defer></script>

</body>
</html>`;
}

// ─── home/index.html "Latest Research" section ───────────────────────────────
const HOME_FEED_COUNT = 3;

function homeCard(item) {
  return `
        <article class="card">
          <p class="card-date">${report.fmtDate(item.date)}</p>
          <h2 class="card-title">${item.title}</h2>
          <p class="card-summary">
            ${item.summary}
          </p>
          <a class="card-cta" href="${item.url}">Read ${item.tickerSort ? 'Report' : 'Note'} →</a>
        </article>`;
}

function updateHomeFeed(items) {
  if (!fs.existsSync(HOME_OUT)) {
    console.warn('  ⚠  home/index.html not found — skipping home feed update');
    return;
  }

  const html = fs.readFileSync(HOME_OUT, 'utf-8');
  const start = '<!-- LATEST-RESEARCH:START -->';
  const end   = '<!-- LATEST-RESEARCH:END -->';

  const startIdx = html.indexOf(start);
  const endIdx   = html.indexOf(end);
  if (startIdx === -1 || endIdx === -1) {
    console.warn('  ⚠  LATEST-RESEARCH markers not found in home/index.html — skipping');
    return;
  }

  const cardsHTML = items.slice(0, HOME_FEED_COUNT).map(homeCard).join('\n');
  const replacement = `${start}\n      <div class="cards">\n${cardsHTML}\n      </div>\n      ${end}`;

  const updated = html.slice(0, startIdx) + replacement + html.slice(endIdx + end.length);
  fs.writeFileSync(HOME_OUT, updated, 'utf-8');
  console.log('  → home/index.html Latest Research section updated');
}

// ─── Run ──────────────────────────────────────────────────────────────────────
const items = buildItems();
console.log(`  Found ${items.length} post(s) in posts/`);
items.forEach(i => console.log(`    · ${i.slug} (${i.date || 'no date'})`));

fs.writeFileSync(RESEARCH_OUT, buildArchivePage(items), 'utf-8');
console.log('  → research/index.html updated');

items.forEach(item => {
  const out = path.join(RESEARCH_DIR, `${item.slug}.html`);
  fs.writeFileSync(out, buildArticlePage(item), 'utf-8');
  console.log(`  → research/${item.slug}.html updated`);
});

updateHomeFeed(items);
