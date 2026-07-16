'use strict';

const matter = require('gray-matter');
const { marked } = require('marked');
const fs   = require('fs');
const path = require('path');

marked.use({ gfm: true, breaks: false });

const POSTS_DIR = path.resolve(__dirname, '..', 'posts');

// ─── Rating — plain text label, no pill/background ───────────────────────────
const RATING_CFG = {
  BULLISH: { cls: 'bullish', prefix: '▲' },
  NEUTRAL: { cls: 'neutral', prefix: '—' },
  BEARISH: { cls: 'bearish', prefix: '▼' },
};

function ratingLabel(rating, className) {
  const key = (rating || '').toUpperCase();
  const cfg = RATING_CFG[key];
  if (!cfg) return '';
  return `<span class="${className} ${cfg.cls}">${cfg.prefix} ${key}</span>`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC avoids off-by-one across timezones
  return isNaN(d) ? dateStr : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// Full "April 27, 2026" form for report headers
function fmtDateLong(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00Z');
  return isNaN(d) ? dateStr : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// "Equity Research · NASDAQ: IREN" — top-right label in the report header.
// fm.label overrides the base (e.g. "Research Note" for process papers).
function headerLabel(fm) {
  const base = fm.label || 'Equity Research';
  if (fm.ticker && fm.exchange) return `${base} &nbsp;·&nbsp; ${fm.exchange}: ${fm.ticker}`;
  if (fm.ticker) return `${base} &nbsp;·&nbsp; ${fm.ticker}`;
  return base;
}

// Meta strip wrapped in its container — empty string when there's nothing to show,
// so notes without price/PT data don't render an empty dark bar.
function metaStripBlock(fm) {
  const strip = metaStrip(fm);
  return strip ? `<div class="header-meta">${strip}</div>` : '';
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

// Blockquotes → .pull-quote (matching post-1.html's class)
function processBlockquotes(html) {
  return html.replace(/<blockquote>/g, '<blockquote class="pull-quote">');
}

// ─── Load & sort posts ────────────────────────────────────────────────────────
function loadPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];

  return fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(filename => {
      const slug = path.basename(filename, '.md');
      const raw  = fs.readFileSync(path.join(POSTS_DIR, filename), 'utf-8');
      const { data: fm, content: mdBody } = matter(raw);
      return { slug, fm, mdBody };
    })
    .filter(p => p.fm.title)
    .sort((a, b) => {
      const da = a.fm.date ? new Date(a.fm.date + 'T12:00:00Z') : new Date(0);
      const db = b.fm.date ? new Date(b.fm.date + 'T12:00:00Z') : new Date(0);
      return db - da; // newest first
    });
}

// Markdown body → HTML with plain (site-relative) image paths, for the web article page.
// Rewrites the pipeline's "../assets/foo.png" (relative to posts/) to "/assets/foo.png"
// (root-relative, which resolves correctly whether the page lives at /research/ or /posts/).
function renderBodyForWeb(mdBody) {
  let html = marked.parse(mdBody);
  html = html.replace(/src="\.\.\/(assets\/[^"]+)"/gi, 'src="/$1"');
  html = processBlockquotes(html);
  return html;
}

// ─── Canonical site footer — identical on every page ────────────────────────
function siteFooter() {
  return `  <footer>
    <div class="footer-inner">
      <div class="footer-grid">
        <div class="footer-brand">
          <img class="footer-logo" src="/assets/logo.png" alt="Elysium Capital" />
          <p class="footer-tagline">Independent Macro Research</p>
        </div>
        <nav class="footer-col" aria-label="Footer">
          <span class="footer-heading">Site</span>
          <a href="/home/">Home</a>
          <a href="/research/">Research</a>
          <a href="/framework/">Framework</a>
          <a href="/links/">Links</a>
        </nav>
        <div class="footer-col">
          <span class="footer-heading">Connect</span>
          <a href="https://x.com/elysiumfirm" target="_blank" rel="noopener noreferrer">X / Twitter</a>
          <a href="mailto:research@elysiumlab.markets">Email</a>
          <a href="https://discord.gg/scale" target="_blank" rel="noopener noreferrer">Discord</a>
        </div>
      </div>
      <p class="footer-disclaimer">
        Content published by Elysium Capital is for informational and educational purposes only and does
        not constitute financial, investment, tax, or legal advice, nor an offer or solicitation to buy
        or sell any security. All research reflects the independent analysis of its authors as of the
        date of publication and is subject to change without notice.
      </p>
      <div class="footer-bottom">
        <span class="footer-copy">&copy; <script>document.write(new Date().getFullYear())</script><noscript>2026</noscript> Elysium Capital. All rights reserved.</span>
        <span class="footer-copy">Not investment advice &nbsp;&middot;&nbsp; Not for distribution</span>
      </div>
    </div>
  </footer>`;
}

module.exports = {
  siteFooter,
  RATING_CFG,
  ratingLabel,
  fmtDate,
  fmtDateLong,
  headerLabel,
  metaStrip,
  metaStripBlock,
  keyFactsHTML,
  processBlockquotes,
  loadPosts,
  renderBodyForWeb,
};
