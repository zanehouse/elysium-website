/* vol-surface.js — the orbitable 3D implied-volatility surface.

   Moneyness (x) × time to expiry (z) × implied volatility (y, and colour).

   The only file in the site that imports three. It is pulled in by a dynamic
   import inside a try/catch from vol-page.js: a static import would put three in the page's module graph, so
   a CDN hiccup or a missing importmap would take the 2D charts down with it.
   This way the surface is strictly additive — if it can't load, the page is the
   page it was before.

   ── Why there are no lights ──────────────────────────────────────────────────
   Colour here encodes implied volatility, and a lit material would multiply that
   colour by a shading term depending on which way the surface happens to slope —
   so two points at identical IV would render as different colours purely because
   of geometry, silently breaking the encoding the legend promises.

   The surface still needs to read as a solid object, so shading is BAKED into
   the vertex colours on the CPU (see bakeColors) against a fixed key direction,
   over a deliberately narrow band. That keeps a single unlit draw call, and
   makes the worst-case colour error an exact, stated number instead of something
   you would have to trace through three's whole shading chain to bound.

   ── Why quads go missing ─────────────────────────────────────────────────────
   A cell with no value is skipped rather than filled, so the mesh has a ragged
   edge showing exactly how far the board reaches. The page fills gaps in TIME
   before handing the lattice over (fillGridInTime / densifyGrid in vol.js) —
   interpolating between quoted expiries at the same moneyness — but nothing ever
   invents a wing the strikes don't reach. See the header of vol.js. */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* Only `three` and `three/addons/` go through the importmap; these are ordinary
   same-origin relative imports and both modules are already in the page's graph,
   so pulling them in here costs nothing and keeps the colour ramp and the tick
   ladders defined in exactly one place each. */
import { rampSample } from './chart-theme.js';
import { niceTicks, dteTicks } from './vol.js';

/* Half-extents of the plot box in world units. Wider than deep so the moneyness
   axis — the one carrying the smile — gets the most pixels. */
var HALF_X = 2.0;
var HALF_Z = 1.5;
var HEIGHT = 1.35;

/* Default eye: 50° round, ~27° up, ~5.8 out.

   The elevation is set by the viewport rather than by taste — this canvas is
   roughly 2:1, wide and short, so a steep look-down projects the 4×3 floor into
   a tall shape that overflows and crops the expiry labels. The distance leaves
   margin for the tick sprites, which sit outside the box and are what actually
   overflow first.

   The three axes are then hung on three different corners (see buildDecor) so
   none of them lands on top of the surface at this angle. That pairing is the
   whole trick: move the camera and the axis placement has to move with it.

   Shared by the initial view and the Reset button so the two cannot drift. */
var HOME_EYE = [4.67, 3.60, 3.92];
var HOME_TARGET = [0, 0.5, 0];

var COL_TEXT = 0xd4d4d4;
var COL_MUTED = 0x888888;
var COL_GRID = 0x2a2a2a;
var COL_WIRE = 0x0d0d0d;
var COL_WALL = 0x111111;

/* Mesh-line stride. The dense lattice is 49 rows x 41 columns, i.e. 48 x 40
   intervals — both divisible by these, so a line lands on the first and last
   index exactly and the box has no doubled or missing edge line. */
var ROW_LINE_EVERY = 6;
var COL_LINE_EVERY = 5;

/* Baked key light, fixed in OBJECT space so the shading does not swim while the
   surface auto-spins. Off to the put side and high, so the front-week put wing
   (the tallest feature on an equity surface) catches light while the long-dated
   plateau sits mid-tone. See bakeColors() for the dL* budget. */
var KEY = new THREE.Vector3(-0.55, 0.70, 0.45).normalize();
var SHADE_FLOOR = 0.90;

/* Auto-spin, in radians per SECOND — about one turn a minute. Slow enough to
   read as an invitation to drag rather than as motion competing with the data. */
var SPIN_RATE = 0.10;

/* Moneyness ticks, in the units the data uses. Shared by the floor labels and
   the Z-wall gridlines so the two can never disagree. */
var MONEY_TICKS = [-0.15, -0.10, -0.05, 0, 0.05, 0.10, 0.15];

/* ── label sprites ─────────────────────────────────────────────────────────── */

