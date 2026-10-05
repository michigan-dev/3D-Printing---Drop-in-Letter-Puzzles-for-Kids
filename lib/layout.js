// Pure layout functions for Name Puzzle Maker: name cleanup, parameter
// clamping, letter spacing, base size, and bed fit / plate splitting.
// No DOM, no OpenSCAD: everything here runs in the browser and in node tests.
//
// Coordinates are millimetres. Glyph outlines come from lib/glyphs.js, which
// was extracted from OpenSCAD itself, so the shapes measured here are exactly
// the shapes OpenSCAD cuts. Pocket offsets mirror OpenSCAD's
// offset(delta = ...), which joins corners with an unlimited miter.

export const MM_PER_IN = 25.4;
export const MAX_LETTERS = 12;
export const HEIGHT_STEPS_IN = [2, 2.25, 2.5, 2.75, 3];
export const HEIGHT_MIN_MM = 50.8; // 2 in
export const HEIGHT_MAX_MM = 76.2; // 3 in

/** Every geometry parameter, in mm. Names match the generated .scad. */
export const DEFAULTS = Object.freeze({
  letter_height: 50.8, // cap height of capital letters
  letter_thickness: 8,
  pocket_depth: 5, // letters stand letter_thickness - pocket_depth proud
  base_floor: 3, // solid floor under the pockets
  fit_clearance: 0.3, // per side: pocket = letter outline offset outward by this
  lead_in: 0.5, // 45 degree chamfer around the top of each pocket
  lead_in_steps: 5, // the lead-in is cut as this many 0.1 mm steps
  side_margin: 2, // pocket opening to edge of the base's flat top face
  letter_gap: 3, // minimum wall between neighbouring pocket openings
  corner_chamfer: 4, // vertical corner cut, 45 degrees in plan view
  edge_chamfer: 1, // top perimeter edge
  bottom_chamfer: 0.4, // bottom perimeter edge, counters elephant's foot
  corner_min_wall: 1.2, // minimum wall between a pocket and a corner chamfer
  part_spacing: 5, // gap between parts on the build plate
  bed_margin: 3, // keep parts this far inside the bed edges
});

/** User-adjustable advanced parameters and their safe ranges. */
export const ADVANCED_LIMITS = Object.freeze({
  fit_clearance: { min: 0.1, max: 0.6, step: 0.05 },
  letter_thickness: { min: 4, max: 15, step: 0.5 },
  pocket_depth: { min: 2, max: 10, step: 0.5 },
  corner_chamfer: { min: 1, max: 15, step: 0.5 },
  edge_chamfer: { min: 0, max: 1.1, step: 0.1 },
});

export const PRINTERS = Object.freeze({
  a1: { id: 'a1', label: 'Bambu A1', width: 256, depth: 256 },
  mk4: { id: 'mk4', label: 'Prusa MK4', width: 250, depth: 210 },
  custom: { id: 'custom', label: 'Custom', width: 256, depth: 256 },
});
export const CUSTOM_BED_LIMITS = Object.freeze({ min: 100, max: 1000 });

// ---------------------------------------------------------------- name input

const CATEGORY_WORDS = {
  space: 'spaces',
  apostrophe: 'apostrophes',
  hyphen: 'hyphens',
  digit: 'numbers',
  accent: 'accents',
  other: 'symbols',
};

/**
 * Keep letters A-Z / a-z only. Accented letters lose their accent (Zoë -> Zoe);
 * everything else is removed and described in a friendly message.
 * @returns {{name: string, message: string, removed: string[]}}
 */
