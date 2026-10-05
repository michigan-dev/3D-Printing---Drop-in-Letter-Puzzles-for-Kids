// Turns the form inputs into everything a build needs: the cleaned name,
// resolved parameters, layout, bed plan and .scad source. Pure, so the
// website and the node test harness prepare jobs identically.

import {
  sanitizeName, validateName, applyCase, resolveParams, computeLayout, bedFor,
  planPlates, maxFittingHeightMm, inchesToMm, clampHeightMm, HEIGHT_MIN_MM,
} from './layout.js';
import { generateScad } from './scad.js';
import { FONT, GLYPHS } from './glyphs.js';

export const GLYPH_DATA = { FONT, GLYPHS };

/**
 * @param {object} input
 * @param {string} input.rawName
 * @param {'caps'|'first'} input.caseStyle
 * @param {number} [input.heightMm]        cap height from the slider, 10-76.2 (default 14)
 * @param {number} [input.heightIn]        same, in inches (used when heightMm is not given)
 * @param {string} input.printer           'a1' | 'mk4' | 'custom'
 * @param {{width:number, depth:number}} [input.customBed]
 * @param {object} [input.advanced]        fit_clearance, letter_thickness, ...
 * @param {boolean} [input.withScad=true]
 */
export function prepareJob(input) {
  const clean = sanitizeName(input.rawName);
  const check = validateName(clean.name);
  const text = applyCase(clean.name, input.caseStyle);
  const heightMm = clampHeightMm(input.heightMm ?? (input.heightIn !== undefined ? inchesToMm(input.heightIn) : undefined));
  const { params, notes } = resolveParams({ ...(input.advanced || {}), letter_height: heightMm });
  const bed = bedFor(input.printer, input.customBed);
  const result = { text, sanitizeMessage: clean.message, nameError: check.error, heightMm, params, notes, bed };
  if (!check.ok) return { ...result, status: 'invalid-name' };

  const layout = computeLayout(text, params, GLYPH_DATA);
  const plan = planPlates(layout, bed, params);
  if (!plan.ok) {
    const maxHeightMm = maxFittingHeightMm(text, input.advanced || {}, bed, GLYPH_DATA);
    const smallest = resolveParams({ ...(input.advanced || {}), letter_height: HEIGHT_MIN_MM }).params;
    const widthAtMin = heightMm === HEIGHT_MIN_MM ? layout.base.width : computeLayout(text, smallest, GLYPH_DATA, { report: false }).base.width;
    return { ...result, layout, plan, status: maxHeightMm ? 'too-big' : 'nothing-fits', maxHeightMm, minHeightMm: HEIGHT_MIN_MM, widthAtMin };
  }
  nameThePlates(text, plan.plates);
  const scad = input.withScad === false ? '' : generateScad({
    text, params, layout, plan, bed, font: FONT, glyphs: GLYPHS,
    generatedOn: input.generatedOn || '',
  });
  return { ...result, layout, plan, scad, fontName: FONT.openscadName, status: 'ready' };
}

/** File name stem: name-puzzle-emma */
export function fileStem(text) {
  return `name-puzzle-${text.toLowerCase()}`;
}

/**
 * Give each plate a file name and a button label. One plate is simply the puzzle;
 * with several, a plate holding only the base or only letters says so.
 */
function nameThePlates(text, plates) {
  const stem = fileStem(text);
  const letterOnly = plates.filter((pl) => !pl.hasBase).length;
  let seen = 0;
  for (const pl of plates) {
    if (plates.length === 1) {
      pl.file = `${stem}.stl`;
      pl.label = 'Download STL';
    } else if (pl.hasBase && pl.letterCount === 0) {
      pl.file = `${stem}-base.stl`;
      pl.label = 'Base STL';
    } else if (!pl.hasBase) {
      seen++;
      pl.file = letterOnly === 1 ? `${stem}-letters.stl` : `${stem}-letters${seen}.stl`;
      pl.label = letterOnly === 1 ? 'Letters STL' : `Letters STL ${seen}`;
    } else {
      pl.file = `${stem}-plate${pl.number}.stl`;
      pl.label = `Plate ${pl.number} STL`;
    }
  }
}
