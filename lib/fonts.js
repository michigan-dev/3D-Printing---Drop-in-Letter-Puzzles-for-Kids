// The fonts a puzzle can be made in. Each has its own generated glyph data (tools/build-glyphs.mjs).
import * as andika from './glyphs.js';
import * as serif from './glyphs-serif.js';

export const FONTS = {
  andika: {
    id: 'andika',
    label: 'Andika',
    note: 'clear sans-serif letters designed for beginning readers',
    FONT: andika.FONT,
    GLYPHS: andika.GLYPHS,
  },
  serif: {
    id: 'serif',
    label: 'Bree Serif',
    note: 'a friendly slab serif, with bars on the capital I and a line at the top of the j',
    FONT: serif.FONT,
    GLYPHS: serif.GLYPHS,
  },
};
export const DEFAULT_FONT = 'andika';

/** Glyph data ({FONT, GLYPHS, ...}) for a font id; unknown ids give the default font. */
export const fontData = (id) => FONTS[id] || FONTS[DEFAULT_FONT];