export function sanitizeName(raw) {
  const found = new Set();
  let out = '';
  for (const ch of String(raw ?? '')) {
    if (/[A-Za-z]/.test(ch)) {
      out += ch;
      continue;
    }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/^[A-Za-z]$/.test(base)) {
      out += base;
      found.add('accent');
    } else if (/\s/.test(ch)) found.add('space');
    else if (/['‘’ʼ`]/.test(ch)) found.add('apostrophe');
    else if (/[-‐-―]/.test(ch)) found.add('hyphen');
    else if (/\d/.test(ch)) found.add('digit');
    else found.add('other');
  }
  const order = ['space', 'apostrophe', 'hyphen', 'digit', 'accent', 'other'];
  const words = order.filter((k) => found.has(k)).map((k) => CATEGORY_WORDS[k]);
  let message = '';
  if (words.length) {
    const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
    const verb = found.has('accent') && words.length === 1 ? 'are dropped' : 'are removed';
    message = `${list[0].toUpperCase()}${list.slice(1)} ${verb}.`;
    if (found.has('accent')) message = message.replace(/\.$/, ' (é becomes e).');
  }
  return { name: out, message, removed: [...found] };
}

/** @returns {{ok: boolean, error: string}} */
export function validateName(name) {
  if (!name) return { ok: false, error: 'Type a name to get started.' };
  if (name.length > MAX_LETTERS) {
    return { ok: false, error: `That's ${name.length} letters. Names can be up to ${MAX_LETTERS} letters.` };
  }
  return { ok: true, error: '' };
}

/** 'caps' -> EMMA, 'first' -> Emma */
export function applyCase(name, style) {
  if (!name) return '';
  if (style === 'caps') return name.toUpperCase();
  return name[0].toUpperCase() + name.slice(1).toLowerCase();
}

// ----------------------------------------------------------- parameter rules

export const inchesToMm = (inches) => Math.round(inches * MM_PER_IN * 1000) / 1000;
export const mmToInches = (mm) => mm / MM_PER_IN;

export function clampHeightMm(mm) {
  const v = Number(mm);
  if (!Number.isFinite(v)) return HEIGHT_MIN_MM;
  return Math.min(HEIGHT_MAX_MM, Math.max(HEIGHT_MIN_MM, v));
}

/** Snap a slider value to the 0.25 in steps and clamp to 2-3 in. */
export function snapHeightIn(inches) {
  const v = Number(inches);
  const snapped = Number.isFinite(v) ? Math.round(v * 4) / 4 : 2;
  return Math.min(3, Math.max(2, snapped));
}

/** Largest top edge chamfer allowed: it must stay below side_margin - 0.8 mm. */
export function maxEdgeChamfer(sideMargin = DEFAULTS.side_margin) {
  return Math.max(0, Math.round((sideMargin - 0.8 - 0.1) * 10) / 10);
}

/**
 * Merge user values with defaults and clamp them to safe ranges.
 * @returns {{params: object, notes: Record<string, string>}} notes explain any clamping.
 */
export function resolveParams(user = {}) {
  const p = { ...DEFAULTS };
  const notes = {};
  for (const [key, value] of Object.entries(user)) {
    if (value === undefined || value === null || value === '') continue;
    if (key in p) p[key] = Number(value);
  }
  p.letter_height = clampHeightMm(p.letter_height);
  const fmt = (v) => `${+v.toFixed(2)} mm`;
  const clamp = (key, min, max, why) => {
    const v = Number.isFinite(p[key]) ? p[key] : DEFAULTS[key];
    const c = Math.min(max, Math.max(min, v));
    if (c !== v) notes[key] = why(c, v);
    p[key] = c;
  };
  const L = ADVANCED_LIMITS;
  clamp('fit_clearance', L.fit_clearance.min, L.fit_clearance.max, (c) => `Kept to ${fmt(c)} (safe range ${L.fit_clearance.min}-${L.fit_clearance.max} mm).`);
  clamp('pocket_depth', L.pocket_depth.min, L.pocket_depth.max, (c) => `Kept to ${fmt(c)} (range ${L.pocket_depth.min}-${L.pocket_depth.max} mm).`);
  clamp('letter_thickness', Math.max(L.letter_thickness.min, p.pocket_depth + 1), L.letter_thickness.max, (c) =>
    c > L.letter_thickness.max - 1e-9 ? `Capped at ${fmt(c)}.` : `Raised to ${fmt(c)} so letters stand at least 1 mm proud of the base.`);
  clamp('corner_chamfer', L.corner_chamfer.min, L.corner_chamfer.max, (c) => `Kept to ${fmt(c)} (range ${L.corner_chamfer.min}-${L.corner_chamfer.max} mm).`);
  const edgeMax = maxEdgeChamfer(p.side_margin);
  clamp('edge_chamfer', 0, edgeMax, (c, v) =>
    v > c ? `Capped at ${+c.toFixed(1)} mm to keep a ${p.side_margin} mm wall at the edge.` : 'Cannot be negative.');
  p.base_thickness = p.pocket_depth + p.base_floor;
  return { params: p, notes };
}

// ------------------------------------------------------------ glyph geometry

/** Scale for OpenSCAD text(size = fontSize) so that capitals are letter_height tall. */
export function fontSizeFor(letterHeight, font) {
  return letterHeight / font.capPerSize;
}

function signedArea(c) {
  let a = 0;
  for (let i = 0; i < c.length; i += 2) {
    const j = (i + 2) % c.length;
    a += c[i] * c[j + 1] - c[j] * c[i + 1];
  }
  return a / 2;
}

/** All outer contours of a glyph, bridges included as rectangles, scaled to mm. */
export function glyphOuterContours(glyph, scale) {
  const out = glyph.shapes.map((s) => s.outer.map((v) => v * scale));
  for (const [x0, y0, x1, y1] of glyph.bridges) {
    out.push([x0, y0, x1, y0, x1, y1, x0, y1].map((v) => v * scale));
  }
  return out;
}

/** Bounding box [x0, y0, x1, y1] of the un-offset letter in mm (pen origin at 0,0). */
export function glyphBBox(glyph, scale) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of glyphOuterContours(glyph, scale)) {
    for (let i = 0; i < c.length; i += 2) {
      x0 = Math.min(x0, c[i]); x1 = Math.max(x1, c[i]);
      y0 = Math.min(y0, c[i + 1]); y1 = Math.max(y1, c[i + 1]);
    }
  }
  return [x0, y0, x1, y1];
}

