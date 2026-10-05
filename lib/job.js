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
 * @param {string} [input.fileStamp]       local date and time for file names, e.g. "2026-10-05_14-32-07" (see timeStamp)
 * @param {boolean} [input.withScad=true]
 */
export function prepareJob(input) {
  const clean = sanitizeName(input.rawName);
  const check = validateName(clean.name);
  const text = applyCase(clean.name, input.caseStyle);
  const heightMm = clampHeightMm(input.heightMm ?? (input.heightIn !== undefined ? inchesToMm(input.heightIn) : undefined));
  const { params, notes } = resolveParams({ ...(input.advanced || {}), letter_height: heightMm });
  const bed = bedFor(input.printer, input.customBed);
  const stem = fileStem(clean.name, input.fileStamp);
  const result = { text, stem, sanitizeMessage: clean.message, nameError: check.error, heightMm, params, notes, bed };
  if (!check.ok) return { ...result, status: 'invalid-name' };

  const layout = computeLayout(text, params, GLYPH_DATA);
  const plan = planPlates(layout, bed, params);
  if (!plan.ok) {
    const maxHeightMm = maxFittingHeightMm(text, input.advanced || {}, bed, GLYPH_DATA);
    const smallest = resolveParams({ ...(input.advanced || {}), letter_height: HEIGHT_MIN_MM }).params;
    const widthAtMin = heightMm === HEIGHT_MIN_MM ? layout.base.width : computeLayout(text, smallest, GLYPH_DATA, { report: false }).base.width;
    return { ...result, layout, plan, status: maxHeightMm ? 'too-big' : 'nothing-fits', maxHeightMm, minHeightMm: HEIGHT_MIN_MM, widthAtMin };
  }
  nameThePlates(stem, plan.plates);
  const scad = input.withScad === false ? '' : generateScad({
    text, params, layout, plan, bed, font: FONT, glyphs: GLYPHS,
    generatedOn: input.fileStamp ? input.fileStamp.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2') : '',
  });
  return { ...result, layout, plan, scad, fontName: FONT.openscadName, status: 'ready' };
}

/**
 * Names for the "two colours" downloads (base alone, letters alone). They get their own names so they
 * can never be confused with the plates of the normal download.
 */
export function nameSeparatePlates(stem, plates) {
  const letterOnly = plates.filter((pl) => !pl.hasBase).length;
  let seen = 0;
  for (const pl of plates) {
    if (pl.hasBase) {
      pl.file = `${stem}-base-only.stl`;
      pl.label = 'Base only';
    } else {
      seen++;
      pl.file = letterOnly === 1 ? `${stem}-letters-only.stl` : `${stem}-letters-only${seen}.stl`;
      pl.label = letterOnly === 1 ? 'Letters only' : `Letters only ${seen}`;
    }
  }
}

/** True when the normal download is already split into a base-only plate and letter-only plates. */
export function isAlreadySplit(plates) {
  return plates.length > 1 && plates[0].hasBase && plates[0].letterCount === 0 && plates.slice(1).every((pl) => !pl.hasBase);
}

/** Local date and time for file names: 2026-10-05_14-32-07 */
export function timeStamp(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}_${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`;
}

/** File name stem: the word as typed (letters only) plus date and time, e.g. Patrick_2026-10-05_14-32-07 */
export function fileStem(word, stamp = '') {
  return stamp ? `${word}_${stamp}` : word;
}

/**
 * Give each plate a file name and a button label. One plate is simply the puzzle;
 * with several, a plate holding only the base or only letters says so.
 */
function nameThePlates(stem, plates) {
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
