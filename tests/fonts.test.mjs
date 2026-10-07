// Tests for the font option. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FONTS, fontData, DEFAULT_FONT } from '../lib/fonts.js';
import { computeLayout, resolveParams } from '../lib/layout.js';
import { prepareJob } from '../lib/job.js';

const bbox = (c) => {
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 1; i < c.length; i += 2) { y0 = Math.min(y0, c[i]); y1 = Math.max(y1, c[i]); }
  return [y0, y1];
};
/** Total width of the outline at height y (even-odd crossing of one contour). */
function widthAt(c, y) {
  const xs = [];
  for (let i = 0, j = c.length - 2; i < c.length; j = i, i += 2) {
    const xi = c[i], yi = c[i + 1], xj = c[j], yj = c[j + 1];
    if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  let w = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) w += xs[i + 1] - xs[i];
  return w;
}
const biggest = (shapes) => shapes.map((s) => s.outer).sort((a, b) => (bbox(b)[1] - bbox(b)[0]) - (bbox(a)[1] - bbox(a)[0]))[0];

test('two fonts are offered: Andika (default) and Bree Serif', () => {
  assert.deepEqual(Object.keys(FONTS), ['andika', 'serif']);
  assert.equal(DEFAULT_FONT, 'andika');
  assert.equal(fontData('serif').FONT.file, 'BreeSerif-Regular.ttf');
  assert.equal(fontData('serif').FONT.openscadName, 'Bree Serif:style=Regular');
  assert.equal(fontData('nonsense').id, 'andika'); // unknown ids fall back to the default
  assert.equal(fontData().id, 'andika');
});

test('serif font: the capital I has a bar at the top and a bar at the bottom', () => {
  const I = fontData('serif').GLYPHS.I.shapes[0].outer;
  const [y0, y1] = bbox(I), h = y1 - y0;
  const stem = widthAt(I, y0 + h * 0.5);
  for (const f of [0.02, 0.1]) assert.ok(widthAt(I, y0 + h * f) > 1.8 * stem, `bottom bar at ${f}`);
  for (const f of [0.9, 0.98]) assert.ok(widthAt(I, y0 + h * f) > 1.8 * stem, `top bar at ${f}`);
  assert.ok(widthAt(I, y0 + h * 0.3) < 1.05 * stem && widthAt(I, y0 + h * 0.7) < 1.05 * stem, 'plain stem between the bars');
});

test('serif font: the j has a line across the top of its stem (and so does the i)', () => {
  for (const ch of ['j', 'i']) {
    const stem = biggest(fontData('serif').GLYPHS[ch].shapes);
    const top = bbox(stem)[1];
    const flag = widthAt(stem, top - 0.02), below = widthAt(stem, top - 0.25);
    assert.ok(flag > 1.3 * below, `${ch}: top ${flag.toFixed(3)} em vs stem ${below.toFixed(3)} em`);
  }
  // Andika's j has no such line: the stem keeps one width to the top
  const a = biggest(fontData('andika').GLYPHS.j.shapes);
  assert.ok(widthAt(a, bbox(a)[1] - 0.02) < 1.1 * widthAt(a, bbox(a)[1] - 0.25));
});

test('both fonts: complete A-Z a-z, dots bridged, every other glyph one outer piece', () => {
  for (const id of Object.keys(FONTS)) {
    const { GLYPHS, FONT } = FONTS[id];
    assert.equal(Object.keys(GLYPHS).length, 52, id);
    assert.ok(FONT.capPerSize > 0.5 && FONT.capPerSize < 1.2, `${id} cap per size ${FONT.capPerSize}`);
    for (const [ch, g] of Object.entries(GLYPHS)) {
      if (ch === 'i' || ch === 'j') { assert.equal(g.shapes.length, 2, `${id} ${ch}`); assert.equal(g.bridges.length, 1, `${id} ${ch}`); }
      else { assert.equal(g.shapes.length, 1, `${id} ${ch}`); assert.equal(g.bridges.length, 0, `${id} ${ch}`); }
    }
  }
});

test('both fonts: margins are 2 mm, walls at least 3 mm, corner walls at least 1.2 mm', () => {
  for (const id of Object.keys(FONTS)) for (const name of ['Patrick', 'Ijay', 'Jiggy', 'WAVY', 'Quinn']) for (const h of [14, 40]) {
    const { params } = resolveParams({ letter_height: h });
    const layout = computeLayout(name, params, fontData(id));
    for (const side of ['left', 'right', 'top', 'bottom']) assert.ok(layout.margins[side] >= 2 - 1e-9, `${id} ${name} ${h} ${side} ${layout.margins[side]}`);
    assert.ok(Math.abs(layout.margins.left - 2) < 1e-9 && Math.abs(layout.margins.right - 2) < 1e-9, `${id} ${name} side margins`);
    assert.ok(layout.minWall >= 3 - 1e-6, `${id} ${name} ${h} wall ${layout.minWall}`);
    assert.ok(layout.cornerWall >= 1.2 - 1e-6, `${id} ${name} ${h} corner wall ${layout.cornerWall}`);
  }
});

test('the font option reaches the job and the .scad', () => {
  const a = prepareJob({ rawName: 'Ijay', caseStyle: 'first', printer: 'a1' });
  const s = prepareJob({ rawName: 'Ijay', caseStyle: 'first', printer: 'a1', font: 'serif' });
  assert.equal(a.font, 'andika'); assert.equal(s.font, 'serif');
  assert.equal(s.fontFile, 'BreeSerif-Regular.ttf');
  assert.equal(s.fontFamily, 'Bree Serif');
  assert.match(s.scad, /^use <fonts\/BreeSerif-Regular\.ttf>$/m);
  assert.match(s.scad, /^font = "Bree Serif:style=Regular";$/m);
  assert.match(s.scad, /font_size = letter_height \/ 0\.92\d+;/);
  assert.match(s.scad, /\["j", \[/); // the serif j keeps its dot bar
  assert.match(a.scad, /^use <fonts\/Andika-Bold\.ttf>$/m);
  assert.notEqual(a.layout.base.width, s.layout.base.width); // different letterforms, different layout
  assert.equal(s.layout.letters[0].ch, 'I');
});