/**
 * Outline of offset(delta = d) for one outer contour, as OpenSCAD/Clipper
 * builds it: each edge pushed out by d, convex corners joined by an unlimited
 * miter. At concave corners both pushed-out edge ends are kept; those points
 * lie inside the offset region, so they never shrink a measured distance.
 * Returns a flat point list with no edge longer than `step`.
 */
export function offsetContour(c, d, step = 0.2) {
  const n = c.length / 2;
  const ccw = signedArea(c) > 0;
  const nx = [], ny = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let dx = c[2 * j] - c[2 * i], dy = c[2 * j + 1] - c[2 * i + 1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    // outward normal: right-hand side for counter-clockwise contours
    nx.push(ccw ? dy : -dy); ny.push(ccw ? -dx : dx);
  }
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n; // edge p arrives at vertex i, edge i leaves it
    const vx = c[2 * i], vy = c[2 * i + 1];
    const cross = nx[p] * ny[i] - ny[p] * nx[i];
    const convex = ccw ? cross >= -1e-12 : cross <= 1e-12;
    const dot = nx[p] * nx[i] + ny[p] * ny[i];
    if (convex && dot > -0.999) {
      const k = d / (1 + dot);
      pts.push(vx + (nx[p] + nx[i]) * k, vy + (ny[p] + ny[i]) * k);
    } else {
      pts.push(vx + nx[p] * d, vy + ny[p] * d, vx + nx[i] * d, vy + ny[i] * d);
    }
  }
  return densify(pts, step);
}

function densify(pts, step) {
  const out = [];
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
    const segs = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let s = 0; s < segs; s++) out.push(ax + ((bx - ax) * s) / segs, ay + ((by - ay) * s) / segs);
  }
  return out;
}

