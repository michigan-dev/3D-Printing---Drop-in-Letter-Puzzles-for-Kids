// Unit tests for lib/layout.js. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeName, validateName, applyCase, clampHeightMm, inchesToMm, resolveParams,
  maxEdgeChamfer, computeLayout, planPlates, bedFor, maxFittingHeightMm, offsetContour, DEFAULTS,
  HEIGHT_MIN_MM, HEIGHT_MAX_MM, HEIGHT_STEP_MM, HEIGHT_DEFAULT_MM, glyphBBox, fontSizeFor,
} from '../lib/layout.js';
import { prepareJob } from '../lib/job.js';
import * as glyphData from '../lib/glyphs.js';

const layoutAtMm = (text, mm, user = {}) => {
  const { params } = resolveParams({ ...user, letter_height: mm });
  return { params, layout: computeLayout(text, params, glyphData) };
};
const layoutFor = (text, inches = 2, user = {}) => layoutAtMm(text, inchesToMm(inches), user);
const close = (a, b, tol = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b}, got ${a}`);

// ------------------------------------------------------------------ names

test('sanitize: "Mary-Jo O\'Neil" -> "MaryJoONeil" with a friendly message', () => {
  const r = sanitizeName("Mary-Jo O'Neil");
  assert.equal(r.name, 'MaryJoONeil');
  assert.equal(r.message, 'Spaces, apostrophes and hyphens are removed.');
});

test('sanitize: apostrophes and hyphens only', () => {
  assert.equal(sanitizeName("Ja'Nae-Lee").message, 'Apostrophes and hyphens are removed.');
});

test('sanitize: digits, symbols, curly apostrophes and accents', () => {
  assert.deepEqual(sanitizeName('Ava2!').name, 'Ava');
  assert.match(sanitizeName('Ava2!').message, /^Numbers and symbols are removed\.$/);
  assert.equal(sanitizeName('D’Andre').name, 'DAndre');
  const z = sanitizeName('Zoë');
  assert.equal(z.name, 'Zoe');
  assert.match(z.message, /accents/i);
});

test('sanitize: clean input has no message', () => {
  assert.deepEqual(sanitizeName('Emma'), { name: 'Emma', message: '', removed: [] });
});

test('validate: empty input is blocked', () => {
  assert.equal(validateName('').ok, false);
  assert.equal(validateName(sanitizeName('  -- 42 ').name).ok, false);
  assert.equal(prepareJob({ rawName: '', caseStyle: 'first', heightIn: 2, printer: 'a1' }).status, 'invalid-name');
});

test('validate: 12 letters allowed, 13+ blocked', () => {
  assert.equal(validateName('Abcdefghijkl').ok, true);
  assert.equal(validateName('Abcdefghijklm').ok, false);
  assert.match(validateName('Abcdefghijklm').error, /13 letters/);
  assert.equal(prepareJob({ rawName: 'Maximilianusz', caseStyle: 'first', heightIn: 2, printer: 'a1' }).status, 'invalid-name');
});

test('case style: ALL CAPS and First letter capital', () => {
  assert.equal(applyCase('emma', 'caps'), 'EMMA');
  assert.equal(applyCase('eMMA', 'first'), 'Emma');
  assert.equal(applyCase('MaryJoONeil', 'first'), 'Maryjooneil');
  assert.equal(applyCase('x', 'first'), 'X');
});

// ----------------------------------------------------------------- params

test('height defaults to 14 mm and clamps to 10-76.2 mm', () => {
  assert.equal(HEIGHT_DEFAULT_MM, 14);
  assert.equal(DEFAULTS.letter_height, 14);
  assert.equal(resolveParams().params.letter_height, 14);
  assert.equal(prepareJob({ rawName: 'Mia', caseStyle: 'first', printer: 'a1' }).heightMm, 14);
  assert.equal(clampHeightMm(2), HEIGHT_MIN_MM);
  assert.equal(clampHeightMm(500), HEIGHT_MAX_MM);
  assert.equal(clampHeightMm(63.5), 63.5);
  assert.equal(clampHeightMm('nonsense'), 14);
  assert.equal(resolveParams({ letter_height: 200 }).params.letter_height, 76.2);
  assert.equal(resolveParams({ letter_height: 1 }).params.letter_height, 10);
});

test('slider grid (10 mm + 0.2 mm steps) hits 14 mm, 1 in, 2 in and 3 in exactly', () => {
  for (const mm of [14, 25.4, 50.8, 76.2]) {
    const k = (mm - HEIGHT_MIN_MM) / HEIGHT_STEP_MM;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-9, `${mm} mm is off the grid`);
  }
  assert.equal(inchesToMm(2.5), 63.5);
});

test('edge chamfer is clamped below side_margin - 0.8 mm, with a note', () => {
  assert.ok(maxEdgeChamfer(2) < 2 - 0.8);
  const r = resolveParams({ edge_chamfer: 1.9 });
  assert.ok(r.params.edge_chamfer < DEFAULTS.side_margin - 0.8);
  assert.equal(r.params.edge_chamfer, 1.1);
  assert.match(r.notes.edge_chamfer, /Capped at 1\.1 mm/);
  assert.equal(resolveParams({ edge_chamfer: 1 }).notes.edge_chamfer, undefined);
});

test('letter chamfer: default 1 mm; capped at 7.5% of the cap height with a note when the letters are tiny', () => {
  assert.equal(DEFAULTS.letter_chamfer, 1);
  for (const mm of [14, 50.8, 76.2]) {
    const r = resolveParams({ letter_height: mm });
    assert.equal(r.params.letter_chamfer, 1, `${mm} mm`);
    assert.equal(r.notes.letter_chamfer, undefined);
  }
  const tiny = resolveParams({ letter_height: 10 });
  assert.equal(tiny.params.letter_chamfer, 0.75);
  assert.match(tiny.notes.letter_chamfer, /Capped at 0\.75 mm/);
  assert.equal(resolveParams({ letter_height: 76.2, letter_chamfer: 5 }).params.letter_chamfer, 1);
  assert.equal(DEFAULTS.letter_bottom_chamfer, 0.4);
});

test('vertical-corner chamfer follows the letter chamfer but stays under 3.5% of the cap height', () => {
  // 1 mm at 14 mm would delete thin strokes (measured on Andika Bold); it is 1 mm only from 28.6 mm up
  assert.equal(resolveParams({ letter_height: 14 }).params.letter_corner_chamfer, 0.49);
  assert.equal(resolveParams({ letter_height: 10 }).params.letter_corner_chamfer, 0.35);
  assert.equal(resolveParams({ letter_height: 50.8 }).params.letter_corner_chamfer, 1);
  assert.equal(resolveParams({ letter_height: 76.2, letter_chamfer: 0.5 }).params.letter_corner_chamfer, 0.5);
  assert.equal(resolveParams({ letter_height: 76.2, letter_chamfer: 0 }).params.letter_corner_chamfer, 0);
});

test('fit clearance defaults to 2 mm per side', () => {
  assert.equal(DEFAULTS.fit_clearance, 2);
  assert.equal(resolveParams().params.fit_clearance, 2);
  assert.equal(resolveParams({ fit_clearance: 0.3 }).params.fit_clearance, 0.3);
});

test('advanced values are clamped to safe ranges', () => {
  const r = resolveParams({ fit_clearance: 9, pocket_depth: 6, letter_thickness: 5 });
  assert.equal(r.params.fit_clearance, 3);
  assert.equal(r.params.letter_thickness, 7); // must stand at least 1 mm proud
  assert.ok(r.notes.fit_clearance && r.notes.letter_thickness);
  assert.equal(r.params.base_thickness, 6 + 3);
});

// ------------------------------------------------------------- geometry

test('miter offset matches OpenSCAD offset(delta): square grows by delta, sharp tip by delta/sin(half angle)', () => {
  const sq = offsetContour([0, 0, 10, 0, 10, 10, 0, 10], 1, 100);
  const xs = sq.filter((_, i) => i % 2 === 0), ys = sq.filter((_, i) => i % 2 === 1);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [-1, 11, -1, 11]);
  // OpenSCAD: offset(delta=1) polygon([[0,0],[100,0],[0,17.6]]) reaches x = 111.451
  const tri = offsetContour([0, 0, 100, 0, 0, 17.6], 1, 1000);
  close(Math.max(...tri.filter((_, i) => i % 2 === 0)), 111.451, 0.001, 'miter tip');
});

test('side margin is exactly 2 mm on all four sides when no corner wall is at risk', () => {
  for (const [name, inches] of [['Jiggy', 2.5], ['Lily', 2], ['Oscar', 2], ['Jiggy', 2]]) {
    const { layout } = layoutFor(name, inches);
    assert.deepEqual(layout.grow, { top: 0, bottom: 0 }, name);
    for (const side of ['left', 'right', 'top', 'bottom']) close(layout.margins[side], 2, 1e-9, `${name} ${side}`);
  }
});

test('square corners near a corner chamfer: base grows in Y, left/right stay exactly 2 mm, corner wall >= 1.2 mm', () => {
  const { layout, params } = layoutFor('EMMA', 3);
  close(layout.margins.left, 2, 1e-9); close(layout.margins.right, 2, 1e-9);
  assert.ok(layout.grow.top > 0 && layout.grow.bottom > 0);
  close(layout.margins.top, 2 + layout.grow.top, 1e-9);
  close(layout.margins.bottom, 2 + layout.grow.bottom, 1e-9);
  assert.ok(layout.cornerWall >= params.corner_min_wall - 1e-9, `corner wall ${layout.cornerWall}`);
  // with a small corner chamfer nothing needs to grow and all four margins are exactly 2 mm
  const small = layoutFor('EMMA', 3, { corner_chamfer: 1 }).layout;
  assert.deepEqual(small.grow, { top: 0, bottom: 0 });
  for (const side of ['left', 'right', 'top', 'bottom']) close(small.margins[side], 2, 1e-9, side);
});

test('no pocket-to-pocket wall is under 3 mm (many names, all heights, all clearances)', () => {
  const names = ['Mia', 'EMMA', 'Jiggy', 'Bartholomew', 'Wyatt', 'Ivy', 'jJjJ', 'AVAVAV', 'Lily', 'Kyle', 'Quinn', 'iiii'];
  for (const name of names) for (const inches of [2, 3]) for (const fit of [0.2, 0.3, 0.4]) {
    const { layout } = layoutFor(name, inches, { fit_clearance: fit });
    assert.ok(layout.minWall >= 3 - 1e-6, `${name} ${inches}in fit ${fit}: wall ${layout.minWall}`);
    assert.ok(layout.cornerWall >= 1.2 - 1e-6, `${name}: corner wall ${layout.cornerWall}`);
    for (const side of ['left', 'right', 'top', 'bottom']) assert.ok(layout.margins[side] >= 2 - 1e-9);
  }
});

test('i and j dot bridges are 5 mm wide, and the pocket and base are sized around them', () => {
  assert.equal(DEFAULTS.bridge_width, 5);
  const { params } = resolveParams({});
  const scale = fontSizeFor(params.letter_height, glyphData.FONT);
  for (const ch of 'ij') {
    const g = glyphData.GLYPHS[ch];
    const stemOnly = glyphBBox({ ...g, bridges: [] }, scale);
    const [x0, , x1] = glyphBBox(g, scale, 5);
    assert.ok(x1 - x0 >= 5 - 1e-9, `${ch}: bar makes the letter ${x1 - x0} mm wide`);
    assert.ok(x1 - x0 > stemOnly[2] - stemOnly[0], `${ch}: wider than the plain letter`);
  }
  // "Iji": the opening of each dotted letter spans its bar, margins stay 2 mm and walls >= 3 mm
  const { layout } = layoutAtMm('ijiji', 14);
  assert.ok(layout.letters.every((L) => L.bbox[2] - L.bbox[0] >= 5 - 1e-9));
  for (const side of ['left', 'right', 'top', 'bottom']) close(layout.margins[side], 2, 1e-9, side);
  assert.ok(layout.minWall >= 3 - 1e-6, `wall ${layout.minWall}`);
  // a narrower bar gives a narrower base: the base really is sized from the bar
  const narrow = layoutAtMm('ijiji', 14, { bridge_width: 2 }).layout;
  assert.ok(layout.base.width > narrow.base.width + 2);
});

test('letters share one baseline and descenders fit inside the base', () => {
  const { layout, params } = layoutFor('Jiggy', 2.5);
  const ys = new Set(layout.letters.map((L) => L.y));
  assert.equal(ys.size, 1);
  const lowest = Math.min(...layout.letters.map((L) => L.y + L.bbox[1]));
  assert.ok(lowest > params.side_margin + params.edge_chamfer, 'descender inside base');
  assert.ok(layout.letters.some((L) => L.bbox[1] < -5), 'g/j/y go below the baseline');
});

test('letters keep at least their advance-width spacing', () => {
  const { layout } = layoutFor('Mia', 2);
  for (let k = 1; k < layout.letters.length; k++) {
    assert.ok(layout.letters[k].x - layout.letters[k - 1].x >= layout.letters[k - 1].advance - 1e-9);
  }
});

// -------------------------------------------------------------- bed fit

function assertPlatesValid(plan, bed, params, letterCount) {
  let letters = 0, bases = 0;
  for (const pl of plan.plates) {
    for (const q of pl.placements) {
      const [x0, y0, x1, y1] = q.rect;
      assert.ok(x0 >= params.bed_margin - 1e-6 && y0 >= params.bed_margin - 1e-6, 'inside bed');
      assert.ok(x1 <= bed.width - params.bed_margin + 1e-6 && y1 <= bed.depth - params.bed_margin + 1e-6, 'inside bed');
      if (q.kind === 'base') bases++; else letters++;
    }
    const r = pl.placements.map((q) => q.rect);
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      const gap = Math.max(r[j][0] - r[i][2], r[i][0] - r[j][2], r[j][1] - r[i][3], r[i][1] - r[j][3]);
      assert.ok(gap >= params.part_spacing - 1e-6, `parts ${gap} mm apart`);
    }
  }
  assert.equal(bases, 1);
  assert.equal(letters, letterCount);
}

test('bed fit: a short name at 2 in fits one Bambu A1 plate', () => {
  const bed = bedFor('a1');
  const { layout, params } = layoutFor('Mia', 2);
  const plan = planPlates(layout, bed, params);
  assert.equal(plan.ok, true);
  assert.equal(plan.plates.length, 1);
  assertPlatesValid(plan, bed, params, 3);
});

test('bed fit: a 12-letter name at 3 in triggers the too-big warning with the max height that fits', () => {
  for (const printer of ['a1', 'mk4']) {
    const job = prepareJob({ rawName: 'Christabella', caseStyle: 'first', heightIn: 3, printer });
    assert.equal(job.text.length, 12);
    assert.equal(job.plan.ok, false);
    assert.equal(job.plan.reason, 'base-too-big');
    assert.ok(job.plan.over > 0);
    assert.equal(job.status, 'too-big');
    assert.ok(job.maxHeightMm >= 10 && job.maxHeightMm < 76.2);
    const retry = prepareJob({ rawName: 'Christabella', caseStyle: 'first', heightMm: job.maxHeightMm, printer });
    assert.equal(retry.status, 'ready');
  }
});

test('bed fit: nothing fits when even 10 mm letters are too long for the bed', () => {
  const job = prepareJob({ rawName: 'Christabella', caseStyle: 'first', heightMm: 40, printer: 'custom', customBed: { width: 100, depth: 100 } });
  assert.equal(job.status, 'nothing-fits');
  assert.equal(job.maxHeightMm, null);
  assert.equal(job.minHeightMm, 10);
  assert.ok(job.widthAtMin > 94);
});

test('bed fit: too big at 3 in offers the tallest height that fits, and one step more does not', () => {
  const job = prepareJob({ rawName: 'EMMA', caseStyle: 'caps', heightIn: 3, printer: 'a1' });
  assert.equal(job.status, 'too-big');
  assert.ok(job.maxHeightMm > 50 && job.maxHeightMm < 76.2, `max ${job.maxHeightMm}`);
  const at = (mm) => prepareJob({ rawName: 'EMMA', caseStyle: 'caps', heightMm: mm, printer: 'a1', withScad: false }).status;
  assert.equal(at(job.maxHeightMm), 'ready');
  assert.equal(at(Math.round((job.maxHeightMm + HEIGHT_STEP_MM) * 10) / 10), 'too-big');
  assert.equal(maxFittingHeightMm('Mia', {}, bedFor('a1'), glyphData), 76.2);
});

test('long name: base turned 45 degrees to fit, alone on plate 1; letters on their own plate', () => {
  const bed = bedFor('a1');
  const { layout, params } = layoutAtMm('EMMA', 60);
  assert.ok(layout.base.width > bed.width - 2 * params.bed_margin, 'too long to lie straight');
  const plan = planPlates(layout, bed, params);
  assert.equal(plan.ok, true);
  assert.equal(plan.plates.length, 2);
  const [one, two] = plan.plates;
  assert.deepEqual(one.placements.map((q) => [q.kind, q.rot]), [['base', 45]]);
  assert.equal(one.hasBase, true); assert.equal(one.letterCount, 0);
  assert.equal(two.hasBase, false); assert.equal(two.letterCount, 4);
  assertPlatesValid(plan, bed, params, 4);
  // the same name that fits straight is not turned
  const small = layoutAtMm('EMMA', 30);
  const plan2 = planPlates(small.layout, bed, small.params);
  assert.equal(plan2.plates.length, 1);
  assert.equal(plan2.plates[0].placements.find((q) => q.kind === 'base').rot, 0);
  // too big even turned: refused with the size of the miss
  const huge = layoutAtMm('EMMA', 70);
  const bad = planPlates(huge.layout, bed, huge.params);
  assert.equal(bad.ok, false);
  assert.ok(bad.over > 0);
});

test('job names the plates: base / letters files for a split, one plain file otherwise', () => {
  const split = prepareJob({ rawName: 'EMMA', caseStyle: 'caps', heightMm: 60, printer: 'a1', withScad: false });
  assert.equal(split.status, 'ready');
  assert.deepEqual(split.plan.plates.map((p) => [p.file, p.label]), [
    ['name-puzzle-emma-base.stl', 'Base STL'], ['name-puzzle-emma-letters.stl', 'Letters STL']]);
  const one = prepareJob({ rawName: 'Emma', caseStyle: 'first', printer: 'a1', withScad: false });
  assert.deepEqual(one.plan.plates.map((p) => p.file), ['name-puzzle-emma.stl']);
});

test('bed fit: base fits but letters do not -> split across plates', () => {
  // Lily at 3 in: the 116 mm deep base plus a 'y' (descender) is deeper than the MK4's 210 mm bed
  const bed = bedFor('mk4');
  const { layout, params } = layoutFor('Lily', 3);
  const plan = planPlates(layout, bed, params);
  assert.equal(plan.ok, true);
  assert.equal(plan.plates.length, 2);
  assert.ok(plan.plates[0].hasBase && !plan.plates[1].hasBase);
  assertPlatesValid(plan, bed, params, 4);
  // the same puzzle fits one plate on the larger A1 bed
  assert.equal(planPlates(layout, bedFor('a1'), params).plates.length, 1);
});

test('bed fit: custom bed taller than wide turns the base a quarter turn', () => {
  const bed = bedFor('custom', { width: 120, depth: 400 });
  const { layout, params } = layoutFor('Mia', 2);
  const plan = planPlates(layout, bed, params);
  assert.equal(plan.ok, true);
  assert.equal(plan.plates[0].placements.find((q) => q.kind === 'base').rot, 90);
  assertPlatesValid(plan, bed, params, 3);
});

test('custom bed size is clamped to 100-1000 mm', () => {
  assert.deepEqual([bedFor('custom', { width: 5, depth: 5000 }).width, bedFor('custom', { width: 5, depth: 5000 }).depth], [100, 1000]);
});
