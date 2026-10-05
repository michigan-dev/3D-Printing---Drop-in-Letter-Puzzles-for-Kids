#!/usr/bin/env node
// Builds lib/glyphs.js: outlines + advance widths for A-Z and a-z, taken from
// OpenSCAD itself (same wasm build, same font, same $fn as the generated .scad),
// so the JavaScript layout measures exactly the shapes OpenSCAD will cut.
//
// It also finds glyphs that are not one connected piece (the dots on i and j,
// plus anything else) and designs a bridge for each island: a rectangle as wide
// as the stem underneath it, joining the island to the body. It then re-renders
// every bridged glyph in OpenSCAD and fails if any glyph is still in pieces.
//
// Usage: node tools/build-glyphs.mjs

import fs from 'node:fs';
import { loadNodeRunner, parseSvgContours, repoPath } from '../tests/node-runner.mjs';

const FONT_FILE = 'Andika-Bold.ttf';
const FONT_NAME = 'Andika:style=Bold';
const TEXT_FN = 48; // curve segments; 0.08 mm worst-case deviation at 3 in
const SIZE = 100; // export size, normalised back to size = 1
const PITCH = 400; // spacing between glyphs in the verification render
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const run = await loadNodeRunner();
const dec = new TextDecoder();

// ---------- geometry helpers ----------
function area(c) {
  let a = 0;
  for (let i = 0; i < c.length; i += 2) {
    const j = (i + 2) % c.length;
    a += c[i] * c[j + 1] - c[j] * c[i + 1];
  }
  return a / 2;
}
function bbox(c) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < c.length; i += 2) {
    x0 = Math.min(x0, c[i]); x1 = Math.max(x1, c[i]);
    y0 = Math.min(y0, c[i + 1]); y1 = Math.max(y1, c[i + 1]);
  }
  return [x0, y0, x1, y1];
}
function inside(x, y, c) {
  let ins = false;
  for (let i = 0, j = c.length - 2; i < c.length; j = i, i += 2) {
    const xi = c[i], yi = c[i + 1], xj = c[j], yj = c[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
/** x-intervals where the horizontal line at y is inside contour c */
function slice(c, y) {
  const xs = [];
  for (let i = 0, j = c.length - 2; i < c.length; j = i, i += 2) {
    const xi = c[i], yi = c[i + 1], xj = c[j], yj = c[j + 1];
    if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

/** Group contours into shapes: each outer contour with the holes directly inside it. */
function toShapes(contours) {
  const info = contours.map((c) => ({ c, depth: 0, parent: -1, absA: Math.abs(area(c)) }));
  info.forEach((a, i) => {
    let best = -1;
    info.forEach((b, j) => {
      if (i === j || b.absA <= a.absA) return;
      if (inside(a.c[0], a.c[1], b.c)) {
        a.depth++;
        if (best < 0 || b.absA < info[best].absA) best = j;
      }
    });
    a.parent = best;
  });
  const shapes = [];
  const idx = new Map();
  info.forEach((a, i) => {
    if (a.depth % 2 === 0) {
      idx.set(i, shapes.length);
      shapes.push({ outer: orient(a.c, +1), holes: [] });
    }
  });
  info.forEach((a) => {
    if (a.depth % 2 === 1) shapes[idx.get(a.parent)].holes.push(orient(a.c, -1));
  });
  return shapes;
}
function orient(c, sign) {
  if (Math.sign(area(c)) === sign) return c;
  const r = [];
  for (let i = c.length - 2; i >= 0; i -= 2) r.push(c[i], c[i + 1]);
  return r;
}

/** Bridge each island (any extra outer contour) down to the body below it. */
function designBridges(ch, shapes) {
  if (shapes.length <= 1) return [];
  const byArea = [...shapes].sort((a, b) => Math.abs(area(b.outer)) - Math.abs(area(a.outer)));
  const body = byArea[0];
  const bridges = [];
  for (const island of byArea.slice(1)) {
    const [ix0, iy0, ix1, iy1] = bbox(island.outer);
    const cx = (ix0 + ix1) / 2;
    // Top of the body directly under the island centre.
    const [, by0, , by1] = bbox(body.outer);
    let top = by0;
    for (let y = by1; y > by0; y -= 0.001) {
      if (slice(body.outer, y).some(([a, b]) => a <= cx && cx <= b)) { top = y; break; }
    }
    if (top >= iy0) throw new Error(`${ch}: island is not above the body; handle by hand`);
    const stemAt = (y) => slice(body.outer, y).find(([a, b]) => a <= cx && cx <= b);
    const w0 = stemAt(top - 0.01);
    const w = w0[1] - w0[0];
    const [sx0, sx1] = stemAt(top - 0.5 * w); // below any slanted cut at the stem top
    bridges.push([round(sx0), round(top - w), round(sx1), round(iy0 + 0.5 * (iy1 - iy0))]);
  }
  return bridges;
}
const round = (v) => Math.round(v * 1e5) / 1e5;
const roundArr = (c) => c.map(round);

// ---------- 1. advance widths via textmetrics() ----------
const metricsScad =
  `use <fonts/${FONT_FILE}>\n` +
  [...CHARS].map((c) => `echo("ADV", "${c}", textmetrics("${c}", size=1, font="${FONT_NAME}").advance[0]);`).join('\n') +
  `\necho("FONT", fontmetrics(size=1, font="${FONT_NAME}"));\nsquare(1);`;
const m = await run(metricsScad, 'svg', ['--enable=textmetrics']);
if (!m.ok) throw new Error(m.log.join('\n'));
const adv = {};
for (const l of m.log) {
  const mm = l.match(/ECHO: "ADV", "(.)", ([\d.e-]+)/);
  if (mm) adv[mm[1]] = parseFloat(mm[2]);
}
const fontLine = m.log.find((l) => l.includes('"FONT"'));
if (!fontLine.includes('family = "Andika"')) throw new Error('Font did not load: ' + fontLine);

// ---------- 2. outlines via SVG export ----------
// One render per glyph, at the origin: the SVG export keeps 6 significant
// digits, so coordinates must stay small to keep 1e-5 em precision.
const perChar = [];
for (const ch of CHARS) {
  const o = await run(`use <fonts/${FONT_FILE}>\ntext("${ch}", size=${SIZE}, font="${FONT_NAME}", halign="left", valign="baseline", $fn=${TEXT_FN});`, 'svg');
  if (!o.ok) throw new Error(o.log.join('\n'));
  perChar.push(parseSvgContours(dec.decode(o.output)).map((c) => c.map((v) => v / SIZE)));
}

const glyphs = {};
const report = [];
[...CHARS].forEach((ch, i) => {
  const shapes = toShapes(perChar[i]);
  const bridges = designBridges(ch, shapes);
  if (bridges.length) report.push(`${ch}: ${shapes.length} pieces -> ${bridges.length} bridge(s)`);
  glyphs[ch] = {
    adv: round(adv[ch]),
    shapes: shapes.map((s) => ({ outer: roundArr(s.outer), holes: s.holes.map(roundArr) })),
    bridges,
  };
});

// ---------- 3. verify: every bridged glyph is one piece in OpenSCAD ----------
const verifyScad =
  `use <fonts/${FONT_FILE}>\n` +
  [...CHARS].map((c, i) => {
    const b = glyphs[c].bridges.map(([x0, y0, x1, y1]) => `translate([${x0 * SIZE},${y0 * SIZE}]) square([${(x1 - x0) * SIZE},${(y1 - y0) * SIZE}]);`).join(' ');
    return `translate([${i * PITCH},0]) union() { text("${c}", size=${SIZE}, font="${FONT_NAME}", halign="left", valign="baseline", $fn=${TEXT_FN}); ${b} }`;
  }).join('\n');
const v = await run(verifyScad, 'svg');
const vc = parseSvgContours(dec.decode(v.output));
const outerCount = [...CHARS].map(() => 0);
for (const s of toShapes(vc)) outerCount[Math.floor((bbox(s.outer)[0] + PITCH / 4) / PITCH)]++;
const broken = [...CHARS].filter((c, i) => outerCount[i] !== 1);
if (broken.length) throw new Error('Still in pieces after bridging: ' + broken.join(' '));

// Cap height: the flat top of "H" (size = 1).
const capPerSize = round(bbox(glyphs.H.shapes[0].outer)[3]);

const header = `// GENERATED by tools/build-glyphs.mjs from fonts/${FONT_FILE} using the
// vendored OpenSCAD wasm build. Do not edit by hand: re-run the tool instead.
// Units: OpenSCAD text() with size = 1, pen origin at (0, 0) on the baseline.
// shapes: outer contours (counter-clockwise) with their holes (clockwise).
// bridges: [x0, y0, x1, y1] rectangles that join islands (i/j dots) to the stem.
`;
const body = `${header}
export const FONT = ${JSON.stringify({ file: FONT_FILE, openscadName: FONT_NAME, cssFamily: 'Andika', textFn: TEXT_FN, capPerSize })};

export const GLYPHS = ${JSON.stringify(glyphs)};
`;
fs.writeFileSync(repoPath('lib/glyphs.js'), body);
console.log(`Wrote lib/glyphs.js (${(body.length / 1024).toFixed(0)} KB), cap height per size = ${capPerSize}`);
console.log('Islands found and bridged:\n  ' + (report.join('\n  ') || 'none'));
console.log('Verified in OpenSCAD: all 52 glyphs are a single piece after bridging.');