/** Point cloud of a letter's pocket opening at the base's top surface (mm, pen origin 0,0). */
function openingPoints(glyph, scale, delta) {
  const all = [];
  for (const c of glyphOuterContours(glyph, scale)) for (const v of offsetContour(c, delta)) all.push(v);
  // sort by y (pairs) so band queries can binary-search
  const idx = [];
  for (let i = 0; i < all.length; i += 2) idx.push(i);
  idx.sort((a, b) => all[a + 1] - all[b + 1]);
  const xs = new Float64Array(idx.length), ys = new Float64Array(idx.length);
  idx.forEach((k, i) => { xs[i] = all[k]; ys[i] = all[k + 1]; });
  let x0 = Infinity, x1 = -Infinity;
  for (const x of xs) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  return { xs, ys, x0, x1, y0: ys[0], y1: ys[ys.length - 1] };
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Smallest shift s so that every point of B (moved right by s) is at least
 * `gap` from every point of A, with B to the right of A.
 */
function requiredShift(A, ax, B, gap) {
  let s = -Infinity;
  for (let i = 0; i < B.xs.length; i++) {
    const by = B.ys[i], bx = B.xs[i];
    const lo = lowerBound(A.ys, by - gap);
    for (let k = lo; k < A.ys.length && A.ys[k] < by + gap; k++) {
      const dy = A.ys[k] - by;
      const need = A.xs[k] + ax - bx + Math.sqrt(gap * gap - dy * dy);
      if (need > s) s = need;
    }
  }
  return s;
}

/** Minimum distance between two placed point clouds (used for reporting walls). */
function minDistance(A, ax, B, bx, best = Infinity) {
  for (let i = 0; i < B.xs.length; i++) {
    const px = B.xs[i] + bx, py = B.ys[i];
    const lo = lowerBound(A.ys, py - best);
    for (let k = lo; k < A.ys.length && A.ys[k] < py + best; k++) {
      const d = Math.hypot(A.xs[k] + ax - px, A.ys[k] - py);
      if (d < best) best = d;
    }
  }
  return best;
}

// --------------------------------------------------------------- the layout

/**
 * Place the letters on a shared baseline and size the base around them.
 * @param {string} text   cleaned, cased name, e.g. "Emma"
 * @param {object} params resolved params (see resolveParams)
 * @param {{FONT: object, GLYPHS: object}} glyphData
 */
export function computeLayout(text, params, { FONT, GLYPHS }, { report = true } = {}) {
  const p = params;
  const scale = fontSizeFor(p.letter_height, FONT);
  const delta = p.fit_clearance + p.lead_in; // pocket opening at the top surface
  const gap = p.letter_gap + 0.005; // tiny allowance for point sampling
  const letters = [];
  const openings = [];
  let pen = 0;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    const glyph = GLYPHS[ch];
    if (!glyph) throw new Error(`No glyph for "${ch}"`);
    const op = openingPoints(glyph, scale, delta);
    let x = pen;
    for (let j = 0; j < k; j++) {
      const A = openings[j], ax = letters[j].x;
      if (A.x1 + ax + gap <= op.x0 + x) continue; // already far enough apart
      if (A.y1 < op.y0 - gap || op.y1 < A.y0 - gap) continue;
      x = Math.max(x, requiredShift(A, ax, op, gap));
    }
    letters.push({ ch, x, y: 0, advance: glyph.adv * scale, bbox: glyphBBox(glyph, scale) });
    openings.push(op);
    pen = x + glyph.adv * scale;
  }

  // Extents of all pocket openings (pen coordinates, baseline at y = 0).
  let ox0 = Infinity, ox1 = -Infinity, oy0 = Infinity, oy1 = -Infinity;
  openings.forEach((op, k) => {
    ox0 = Math.min(ox0, op.x0 + letters[k].x);
    ox1 = Math.max(ox1, op.x1 + letters[k].x);
    oy0 = Math.min(oy0, op.y0);
    oy1 = Math.max(oy1, op.y1);
  });

  const e = p.edge_chamfer;
  const inset = p.side_margin + e; // outer edge to pocket opening
  // Corner chamfers: make sure no pocket comes closer than corner_min_wall to
  // the chamfered corner of the top face; if one would, grow the base in Y.
  const cc = p.corner_chamfer;
  const SQ2 = Math.SQRT2;
  // In a corner frame (outer corner at 0,0, base interior towards +u,+v) the top
  // face's corner cut is the line u + v = cc + e*sqrt2; wall = (u + v - that)/sqrt2.
  const cutLine = cc + e * SQ2;
  const needUV = p.corner_min_wall * SQ2 + cutLine;
  let growTop = 0, growBottom = 0;
  openings.forEach((op, k) => {
    const lx = letters[k].x;
    for (let i = 0; i < op.xs.length; i++) {
      const x = op.xs[i] + lx, y = op.ys[i];
      const uL = x - ox0 + inset, uR = ox1 - x + inset;
      const vB = y - oy0 + inset, vT = oy1 - y + inset;
      const u = Math.min(uL, uR);
      growTop = Math.max(growTop, needUV - (u + vT));
      growBottom = Math.max(growBottom, needUV - (u + vB));
    }
  });
  const round3 = (v) => Math.ceil(v * 1000) / 1000;
  growTop = growTop > 1e-9 ? round3(growTop) : 0;
  growBottom = growBottom > 1e-9 ? round3(growBottom) : 0;

  const width = ox1 - ox0 + 2 * inset;
  const depth = oy1 - oy0 + 2 * inset + growTop + growBottom;
  const shiftX = inset - ox0;
  const shiftY = inset + growBottom - oy0; // baseline height in base coordinates
  for (const L of letters) {
    L.x += shiftX;
    L.y = shiftY;
  }

  // Report the as-built numbers for tests and the UI.
  let minWall = Infinity;
  for (let k = 1; report && k < letters.length; k++) {
    for (let j = k - 1; j >= 0; j--) {
      const A = openings[j], B = openings[k];
      const xGap = B.x0 + letters[k].x - (A.x1 + letters[j].x);
      const yGap = Math.max(A.y0 - B.y1, B.y0 - A.y1);
      if (Math.max(xGap, yGap) >= minWall) continue;
      minWall = minDistance(A, letters[j].x, B, letters[k].x, minWall);
    }
  }
  let cornerWall = Infinity;
  if (report) openings.forEach((op, k) => {
    for (let i = 0; i < op.xs.length; i++) {
      const x = op.xs[i] + letters[k].x, y = op.ys[i] + shiftY;
      const u = Math.min(x, width - x), v = Math.min(y, depth - y);
      cornerWall = Math.min(cornerWall, (u + v - cutLine) / SQ2);
    }
  });
  const margins = {
    left: ox0 + shiftX - e,
    right: width - e - (ox1 + shiftX),
    bottom: oy0 + shiftY - e,
    top: depth - e - (oy1 + shiftY),
  };

  return {
    text,
    fontSize: scale,
    letters,
    base: { width, depth, thickness: p.base_thickness },
    baselineY: shiftY,
    grow: { top: growTop, bottom: growBottom },
    margins,
    minWall: letters.length > 1 ? minWall : null,
    cornerWall,
  };
}

