/* Home hero visual: a stone tablet with the main option Greeks carved into it, broken into
   mismatched shards. They start shuffled (scattered and turned), glide into place so the
   carved lines join back up, then the assembled tablet lights up, its cracks fade away and
   it grows slightly. Plays once per load; under reduced motion, or while the canvas is
   hidden on narrow screens, it just draws the finished state. */
(function () {
  var canvas = document.getElementById('hero-visual');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');

  var INK = '232,230,225';   // --text-bright
  var MOVE = 1.6;            // seconds each shard takes to land
  var LIGHT_AT = 2.6;        // every shard has landed by ~2.5s
  var END = 4.0;
  var GROW = 0.06;           // final scale-up
  // Drawn at 100px and scaled down by the transform, so the glyphs stay crisp at any size.
  var FONT = '100px ' + (getComputedStyle(document.documentElement)
    .getPropertyValue('--font-sans').trim() || 'sans-serif');
  var F = 0.18;              // letter height, in tablet units (the tablet spans -1..1)
  var em = F / 100;
  var TRACK = 0.025;         // extra space between carved letters

  var GREEKS = [
    ['Δ', '∂V/∂S'],
    ['Γ', '∂²V/∂S²'],
    ['Θ', '∂V/∂t'],
    ['ν', '∂V/∂σ']           // vega
  ];

  // mulberry32, seeded so the tablet is the same on every load.
  var seed = 11;
  function rand() {
    seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* The inscription: one Greek per line, symbol / = / definition in columns, each letter
     cut a little unevenly so it reads as carved by hand rather than typeset. */
  ctx.font = FONT;
  function wid(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) w += ctx.measureText(s[i]).width * em;
    return w + TRACK * (s.length - 1);
  }
  function carve(s, x, out) {
    for (var i = 0; i < s.length; i++) {
      var w = ctx.measureText(s[i]).width * em;
      out.push({ ch: s[i], x: x + w / 2, dy: (rand() - 0.5) * 0.014, rot: (rand() - 0.5) * 0.09,
                 wear: 0.6 + rand() * 0.4 });   // some letters worn shallower than others
      x += w + TRACK;
    }
  }
  var symW = Math.max.apply(null, GREEKS.map(function (g) { return wid(g[0]); }));
  var eqX = symW + 0.1, defX = eqX + wid('=') + 0.1;
  var left = -(defX + Math.max.apply(null, GREEKS.map(function (g) { return wid(g[1]); }))) / 2;
  var rows = GREEKS.map(function (g, i) {
    var glyphs = [];
    carve(g[0], left + (symW - wid(g[0])) / 2, glyphs);
    carve('=', left + eqX, glyphs);
    carve(g[1], left + defX, glyphs);
    return { y: -0.48 + i * 0.32, glyphs: glyphs };
  });

  // Worn outline: each side bows in slightly and every corner is chipped off unevenly.
  var SQ = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  var outline = [];
  for (var s = 0; s < 4; s++) {
    var a = SQ[s], b = SQ[(s + 1) % 4], chip = 0.02 + rand() * 0.07;
    for (var j = 0; j <= 6; j++) {
      var u = chip + (1 - 2 * chip) * j / 6, d = 1 - rand() * 0.02;
      outline.push([(a[0] + (b[0] - a[0]) * u) * d, (a[1] + (b[1] - a[1]) * u) * d]);
    }
  }
  var edge = new Path2D();
  outline.forEach(function (p, i) { edge[i ? 'lineTo' : 'moveTo'](p[0], p[1]); });
  edge.closePath();

  // Stone grain: faint flecks over the whole face.
  var grain = new Path2D();
  for (var n = 0; n < 520; n++) {
    var g = 0.004 + rand() * 0.009;
    grain.rect(rand() * 2 - 1, rand() * 2 - 1, g, g);
  }

  function centre(poly) {
    var x = 0, y = 0;
    for (var i = 0; i < poly.length; i++) { x += poly[i][0]; y += poly[i][1]; }
    return [x / poly.length, y / poly.length];
  }

  // Keep the part of poly on one side of the line through (px,py) with normal (nx,ny).
  function clip(poly, px, py, nx, ny, side) {
    var out = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var da = ((a[0] - px) * nx + (a[1] - py) * ny) * side;
      var db = ((b[0] - px) * nx + (b[1] - py) * ny) * side;
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        var t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }

  // Recursive slanted cuts give shards of uneven size and angle that still tile the tablet.
  var pieces = [];
  function addPiece(poly, c) {
    var shape = new Path2D();
    var y0 = Infinity, y1 = -Infinity, reach = 0;
    poly.forEach(function (p, i) {
      shape[i ? 'lineTo' : 'moveTo'](p[0] - c[0], p[1] - c[1]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      reach = Math.max(reach, Math.hypot(p[0] - c[0], p[1] - c[1]));
    });
    shape.closePath();
    var len = Math.hypot(c[0], c[1]) || 1;
    var push = 0.35 + rand() * 0.45;
    pieces.push({
      cx: c[0], cy: c[1], shape: shape, reach: reach,   // reach: radius it sweeps when turned
      rows: rows.filter(function (r) { return r.y + F > y0 && r.y - F < y1; }),
      ox: (c[0] / len) * push + (rand() - 0.5) * 0.3,
      oy: (c[1] / len) * push + (rand() - 0.5) * 0.3,
      rot: (rand() - 0.5) * 2.2,
      delay: 0.1 + rand() * 0.8
    });
  }
  function split(poly, depth) {
    var c = centre(poly);
    if (depth > 0 && !(depth < 3 && rand() < 0.3)) {
      var a = (depth % 2 ? 0 : Math.PI / 2) + (rand() - 0.5) * 1.1;
      var px = c[0] + (rand() - 0.5) * 0.25, py = c[1] + (rand() - 0.5) * 0.25;
      var l = clip(poly, px, py, Math.cos(a), Math.sin(a), 1);
      var r = clip(poly, px, py, Math.cos(a), Math.sin(a), -1);
      if (l.length > 2 && r.length > 2) { split(l, depth - 1); split(r, depth - 1); return; }
    }
    addPiece(poly, c);
  }
  split(outline, 4);

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function easeOut(x) { return 1 - Math.pow(1 - x, 3); }
  function smooth(x) { return x * x * (3 - 2 * x); }
  function ink(a) { return 'rgba(' + INK + ',' + a.toFixed(3) + ')'; }

  // Canvas size, the tablet's base half-width and its centre, all in CSS px (set in resize).
  var dpr = 1, w = 0, h = 0, base = 0, ax = 0, ay = 0, t = 0, px = 1;

  /* Grain, carved border and lettering, in tablet coordinates offset so (dx,dy) is the
     origin. Each cut is drawn twice: a dark copy nudged up-left, then the lit copy, so the
     groove's shadowed wall shows and the letters read as cut into the stone. */
  function face(list, dx, dy, a) {
    ctx.save();
    ctx.translate(-dx, -dy);
    ctx.fillStyle = ink(0.12 * a);
    ctx.fill(grain);
    ctx.lineWidth = 1.2 * px;
    for (var pass = 0; pass < 2; pass++) {
      var o = pass ? 0 : -px;
      var col = pass ? ink(a) : 'rgba(0,0,0,' + (0.75 * a).toFixed(3) + ')';
      ctx.strokeStyle = pass ? ink(0.45 * a) : col;
      ctx.strokeRect(-0.86 + o, -0.86 + o, 1.72, 1.72);
      ctx.fillStyle = col;
      for (var r = 0; r < list.length; r++) {
        for (var k = 0; k < list[r].glyphs.length; k++) {
          var gl = list[r].glyphs[k];
          ctx.save();
          ctx.translate(gl.x + o, list[r].y + gl.dy + o);
          ctx.rotate(gl.rot);
          ctx.globalAlpha = gl.wear;
          ctx.scale(em, em);
          ctx.fillText(gl.ch, 0, 0);
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  function draw(time) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!w) return;
    var appear = clamp01(time / 0.5);
    var light = smooth(clamp01((time - LIGHT_AT) / (END - LIGHT_AT)));
    var k = base * (1 + GROW * light);          // half-width of the tablet, in CSS px
    px = 1 / k;                                 // one CSS px in tablet units
    ctx.translate(ax, ay);
    ctx.scale(k, k);
    ctx.lineJoin = 'round';
    ctx.font = FONT;                            // resizing the canvas resets text state
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Every shard has landed by LIGHT_AT, so from then on paint the tablet whole: no
    // per-shard clip edges left to show a crack.
    var home = time >= LIGHT_AT;
    if (home) {
      ctx.fillStyle = ink(0.05 + 0.06 * light);
      ctx.fill(edge);
      ctx.save();
      ctx.clip(edge);
      face(rows, 0, 0, 0.5 + 0.3 * light);
      ctx.restore();
    }

    for (var i = 0; i < pieces.length; i++) {
      var pc = pieces[i];
      var away = 1 - easeOut(clamp01((time - pc.delay) / MOVE));
      ctx.save();
      ctx.translate(pc.cx + pc.sx * away, pc.cy + pc.sy * away);
      ctx.rotate(pc.rot * away);
      if (!home) {
        ctx.fillStyle = ink(0.05 * appear);
        ctx.fill(pc.shape);
        ctx.save();
        ctx.clip(pc.shape);
        face(pc.rows, pc.cx, pc.cy, (0.35 + 0.15 * (1 - away)) * appear);
        ctx.restore();
      }

      // The cracks fade out completely as the tablet lights, leaving one clean piece.
      if (light < 1) {
        ctx.lineWidth = px;
        ctx.strokeStyle = ink((0.28 + 0.22 * (1 - away)) * (1 - light) * appear);
        ctx.stroke(pc.shape);
      }
      ctx.restore();
    }

    if (light > 0) {
      ctx.shadowColor = ink(0.6 * light);
      ctx.shadowBlur = 24 * light * dpr;   // shadowBlur ignores the transform, so scale it by hand
      ctx.lineWidth = px;
      ctx.strokeStyle = ink(0.8 * light);
      ctx.stroke(edge);
      ctx.shadowBlur = 0;
    }
  }

  /* The canvas overhangs the hero (see #hero-visual in style.css). The lit tablet is 75% of
     the hero's height, centred in the stretch of the hero the canvas covers (its own column
     beside the text). Each shard's starting spot is then pulled inside the canvas so none is
     cut off mid-flight. */
  function resize() {
    dpr = window.devicePixelRatio || 1;
    var box = canvas.getBoundingClientRect(), hero = canvas.parentNode.getBoundingClientRect();
    w = box.width; h = box.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    base = hero.height * 0.75 / 2 / (1 + GROW);
    ax = (hero.right - box.left) / 2;
    ay = hero.top + hero.height / 2 - box.top;
    var x0 = -ax / base, x1 = (w - ax) / base, y0 = -ay / base, y1 = (h - ay) / base;
    pieces.forEach(function (pc) {
      pc.sx = Math.max(x0 + pc.reach, Math.min(x1 - pc.reach, pc.cx + pc.ox)) - pc.cx;
      pc.sy = Math.max(y0 + pc.reach, Math.min(y1 - pc.reach, pc.cy + pc.oy)) - pc.cy;
    });
    draw(t);
  }

  var raf = 0, t0 = 0;
  function frame(now) {
    if (!t0) t0 = now;
    t = Math.min(END, (now - t0) / 1000);
    draw(t);
    raf = t < END ? requestAnimationFrame(frame) : 0;
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !canvas.clientWidth) t = END;

  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);
  resize();

  if (t < END) {
    cancelAnimationFrame(raf);   // never two loops
    raf = requestAnimationFrame(frame);
  }
})();
