// chart-theme.js — Chart.js dark-theme defaults + small inline plugins.
// Matches css/style.css tokens; no external plugin dependencies.

export const PALETTE = {
  text: '#D4D4D4',
  muted: '#888888',
  border: '#222222',
  grid: '#1a1a1a',
  card: '#141414',
  bullish: '#4ade80',
  neutral: '#facc15',
  bearish: '#f87171',
};

// Ordinal ramp for term-ordered series — the volatility smile draws one line
// per expiry, and expiries are ORDERED, not categorical. Encoding that order as
// lightness (front bright, back dim) is both the semantically correct channel
// and the only one that survives on a near-monochrome page; a rainbow of eight
// hues would read as eight unrelated categories and break the palette.
//
// Lightness alone gets hard to separate past ~4 lines, so pair it with
// SERIES_DASH. The two channels together stay legible to six series, which is
// the practical ceiling the page enforces on expiry selection.
export function rampColor(i, n, alphaFrom = 1, alphaTo = 0.35) {
  const steps = Math.max(1, (n || 1) - 1);
  const frac = steps === 0 ? 0 : Math.min(1, Math.max(0, i / steps));
  const a = alphaFrom + (alphaTo - alphaFrom) * frac;
  return `rgba(212, 212, 212, ${a.toFixed(3)})`;
}

export const SERIES_DASH = [[], [6, 3], [2, 2], [8, 3, 2, 3], [4, 2, 1, 2], [10, 4]];

// Thermal ramp for a MAGNITUDE quantity (implied volatility on the 3D
// surface): cold blue at the low end through cyan, green and gold to a hot
// orange-red at the high end — the cold-to-hot spectrum a trading-terminal
// volatility surface conventionally uses, requested specifically to match
// that look rather than the single-hue amber ramp this used to be.
//
// This is a deliberate departure from "sequential = one hue" (see
// references/color-formula.md in the dataviz skill): a multi-hue ramp trades
// away monotonic lightness as an ordering cue — two stops here can be nearly
// equally bright (cyan and orange both sit near L*≈64-68) — in exchange for
// HUE doing the ordering instead, along a cold->hot axis nearly everyone
// already reads correctly without a legend. The height axis still carries
// the exact value regardless; colour is the redundant, at-a-glance channel,
// never the only one a reading depends on.
//
// Three of the six stops are the site's own existing tokens (PALETTE.bullish,
// PALETTE.neutral, PALETTE.bearish) rather than invented hues — this is a
// magnitude scale, not a sentiment one, but reusing colours the page already
// uses elsewhere keeps the ramp from reading as an unrelated import. Every
// stop clears >=3.76:1 contrast against the scene's #0D0D0D background
// (worst case: the blue), all above the 3:1 large-area floor the previous
// ramp was held to.
export const IV_RAMP = ['#2563eb', '#06b6d4', '#4ade80', '#facc15', '#f97316', '#f87171'];

// Piecewise-linear sample of IV_RAMP. t is clamped to 0..1.
export function rampSample(t) {
  const n = IV_RAMP.length - 1;
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  const a = IV_RAMP[i], b = IV_RAMP[i + 1];
  const mix = (o) => Math.round(
    parseInt(a.slice(o, o + 2), 16) + (parseInt(b.slice(o, o + 2), 16) - parseInt(a.slice(o, o + 2), 16)) * f,
  );
  return { r: mix(1) / 255, g: mix(3) / 255, b: mix(5) / 255 };
}