// ------------------------------------------------------------ bed and plates

export function bedFor(printerId, custom = {}) {
  if (printerId === 'custom') {
    const clampBed = (v, d) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return d;
      return Math.min(CUSTOM_BED_LIMITS.max, Math.max(CUSTOM_BED_LIMITS.min, n));
    };
    return { id: 'custom', label: 'Custom bed', width: clampBed(custom.width, 256), depth: clampBed(custom.depth, 256) };
  }
  return { ...(PRINTERS[printerId] || PRINTERS.a1) };
}

/** Does a w x d footprint fit the bed, and does it need a quarter turn? */
function fitOnBed(w, d, bed, margin) {
  const uw = bed.width - 2 * margin, ud = bed.depth - 2 * margin;
  if (w <= uw + 1e-9 && d <= ud + 1e-9) return { fits: true, rot: 0 };
  if (d <= uw + 1e-9 && w <= ud + 1e-9) return { fits: true, rot: 90 };
  return { fits: false, rot: 0 };
}

/**
 * Lay out every part flat on one or more build plates.
 * Items are placed in rows (base first, then the letters in reading order)
 * with part_spacing between bounding boxes; a new plate starts when a row
 * no longer fits. Each plate is then centred on the bed.
 *
 * Placement entries use the same transform as the .scad: rotate about Z by
 * `rot` degrees, then translate by [tx, ty]. Base coordinates run from
 * (0,0) to (width, depth); letter coordinates are relative to the pen origin.
 */
