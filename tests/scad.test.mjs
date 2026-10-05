// Unit tests for lib/scad.js. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareJob } from '../lib/job.js';

const job = prepareJob({
  rawName: 'Jiggy', caseStyle: 'first', heightIn: 2.5, printer: 'a1',
  advanced: { fit_clearance: 0.25, edge_chamfer: 0.8, corner_chamfer: 5 },
});
const scad = job.scad;
const value = (name) => {
  const m = scad.match(new RegExp(`^${name} = ([^;]+);`, 'm'));
  assert.ok(m, `${name} not found`);
  return m[1];
};

test('job is ready and the .scad is generated', () => {
  assert.equal(job.status, 'ready');
  assert.match(scad, /^\/\/ Name Puzzle Maker: drop-in letter puzzle for "Jiggy"/);
});

test('.scad contains the expected parameter values', () => {
  assert.equal(value('letter_height'), '63.5');
  assert.equal(value('letter_thickness'), '8');
  assert.equal(value('pocket_depth'), '5');
  assert.equal(value('base_floor'), '3');
  assert.equal(value('base_thickness'), 'pocket_depth + base_floor');
  assert.equal(value('fit_clearance'), '0.25');
  assert.equal(value('lead_in'), '0.5');
  assert.equal(value('corner_chamfer'), '5');
  assert.equal(value('edge_chamfer'), '0.8');
  assert.equal(value('bottom_chamfer'), '0.4');
  assert.equal(value('font'), '"Andika:style=Bold"');
  assert.equal(value('overcut'), '0.01');
  assert.match(value('font_size'), /^letter_height \/ 0\.99\d+$/);
});

test('.scad has 14 mm height, 2 mm clearance, letter chamfers (faces and vertical corners) and a 5 mm bridge', () => {
  const def = prepareJob({ rawName: 'Mia', caseStyle: 'first', printer: 'a1' }).scad;
  assert.match(def, /^letter_height = 14;/m);
  assert.match(def, /^fit_clearance = 2;/m);
  assert.match(def, /^letter_chamfer = 1;/m);
  assert.match(def, /^letter_corner_chamfer = 0\.49;/m);
  assert.match(def, /offset\(delta = c, chamfer = true\) offset\(delta = -c\)/);
  // pockets use the original outline, letters the corner-chamfered one
  assert.match(def, /offset\(delta = fit_clearance\) glyph\(letters\[i\]\[0\]\)/);
  assert.match(def, /linear_extrude\(height = letter_thickness - bot - top\) letter_outline\(ch\)/);
  assert.match(def, /^letter_bottom_chamfer = 0\.4;/m);
  assert.match(def, /^bridge_width = 5;/m);
  assert.match(def, /^chamfer_step = 0\.1;/m);
  assert.match(def, /offset\(delta = -\(top - \(k \+ 0\.5\) \* top \/ nt\)\) letter_outline\(ch\)/);
  assert.match(def, /module bar\(b, k = 0\)/);
  assert.match(def, /for \(b = \[for \(e = glyph_bridges\) if \(e\[0\] == ch\) e\[1\]\]\) bar\(b, c\)/); // chamfered bar on letters
  assert.match(def, /for \(b = \[for \(e = glyph_bridges\) if \(e\[0\] == ch\) e\[1\]\]\) bar\(b\)/); // square bar in pockets
  assert.doesNotMatch(def, /minkowski/);
});

test('.scad base size and letter table match the layout', () => {
  const [w, d] = value('base_size').slice(1, -1).split(',').map(Number);
  assert.ok(Math.abs(w - job.layout.base.width) < 1e-4 && Math.abs(d - job.layout.base.depth) < 1e-4);
  for (const L of job.layout.letters) {
    assert.ok(scad.includes(`["${L.ch}", ${Math.round(L.x * 1e4) / 1e4}, ${Math.round(L.y * 1e4) / 1e4}]`), L.ch);
  }
});

test('.scad loads the bundled font and uses offset(delta) for pockets', () => {
  assert.match(scad, /^use <fonts\/Andika-Bold\.ttf>$/m);
  assert.match(scad, /offset\(delta = fit_clearance\) glyph/);
  assert.doesNotMatch(scad, /minkowski/);
  // pockets cut slightly above the top face to avoid coincident faces
  assert.match(scad, /linear_extrude\(height = pocket_depth \+ overcut\)/);
});

test('.scad bridges the dots of i and j (only letters that are used)', () => {
  const table = scad.slice(scad.indexOf('glyph_bridges = ['), scad.indexOf('];', scad.indexOf('glyph_bridges = [')));
  assert.match(table, /\["i", \[/);
  assert.doesNotMatch(table, /\["j", \[/); // "Jiggy" has a capital J, which has no dot
  const jj = prepareJob({ rawName: 'jj', caseStyle: 'caps', heightIn: 2, printer: 'a1' });
  assert.doesNotMatch(jj.scad.slice(jj.scad.indexOf('glyph_bridges')), /\["j"/); // caps: no dots at all
});

test('.scad lists every plate as a selectable part', () => {
  assert.match(scad, /^part = "plate_1"; \/\/ \[assembled, base, letters, plate_1\]$/m);
  const multi = prepareJob({ rawName: 'Lily', caseStyle: 'first', heightIn: 3, printer: 'mk4' });
  assert.equal(multi.status, 'ready');
  assert.match(multi.scad, /plate_1, plate_2/);
  assert.equal((multi.scad.match(/\/\/ plate \d+/g) || []).length, multi.plan.plates.length);
});

test('.scad escapes nothing dangerous: names are letters only', () => {
  const j = prepareJob({ rawName: 'Bo"b\\', caseStyle: 'first', heightIn: 2, printer: 'a1' });
  assert.equal(j.text, 'Bob');
  assert.doesNotMatch(j.scad, /Bo"b/);
});
