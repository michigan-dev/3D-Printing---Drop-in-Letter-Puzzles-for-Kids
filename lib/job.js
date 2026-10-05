// Turns the form inputs into everything a build needs: the cleaned name,
// resolved parameters, layout, bed plan and .scad source. Pure, so the
// website and the node test harness prepare jobs identically.

import {
  sanitizeName, validateName, applyCase, resolveParams, computeLayout, bedFor,
  planPlates, maxFittingHeightIn, inchesToMm, snapHeightIn,
} from './layout.js';
import { generateScad } from './scad.js';
import { FONT, GLYPHS } from './glyphs.js';

export const GLYPH_DATA = { FONT, GLYPHS };

/**
 * @param {object} input
 * @param {string} input.rawName
 * @param {'caps'|'first'} input.caseStyle
 * @param {number} input.heightIn          slider value, 2.0-3.0
 * @param {string} input.printer           'a1' | 'mk4' | 'custom'
 * @param {{width:number, depth:number}} [input.customBed]
 * @param {object} [input.advanced]        fit_clearance, letter_thickness, ...
 * @param {boolean} [input.withScad=true]
 */
export function prepareJob(input) {
  const clean = sanitizeName(input.rawName);
  const check = validateName(clean.name);
  const text = applyCase(clean.name, input.caseStyle);
  const heightIn = snapHeightIn(input.heightIn);
  const { params, notes } = resolveParams({ ...(input.advanced || {}), letter_height: inchesToMm(heightIn) });
  const bed = bedFor(input.printer, input.customBed);
  const result = { text, sanitizeMessage: clean.message, nameError: check.error, heightIn, params, notes, bed };
  if (!check.ok) return { ...result, status: 'invalid-name' };

  const layout = computeLayout(text, params, GLYPH_DATA);
  const plan = planPlates(layout, bed, params);
  if (!plan.ok) {
    const maxIn = maxFittingHeightIn(text, input.advanced || {}, bed, GLYPH_DATA);
    const minLayout = heightIn === 2 ? layout : computeLayout(text, resolveParams({ ...(input.advanced || {}), letter_height: inchesToMm(2) }).params, GLYPH_DATA, { report: false });
    return { ...result, layout, plan, status: maxIn ? 'too-big' : 'nothing-fits', maxHeightIn: maxIn, widthAtMin: minLayout.base.width };
  }
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

export function plateFileName(text, plateNumber, plateCount) {
  return plateCount > 1 ? `${fileStem(text)}-plate${plateNumber}.stl` : `${fileStem(text)}.stl`;
}