export function planPlates(layout, bed, params) {
  const p = params;
  const m = p.bed_margin;
  const gap = p.part_spacing;
  const baseFit = fitOnBed(layout.base.width, layout.base.depth, bed, m);
  if (!baseFit.fits) {
    return {
      ok: false,
      reason: 'base-too-big',
      overWidth: Math.max(0, layout.base.width - (bed.width - 2 * m)),
      overDepth: Math.max(0, layout.base.depth - (bed.depth - 2 * m)),
      plates: [],
    };
  }
  const items = [];
  const bw = baseFit.rot ? layout.base.depth : layout.base.width;
  const bd = baseFit.rot ? layout.base.width : layout.base.depth;
  items.push({ kind: 'base', index: 0, w: bw, h: bd, rot: baseFit.rot });
  layout.letters.forEach((L, i) => {
    const [x0, y0, x1, y1] = L.bbox;
    items.push({ kind: 'letter', index: i, w: x1 - x0, h: y1 - y0, rot: 0, bx: x0, by: y0 });
  });

  const uw = bed.width - 2 * m, ud = bed.depth - 2 * m;
  const plates = [];
  let plate = null, cursorX = 0, rowTop = 0, rowH = 0;
  const newPlate = () => {
    plate = { items: [] };
    plates.push(plate);
    cursorX = 0; rowTop = 0; rowH = 0;
  };
  newPlate();
  for (const it of items) {
    if (it.w > uw + 1e-9 || it.h > ud + 1e-9) return { ok: false, reason: 'part-too-big', plates: [] };
    let x = cursorX === 0 ? 0 : cursorX + gap;
    if (x + it.w > uw + 1e-9) {
      // next row
      rowTop += rowH + gap;
      rowH = 0;
      x = 0;
    }
    if (rowTop + it.h > ud + 1e-9) {
      newPlate();
      x = 0;
    }
    plate.items.push({ ...it, px: x, py: rowTop }); // px, py: top-left corner, y measured downwards
    cursorX = x + it.w;
    rowH = Math.max(rowH, it.h);
  }

  // Convert to bed coordinates (y up) and centre each plate's content.
  const out = plates.map((pl, n) => {
    let maxX = 0, maxY = 0;
    for (const it of pl.items) { maxX = Math.max(maxX, it.px + it.w); maxY = Math.max(maxY, it.py + it.h); }
    const offX = (bed.width - maxX) / 2, offY = (bed.depth - maxY) / 2;
    const placements = pl.items.map((it) => {
      const left = offX + it.px;
      const bottom = offY + (maxY - it.py - it.h);
      let tx, ty;
      if (it.kind === 'base') {
        tx = it.rot ? left + layout.base.depth : left;
        ty = bottom;
      } else {
        tx = left - it.bx;
        ty = bottom - it.by;
      }
      return { kind: it.kind, index: it.index, rot: it.rot, tx, ty, rect: [left, bottom, left + it.w, bottom + it.h] };
    });
    const letterCount = placements.filter((q) => q.kind === 'letter').length;
    const hasBase = placements.some((q) => q.kind === 'base');
    return { number: n + 1, placements, hasBase, letterCount };
  });
  return { ok: true, reason: '', plates: out };
}

/**
 * Tallest slider step (2.0-3.0 in) at which the base fits the bed.
 * @returns {number|null} inches, or null if even 2.0 in does not fit
 */
export function maxFittingHeightIn(text, userParams, bed, glyphData) {
  for (const inches of [...HEIGHT_STEPS_IN].reverse()) {
    const { params } = resolveParams({ ...userParams, letter_height: inchesToMm(inches) });
    const layout = computeLayout(text, params, glyphData, { report: false });
    if (fitOnBed(layout.base.width, layout.base.depth, bed, params.bed_margin).fits) return inches;
  }
  return null;
}