/* Canvas-texture sprites rather than HTML overlays: they live in the scene, so
   they sort correctly against the surface and need no per-frame DOM writes while
   the camera moves. Sprites always face the camera, which is what axis ticks
   want. */
function makeLabel(text, opts) {
  opts = opts || {};
  var size = opts.size || 44;
  var color = opts.color || '#888888';
  var pad = 8;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d');
  var font = size + "px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.font = font;
  var w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  var h = Math.ceil(size * 1.4);
  canvas.width = w;
  canvas.height = h;
  // Resizing the canvas resets the context, so restate everything.
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2);

  var tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  /* depthTest off, and this is load-bearing rather than cosmetic: tick labels
     sit just OUTSIDE the box, so once the cage gained opaque back panels every
     label on a far edge was being occluded by the wall in front of it — the
     whole expiry axis simply disappeared. Labels are annotations, not geometry;
     they should never be hidden by the furniture. renderOrder keeps them last.
     fog off for the same reason: a tick at the back of the cage must stay
     legible rather than dissolving into the background. */
  var mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false,
  });
  var sprite = new THREE.Sprite(mat);
  /* The canvas is drawn at a large font purely for texture resolution; the world
     scale is what sets the on-screen size. At 0.0026 a tick is roughly 0.16
     world units against a 1.35-unit plot — readable without competing with the
     data. This is easy to get wrong by an order of magnitude in both directions:
     0.0055 made every label a quarter of the plot's height, and 0.0015 shrank
     them past legibility. */
  var scale = opts.scale || 0.0030;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function createSurface(canvas, options) {
  var opts = options || {};
  var maxDpr = opts.maxDpr || 2;
  var onHover = opts.onHover || function () {};

  var renderer = new THREE.WebGLRenderer({
    canvas: canvas, antialias: true, alpha: true, powerPreference: 'low-power',
  });
  renderer.setClearAlpha(0);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.fromArray(HOME_EYE);

  var controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.7;
  controls.enablePan = false;          // panning a plot box only ever loses it
  controls.minDistance = 3.0;
  controls.maxDistance = 12.0;
  // Never let the camera go under the floor: from below, the surface reads as a
  // completely different (and wrong) shape.
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.target.fromArray(HOME_TARGET);

  /* One finger must keep scrolling the page. A vertical drag that started as a
     scroll should not get captured by the plot, so touch rotation needs two
     fingers — the caption says so. */
  controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };

  /* OrbitControls writes touchAction:'none' onto the element in its constructor,
     which would swallow one-finger page scrolls over the canvas — the visitor
     would hit the surface and the page would simply stop scrolling. Putting
     pan-y back is what actually makes the two-finger arrangement above work. */
  canvas.style.touchAction = 'pan-y';

  /* Linear fog, and the single cheapest thing on this list that reads as a
     terminal: it makes the back of the cage recede instead of sitting flat at
     the same value as the front. The fill and the mesh lines opt OUT (see the
     material construction) so it touches the cage only and cannot move the
     colour encoding. */
  scene.fog = new THREE.Fog(0x0d0d0d, 4.4, 12.0);

  var root = new THREE.Group();
  scene.add(root);

  var surfaceMesh = null;
  var meshLines = [];
  var plot = new THREE.Group();       // the fill + its mesh lines
  var decor = new THREE.Group();      // cage, floor, axis lines, tick sprites
  var walls = [];                     // [{ group, axis, sign }] toggled per frame
  root.add(plot);
  root.add(decor);

  var grid = null;                    // the surfaceGrid() payload
  var ivLo = 0, ivHi = 1;   // height domain: the full range
  var colLo = 0, colHi = 1; // colour domain: clamped, see setGrid
  var logLo = 0, logHi = 1;

  var needsRender = true;
  var raf = 0;
  var running = false;    // a frame chain is in flight — see ensureLoop()
  var lastFrameMs = 0;
  var autoRotate = false;
  var disposed = false;
  var active = true;      // driven by the page's IntersectionObserver

  /* ── axis mapping ───────────────────────────────────────────────────────── */

  function xFor(moneyness) {
    var span = grid.moneyness[grid.moneyness.length - 1] - grid.moneyness[0];
    return span === 0 ? 0 : ((moneyness - grid.moneyness[0]) / span) * (HALF_X * 2) - HALF_X;
  }

  /* Time is laid out in LOG days for the same reason the 2D term chart is: the
     board runs to three years, and on a linear axis every expiry inside the
     first month — where the surface actually has structure — collapses onto one
     edge. Near-dated sits at +Z, nearest the default camera. */
  function zFor(dte) {
    var l = Math.log(Math.max(1, dte));
    var span = logHi - logLo;
    var f = span === 0 ? 0 : (l - logLo) / span;
    return HALF_Z - f * (HALF_Z * 2);
  }

  function yFor(iv) {
    var span = ivHi - ivLo;
    return span === 0 ? 0 : ((iv - ivLo) / span) * HEIGHT;
  }

  // Colour position, on the CLAMPED domain and saturating at both ends.
  function tFor(iv) {
    var span = colHi - colLo;
    if (span <= 0) return 0;
    return Math.min(1, Math.max(0, (iv - colLo) / span));
  }

  /* ── geometry ───────────────────────────────────────────────────────────── */

  /* Empty a group and release everything under it. RECURSIVE on purpose: the
     wall groups below each hold a panel plus their own gridlines, and a
     one-level-deep sweep would silently leak a geometry, a material and a
     texture per wall on every symbol load. That kind of leak never shows up in
     a smoke test — it shows up after someone flips through ten tickers. */
  function disposeGroup(group) {
    group.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    group.clear();
  }

  function buildSurface() {
    var rows = grid.rows.length;
    var cols = grid.moneyness.length;

    var positions = new Float32Array(rows * cols * 3);

    for (var r = 0; r < rows; r++) {
      var z = zFor(grid.rows[r].dte);
      for (var c = 0; c < cols; c++) {
        var i = r * cols + c;
        var v = grid.rows[r].values[c];
        positions[i * 3] = xFor(grid.moneyness[c]);
        positions[i * 3 + 1] = v === null ? 0 : yFor(v);
        positions[i * 3 + 2] = z;
      }
    }

    // Only emit a quad when all four of its corners carry a value.
    var index = [];
    for (var rr = 0; rr < rows - 1; rr++) {
      for (var cc = 0; cc < cols - 1; cc++) {
        if (grid.rows[rr].values[cc] === null || grid.rows[rr].values[cc + 1] === null ||
            grid.rows[rr + 1].values[cc] === null || grid.rows[rr + 1].values[cc + 1] === null) continue;
        var a = rr * cols + cc;
        index.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(index);

    /* Normals exist only to bake shading into the vertex colours below; the
       material never sees them. computeVertexNormals() has to run after the
       index is set, since it accumulates per face. */
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.BufferAttribute(bakeColors(geo, rows, cols), 3));
    geo.deleteAttribute('normal');
    geo.computeBoundingSphere();

    var mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,   // the underside is visible from a low camera
      // Pushes the fill a hair back in depth so the mesh lines drawn on the same
      // plane win the depth test instead of z-fighting with it.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      // Fog would pull the fill up to 19% toward the background over the box's
      // depth — nearly triple the shading budget below, and unlike shading it
      // varies with camera distance. Exempting the fill makes fog's effect on
      // the colour encoding exactly zero while the cage still recedes.
      fog: false,
    });

    surfaceMesh = new THREE.Mesh(geo, mat);
    plot.add(surfaceMesh);

    buildMeshLines(positions, rows, cols);
  }

  /* Bake a fixed-key Lambert term into the vertex colours.

     The material stays unlit. Real lights would multiply the colour in LINEAR
     space, after colour management and tone mapping, so the band that actually
     lands on screen is not the number you wrote and bounding it means reasoning
     through three's whole shading chain. Baking multiplies the sRGB-encoded ramp
     value directly, so the bound below is exact, it stays one draw call, and
     there are no lights to construct or dispose.

     The budget is exact rather than empirical: shade multiplies all three
     channels by the SAME scalar in [0.90, 1.00], and scaling R/G/B uniformly
     cannot change hue or saturation at all — only value (brightness) moves.
     So which colour band a facet reads as never depends on lighting, only on
     its IV does; the 10% floor just keeps a fully-shaded facet from reading
     as flatly dark against its neighbours. That holds regardless of which
     hues IV_RAMP uses, including the multi-hue thermal ramp in
     chart-theme.js — unlike a single-hue ramp, this one leans on hue rather
     than lightness to read order, and hue is exactly the channel baked
     shading never touches. */
  function bakeColors(geo, rows, cols) {
    var normals = geo.attributes.normal.array;
    var colors = new Float32Array(rows * cols * 3);
    var srgb;
    var out = new THREE.Color();
    var n = new THREE.Vector3();

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var i = r * cols + c;
        var v = grid.rows[r].values[c];
        srgb = rampSample(v === null ? 0 : tFor(v));

        n.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
        // Vertices no quad referenced keep a zero normal; they are never drawn,
        // so the value does not matter, but guard the normalize anyway.
        if (n.lengthSq() > 1e-12) {
          n.normalize();
          // Flip to the upper hemisphere so shading is winding-independent.
          if (n.y < 0) n.negate();
        } else {
          n.set(0, 1, 0);
        }
        var shade = SHADE_FLOOR + (1 - SHADE_FLOOR) * Math.max(0, n.dot(KEY));

        // Scale in sRGB, THEN hand it to three for the linear conversion.
        out.setRGB(srgb.r * shade, srgb.g * shade, srgb.b * shade, THREE.SRGBColorSpace);
        colors[i * 3] = out.r;
        colors[i * 3 + 1] = out.g;
        colors[i * 3 + 2] = out.b;
      }
    }
    return colors;
  }

  /* Mesh lines over the fill. Three separate objects, because they are doing
     three different jobs:

       interior — every ROW_LINE_EVERY-th row and COL_LINE_EVERY-th column, the
         classic mesh-over-a-solid look. A full wireframe at 49x41 is ~3,900
         segments and reads as noise, not structure. The count here is close to
         what the old sparse lattice drew, but each line now walks EVERY dense
         sample along its length, so it curves instead of being a 20-segment
         polyline — that is what makes the surface read as a smooth solid.

       boundary — a lattice edge with exactly one adjoining quad. Drawn at full
         resolution and brighter, so the ragged edge left by missing strikes
         reads as a deliberate boundary rather than as tearing.

       atm — the moneyness-zero column, tying the 3D back to the term-structure
         chart beside it, which plots exactly this line.

     All three skip any segment with a null endpoint, so they share the fill's
     outline exactly. */
  function buildMeshLines(positions, rows, cols) {
    var interior = [], boundary = [], atm = [];

    function seg(into, i, j) {
      into.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      into.push(positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2]);
    }
    function has(r, c) {
      return r >= 0 && r < rows && c >= 0 && c < cols && grid.rows[r].values[c] !== null;
    }
    // A quad exists only when all four of its corners do — same rule as the fill.
    function quad(r, c) {
      return has(r, c) && has(r, c + 1) && has(r + 1, c) && has(r + 1, c + 1);
    }

    var atmCol = -1;
    for (var k = 0; k < cols; k++) {
      if (atmCol < 0 || Math.abs(grid.moneyness[k]) < Math.abs(grid.moneyness[atmCol])) atmCol = k;
    }

    // Horizontal runs (constant row).
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols - 1; c++) {
        if (!has(r, c) || !has(r, c + 1)) continue;
        var above = quad(r - 1, c), below = quad(r, c);
        if (above !== below) seg(boundary, r * cols + c, r * cols + c + 1);
        else if (r % ROW_LINE_EVERY === 0 && above && below) seg(interior, r * cols + c, r * cols + c + 1);
      }
    }
    // Vertical runs (constant column).
    for (var cc = 0; cc < cols; cc++) {
      for (var rr = 0; rr < rows - 1; rr++) {
        if (!has(rr, cc) || !has(rr + 1, cc)) continue;
        var left = quad(rr, cc - 1), right = quad(rr, cc);
        var into = null;
        if (left !== right) into = boundary;
        else if (cc === atmCol && left && right) into = atm;
        else if (cc % COL_LINE_EVERY === 0 && left && right) into = interior;
        if (into) seg(into, rr * cols + cc, (rr + 1) * cols + cc);
      }
    }

    meshLines = [
      makeLines(interior, COL_WIRE, 0.28),
      makeLines(boundary, COL_WIRE, 0.65),
      makeLines(atm, COL_TEXT, 0.35),
    ].filter(Boolean);
    for (var m = 0; m < meshLines.length; m++) plot.add(meshLines[m]);
  }

  function makeLines(pts, color, opacity) {
    if (!pts.length) return null;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: color, transparent: true, opacity: opacity, fog: false,
    }));
  }

  /* ── floor, axes, ticks ─────────────────────────────────────────────────── */

  function addLine(pts, color, opacity) {
    var geo = new THREE.BufferGeometry().setFromPoints(pts);
    var mat = new THREE.LineBasicMaterial({
      color: color, transparent: true, opacity: opacity === undefined ? 1 : opacity,
    });
    decor.add(new THREE.Line(geo, mat));
  }

  /* One wall: an opaque panel plus its own gridlines, in a group whose
     visibility is flipped per frame by updateWalls().

     Four independently-toggled groups rather than the tidier trick of a
     BoxGeometry with side:BackSide. BackSide culls the near faces for free and
     is genuinely correct at any angle — but it also draws the ceiling, and more
     importantly the gridlines are LineSegments, which are NOT back-face culled.
     They would need their own visibility predicate anyway, and any disagreement
     between that predicate and the GPU's culling shows up as lines floating in
     front of nothing at grazing angles. Keeping each panel and its lines in one
     group makes them incapable of disagreeing.

     axis/sign say which half-space the wall lives on, so updateWalls() can hide
     it whenever the camera is on the same side (i.e. it would be in front). */
  function addWall(axis, sign, ivTicks) {
    var g = new THREE.Group();
    var w = axis === 'x' ? HALF_Z : HALF_X;

    var panel = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 2, HEIGHT),
      // Opaque, not transparent: a near wall is culled rather than blended, so
      // there is no sorting problem that alpha would need to solve.
      new THREE.MeshBasicMaterial({ color: COL_WALL, side: THREE.DoubleSide }),
    );
    panel.position.set(
      axis === 'x' ? sign * HALF_X : 0,
      HEIGHT / 2,
      axis === 'z' ? sign * HALF_Z : 0,
    );
    if (axis === 'x') panel.rotation.y = Math.PI / 2;
    g.add(panel);

    // Gridlines, nudged toward the box interior so they don't z-fight the panel.
    var eps = 0.004 * -sign;
    var pts = [];
    function line(a, b) { pts.push(a.x, a.y, a.z, b.x, b.y, b.z); }

    for (var i = 0; i < ivTicks.length; i++) {
      var y = yFor(ivTicks[i]);
      if (axis === 'x') {
        line(new THREE.Vector3(sign * HALF_X + eps, y, -HALF_Z),
          new THREE.Vector3(sign * HALF_X + eps, y, HALF_Z));
      } else {
        line(new THREE.Vector3(-HALF_X, y, sign * HALF_Z + eps),
          new THREE.Vector3(HALF_X, y, sign * HALF_Z + eps));
      }
    }
    // Verticals: the expiry ladder on the X walls, the moneyness ladder on Z.
    if (axis === 'x') {
      for (var j = 0; j < dteTickValues.length; j++) {
        var z = zFor(dteTickValues[j]);
        line(new THREE.Vector3(sign * HALF_X + eps, 0, z),
          new THREE.Vector3(sign * HALF_X + eps, HEIGHT, z));
      }
    } else {
      for (var k = 0; k < moneyTickValues.length; k++) {
        var x = xFor(moneyTickValues[k]);
        line(new THREE.Vector3(x, 0, sign * HALF_Z + eps),
          new THREE.Vector3(x, HEIGHT, sign * HALF_Z + eps));
      }
    }

    var lines = makeLines(pts, COL_GRID, 0.8);
    if (lines) g.add(lines);

    decor.add(g);
    walls.push({ group: g, axis: axis, sign: sign });
    return g;
  }

  /* Show a wall only when the camera is on its far side.

     worldToLocal is load-bearing: during auto-spin the box turns under a
     stationary camera, so a world-space comparison would keep showing the same
     two walls while the data rotated behind them. */
  var camLocal = new THREE.Vector3();
  function updateWalls() {
    if (!walls.length) return;
    camLocal.copy(camera.position);
    root.worldToLocal(camLocal);
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      var limit = w.axis === 'x' ? HALF_X : HALF_Z;
      var pos = w.axis === 'x' ? camLocal.x : camLocal.z;
      w.group.visible = w.sign > 0 ? pos < limit : pos > -limit;
    }
  }

  var moneyTickValues = [];
  var dteTickValues = [];

  function buildDecor() {
    var y0 = -0.001;

    var ivTickValues = niceTicks(ivLo, ivHi, 6);
    dteTickValues = dteTicks(grid.dteMin, grid.dteMax);

    moneyTickValues = [];
    var mLo = grid.moneyness[0], mHi = grid.moneyness[grid.moneyness.length - 1];
    for (var t = 0; t < MONEY_TICKS.length; t++) {
      if (MONEY_TICKS[t] >= mLo - 1e-9 && MONEY_TICKS[t] <= mHi + 1e-9) moneyTickValues.push(MONEY_TICKS[t]);
    }

    // Back walls first, so everything else draws over them.
    addWall('z', -1, ivTickValues);
    addWall('z', 1, ivTickValues);
    addWall('x', -1, ivTickValues);
    addWall('x', 1, ivTickValues);
    updateWalls();

    // Floor outline + a light lattice, so the box reads as a volume.
    addLine([
      new THREE.Vector3(-HALF_X, y0, -HALF_Z), new THREE.Vector3(HALF_X, y0, -HALF_Z),
      new THREE.Vector3(HALF_X, y0, HALF_Z), new THREE.Vector3(-HALF_X, y0, HALF_Z),
      new THREE.Vector3(-HALF_X, y0, -HALF_Z),
    ], COL_GRID, 1);
    var lo = grid.moneyness[0], hi = grid.moneyness[grid.moneyness.length - 1];
    for (var i = 0; i < MONEY_TICKS.length; i++) {
      var m = MONEY_TICKS[i];
      if (m < lo - 1e-9 || m > hi + 1e-9) continue;
      var x = xFor(m);
      var atm = Math.abs(m) < 1e-9;
      addLine([new THREE.Vector3(x, y0, -HALF_Z), new THREE.Vector3(x, y0, HALF_Z)],
        atm ? COL_MUTED : COL_GRID, atm ? 0.85 : 0.6);
      var lab = makeLabel(atm ? 'ATM' : (m > 0 ? '+' : '') + Math.round(m * 100) + '%',
        { color: atm ? '#d4d4d4' : '#888888' });
      lab.position.set(x, 0.015, HALF_Z + 0.16);
      decor.add(lab);
    }
    // The at-the-money plane, carried up the full height — the reference line
    // every other reading on the page is quoted against.
    addLine([
      new THREE.Vector3(xFor(0), y0, HALF_Z), new THREE.Vector3(xFor(0), HEIGHT * 1.02, HALF_Z),
    ], COL_MUTED, 0.5);

    for (var j = 0; j < dteTickValues.length; j++) {
      var d = dteTickValues[j];
      var z = zFor(d);
      addLine([new THREE.Vector3(-HALF_X, y0, z), new THREE.Vector3(HALF_X, y0, z)], COL_GRID, 0.6);
      var dl = makeLabel(d >= 365 ? (d / 365) + 'y' : d + 'd', { color: '#888888' });
      dl.position.set(HALF_X + 0.26, 0.015, z);
      decor.add(dl);
    }

    /* Vertical IV axis on the BACK-LEFT post, labelled outward to the left.

       Axis placement here is entirely about NEAR versus FAR edges. A label sits
       outside the box, so on a near edge — pushed toward the camera — it lands
       outside the surface's silhouette and reads cleanly; that is why the
       moneyness ticks along the front edge have always been legible. On a far
       edge the surface projects straight over it, and no amount of extra offset
       fixes that, because on a far edge "further out" is mostly "further away".

       So the two horizontal axes take the two near edges (moneyness front,
       expiry right) and the vertical axis goes to the far-left post, whose
       labels project into the empty region above and left of the front-week
       wing — the one part of the frame the surface never reaches. */
    var xAxis = HALF_X, zAxis = -HALF_Z;
    addLine([new THREE.Vector3(xAxis, y0, zAxis), new THREE.Vector3(xAxis, HEIGHT, zAxis)], COL_GRID, 1);
    for (var k = 0; k < ivTickValues.length; k++) {
      var iv = ivTickValues[k];
      var yl = makeLabel((iv * 100).toFixed(0) + '%', { color: '#888888' });
      yl.position.set(xAxis + 0.50, yFor(iv), zAxis);
      decor.add(yl);
      addLine([
        new THREE.Vector3(xAxis, yFor(iv), zAxis), new THREE.Vector3(xAxis + 0.08, yFor(iv), zAxis),
      ], COL_GRID, 1);
    }

    var t1 = makeLabel('MONEYNESS', { size: 34, color: '#5c5c5c', scale: 0.0024 });
    t1.position.set(0, 0.015, HALF_Z + 0.42);
    decor.add(t1);
    // Pushed clear of the tick column, which runs right beside it.
    var t2 = makeLabel('EXPIRY', { size: 34, color: '#5c5c5c', scale: 0.0024 });
    t2.position.set(HALF_X + 0.62, 0.015, HALF_Z * 0.55);
    decor.add(t2);
    var t3 = makeLabel('IMPLIED VOL', { size: 34, color: '#5c5c5c', scale: 0.0024 });
    t3.position.set(xAxis + 0.50, HEIGHT + 0.18, zAxis);
    decor.add(t3);
  }

  /* ── hover ──────────────────────────────────────────────────────────────── */

  var raycaster = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  var hoverArmed = false;

  function handleMove(ev) {
    if (!surfaceMesh || disposed) return;
    var r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObject(surfaceMesh, false);
    if (!hits.length) {
      if (hoverArmed) { hoverArmed = false; onHover(null); }
      return;
    }
    var p = hits[0].point;

    // Invert the axis mapping to recover the data coordinates under the cursor.
    var fx = (p.x + HALF_X) / (HALF_X * 2);
    var moneyness = grid.moneyness[0] + fx * (grid.moneyness[grid.moneyness.length - 1] - grid.moneyness[0]);
    var fz = (HALF_Z - p.z) / (HALF_Z * 2);
    var dte = Math.exp(logLo + fz * (logHi - logLo));
    var iv = ivLo + (p.y / HEIGHT) * (ivHi - ivLo);

    /* Report the nearest LISTED expiry, not the row under the cursor. Most rows
       are synthetic tenors from densifyGrid — the surface is continuous in time,
       but the board is not, and quoting a date no contract expires on would be a
       lie. `listed` carries the real expiries alongside the dense lattice. */
    var listed = grid.listed && grid.listed.length ? grid.listed : grid.rows;
    var best = listed[0], bd = Infinity;
    for (var i = 0; i < listed.length; i++) {
      var d = Math.abs(Math.log(listed[i].dte) - Math.log(Math.max(1, dte)));
      if (d < bd) { bd = d; best = listed[i]; }
    }
    hoverArmed = true;
    onHover({
      moneyness: moneyness, iv: iv, dte: best.dte, date: best.date,
      clientX: ev.clientX, clientY: ev.clientY,
    });
  }

  function handleLeave() {
    if (hoverArmed) { hoverArmed = false; onHover(null); }
  }

  canvas.addEventListener('pointermove', handleMove);
  canvas.addEventListener('pointerleave', handleLeave);
  controls.addEventListener('start', function () { autoRotate = false; handleLeave(); });
  controls.addEventListener('change', invalidate);

  /* ── loop ───────────────────────────────────────────────────────────────── */

  /* The loop runs while the section is on screen and stops when it isn't — the
     page owns that signal and pushes it in through setActive(). GPU work is
     still gated: a frame only reaches renderer.render() when the camera moved,
     auto-rotate is on, or the data changed.

     An earlier version tried to park the rAF chain itself after a few idle
     frames and drive it purely from OrbitControls' 'change' event. That raced:
     'change' fires from inside controls.update() during a drag, so invalidate()
     and the loop's own bookkeeping fought over the same counter, the chain
     parked mid-drag, and the canvas sat on a stale frame while the camera kept
     moving. Keeping the loop alive and gating only the draw is both simpler and
     correct — an idle frame here is one comparison. */
  function invalidate() {
    needsRender = true;
    ensureLoop();
  }

  /* `running` rather than testing the rAF id, and this is the whole fix for a
     nasty one: frame() clears raf at the top, and controls.update() dispatches
     'change' from INSIDE frame(), which calls invalidate() -> ensureLoop() at
     exactly the moment the id reads 0. That scheduled a second chain, the tail
     of frame() scheduled a third, and every drag added more. Each chain then
     advanced root.rotation.y once per frame, so the auto-spin ran ~3.6x too fast
     after a single drag — measured 0.127 rad/s on load against 0.455 after — and
     lurched instead of drifting. A flag that stays true for the whole life of
     the chain cannot be fooled by the id being momentarily clear. */
  function ensureLoop() {
    if (running || !active || disposed) return;
    running = true;
    lastFrameMs = 0;        // first frame just establishes the clock
    raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    if (disposed || !active) { running = false; return; }

    /* Rotation is per SECOND, not per frame. Per-frame ties the speed to the
       display: the same code drifts at one rate on a 60Hz panel and twice that
       on a 120Hz one. dt is 0 on the first frame after a resume so the surface
       picks up exactly where it left off, and clamped so a tab-switch gap
       doesn't teleport it a third of a turn. */
    var dt = lastFrameMs ? (now - lastFrameMs) / 1000 : 0;
    lastFrameMs = now;
    if (dt > 1 / 20) dt = 1 / 20;

    if (autoRotate) {
      root.rotation.y += SPIN_RATE * dt;
      needsRender = true;
    }
    // update() returns true while damping is still settling after a drag.
    if (controls.update() || needsRender) {
      // Only the camera and root.rotation.y change which walls are behind the
      // data, and both already force a render — so this rides along here rather
      // than needing an invalidation path of its own.
      updateWalls();
      renderer.render(scene, camera);
      needsRender = false;
    }
    raf = requestAnimationFrame(frame);
  }

  function setActive(on) {
    active = !!on;
    if (active) { needsRender = true; ensureLoop(); }
    else { if (raf) cancelAnimationFrame(raf); raf = 0; running = false; }
  }

  /* ── api ────────────────────────────────────────────────────────────────── */

  /* `color` is optional: { lo, hi } from ivColorDomain(). HEIGHT always uses the
     full IV range so a front-week spike still reads as a spike; only the COLOUR
     ramp is clamped, so the bulk of the surface gets usable contrast instead of
     sitting in the bottom fifth of the ramp because one 1-DTE wing printed 64%.
     The tooltip reads IV off the height mapping, so it stays exact either way. */
  function setGrid(next, options) {
    var o = options || {};
    grid = next;
    surfaceMesh = null;
    meshLines = [];
    walls = [];
    disposeGroup(plot);
    disposeGroup(decor);
    if (!grid) { invalidate(); return; }

    ivLo = grid.ivMin;
    ivHi = grid.ivMax > grid.ivMin ? grid.ivMax : grid.ivMin + 0.01;
    colLo = o.color && Number.isFinite(o.color.lo) ? o.color.lo : ivLo;
    colHi = o.color && Number.isFinite(o.color.hi) && o.color.hi > colLo ? o.color.hi : ivHi;
    logLo = Math.log(Math.max(1, grid.dteMin));
    logHi = Math.log(Math.max(Math.max(1, grid.dteMin) + 1, grid.dteMax));

    // A silent same-symbol data refresh (see vol-page.js's auto-refresh)
    // calls setGrid again on data the user may be mid-orbit around; snapping
    // the auto-spin angle back to 0 there would read as a jump, not a live
    // tick. An ordinary symbol switch still resets it, which is the existing
    // and still-correct behaviour there.
    if (!o.keepRotation) root.rotation.y = 0;
    buildSurface();
    buildDecor();
    invalidate();
  }

  function resize() {
    var r = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  }

  function setAutoRotate(on) {
    autoRotate = !!on;
    if (autoRotate) invalidate();
  }

  function resetView() {
    camera.position.fromArray(HOME_EYE);
    controls.target.fromArray(HOME_TARGET);
    root.rotation.y = 0;
    controls.update();
    invalidate();
  }

  function dispose() {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    running = false;
    canvas.removeEventListener('pointermove', handleMove);
    canvas.removeEventListener('pointerleave', handleLeave);
    controls.dispose();
    disposeGroup(plot);
    disposeGroup(decor);
    renderer.dispose();
  }

  return {
    setGrid: setGrid,
    resize: resize,
    setActive: setActive,
    setAutoRotate: setAutoRotate,
    resetView: resetView,
    invalidate: invalidate,
    dispose: dispose,
  };
}
