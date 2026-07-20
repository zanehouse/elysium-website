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

// Apply global defaults once, before creating any chart.
export function applyTheme(Chart) {
  Chart.defaults.color = PALETTE.muted;
  Chart.defaults.borderColor = PALETTE.grid;
  Chart.defaults.font.family = "'Courier New', monospace";
  Chart.defaults.font.size = 11;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1a1a1a';
  Chart.defaults.plugins.tooltip.borderColor = PALETTE.border;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = PALETTE.text;
  Chart.defaults.plugins.tooltip.bodyColor = PALETTE.text;
  Chart.defaults.plugins.tooltip.cornerRadius = 0;
  Chart.defaults.plugins.tooltip.titleFont = { family: "'Courier New', monospace" };
  Chart.defaults.plugins.tooltip.bodyFont = { family: "'Courier New', monospace" };
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
        ctx.font = "10px 'Courier New', monospace";
        ctx.textAlign = px > (chartArea.left + chartArea.right) / 2 ? 'right' : 'left';
        const pad = px > (chartArea.left + chartArea.right) / 2 ? -4 : 4;
        ctx.fillText(ln.label, px + pad, chartArea.top + 10);
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
    ctx.font = "700 2.4rem 'Libre Baskerville', Georgia, serif";
    ctx.fillText(opts.line1, cx, cy);
    if (opts.line2) {
      ctx.fillStyle = PALETTE.muted;
      ctx.font = "0.7rem 'Courier New', monospace";
      ctx.fillText(String(opts.line2).toUpperCase(), cx, cy + 22);
    }
    ctx.restore();
  },
};