export function rampCss(t) {
  const c = rampSample(t);
  return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

// Apply global defaults once, before creating any chart.
export function applyTheme(Chart) {
  Chart.defaults.color = PALETTE.muted;
  Chart.defaults.borderColor = PALETTE.grid;
  Chart.defaults.font.family = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  Chart.defaults.font.size = 11;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1a1a1a';
  Chart.defaults.plugins.tooltip.borderColor = PALETTE.border;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = PALETTE.text;
  Chart.defaults.plugins.tooltip.bodyColor = PALETTE.text;
  Chart.defaults.plugins.tooltip.cornerRadius = 0;
  Chart.defaults.plugins.tooltip.titleFont = { family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" };
  Chart.defaults.plugins.tooltip.bodyFont = { family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" };
  Chart.defaults.maintainAspectRatio = false;
}

// Pixel position for a continuous numeric value on either a linear or a
// category scale. Category scales only have exact pixels for their discrete
// labels (e.g. one per strike), so a value that falls between two labels —
// like a spot price that doesn't land exactly on a listed strike — is
// linearly interpolated between the two bracketing labels' pixels.
function pixelForValue(xScale, value) {
  if (xScale.type !== 'category') return xScale.getPixelForValue(value);
  // CategoryScale.getPixelForValue takes the label's raw INDEX, not its
  // value (getPixelForTick only covers ticks Chart.js actually rendered
  // after autoSkip, which is a sparse subset — not what we want here).
  const labels = xScale.getLabels().map(Number);
  if (!labels.length) return null;
  if (value <= labels[0]) return xScale.getPixelForValue(0);
  if (value >= labels[labels.length - 1]) return xScale.getPixelForValue(labels.length - 1);
  for (let i = 0; i < labels.length - 1; i++) {
    if (value >= labels[i] && value <= labels[i + 1]) {
      const p0 = xScale.getPixelForValue(i);
      const p1 = xScale.getPixelForValue(i + 1);
      const span = labels[i + 1] - labels[i];
      const frac = span === 0 ? 0 : (value - labels[i]) / span;
      return p0 + (p1 - p0) * frac;
    }
  }
  return null;
}

// Draws labeled vertical reference lines from options.plugins.vlines:
//   [{ x: <axis value>, label: 'Spot 5900', color: '#D4D4D4' }]
//
// Pass `labelRow: n` to drop a label n lines down from the top. Reference lines
// often land close together — an at-the-money option puts spot and strike on
// the same pixel — and without staggering their labels overprint into an
// unreadable smear.
export const verticalLinePlugin = {
  id: 'vlines',
  afterDatasetsDraw(chart, _args, opts) {
    const lines = (opts && opts.lines) || [];
    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;
    if (!xScale) return;
    ctx.save();
    for (const ln of lines) {
      const px = pixelForValue(xScale, ln.x);
      if (px == null || isNaN(px)) continue;
      ctx.beginPath();
      ctx.moveTo(px, chartArea.top);
      ctx.lineTo(px, chartArea.bottom);
      ctx.lineWidth = 1;
      ctx.setLineDash(ln.dash || [4, 4]);
      ctx.strokeStyle = ln.color || PALETTE.text;
      ctx.stroke();
      if (ln.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = ln.color || PALETTE.text;
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        ctx.textAlign = px > (chartArea.left + chartArea.right) / 2 ? 'right' : 'left';
        const pad = px > (chartArea.left + chartArea.right) / 2 ? -4 : 4;
        ctx.fillText(ln.label, px + pad, chartArea.top + 10 + (ln.labelRow || 0) * 12);
      }
    }
    ctx.restore();
  },
};

// Draws centered text inside a doughnut/gauge from options.plugins.centerText:
//   { line1: '62', line2: 'GREED', color: '#4ade80' }
export const centerTextPlugin = {
  id: 'centerText',
  afterDraw(chart, _args, opts) {
    if (!opts || !opts.line1) return;
    const { ctx, chartArea } = chart;
    const cx = (chartArea.left + chartArea.right) / 2;
    // For a half-doughnut, anchor near the flat bottom edge.
    const cy = chartArea.bottom - (chartArea.bottom - chartArea.top) * 0.15;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = opts.color || PALETTE.text;
    ctx.font = "2.4rem 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText(opts.line1, cx, cy);
    if (opts.line2) {
      ctx.fillStyle = PALETTE.muted;
      ctx.font = "0.7rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.fillText(String(opts.line2), cx, cy + 22);
    }
    ctx.restore();
  },
};
