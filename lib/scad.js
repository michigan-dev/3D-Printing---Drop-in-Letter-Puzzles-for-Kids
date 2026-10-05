// Pure function: puzzle inputs + computed layout -> OpenSCAD source string.
// The same file is rendered in the browser (worker.js) and offered as a
// download for desktop OpenSCAD, so it is written to be readable and tweakable.

const n = (v) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};
const str = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;

/**
 * @param {object} job
 * @param {string} job.text       cleaned, cased name ("Emma")
 * @param {object} job.params     resolved params (lib/layout.js resolveParams)
 * @param {object} job.layout     computeLayout() result
 * @param {object} job.plan       planPlates() result (ok === true)
 * @param {object} job.bed        {label, width, depth}
 * @param {object} job.font       FONT from lib/glyphs.js
 * @param {object} job.glyphs     GLYPHS from lib/glyphs.js
 * @param {string} [job.generatedOn]  ISO date for the header
 */
export function generateScad({ text, params: p, layout, plan, bed, font, glyphs, generatedOn = '' }) {
  const usedBridges = [...new Set(text)].filter((ch) => glyphs[ch] && glyphs[ch].bridges.length);
  const bridgeRows = usedBridges.flatMap((ch) =>
    glyphs[ch].bridges.map((b) => `  [${str(ch)}, [${b.map(n).join(', ')}]],`));
  const letterRows = layout.letters.map((L, i) =>
    `  [${str(L.ch)}, ${n(L.x)}, ${n(L.y)}],${i === 0 ? '  // [character, pen x, baseline y] in base coordinates' : ''}`);
  const plateRows = plan.plates.map((pl) => {
    const items = pl.placements.map((q) =>
      q.kind === 'base' ? `[-1, ${n(q.tx)}, ${n(q.ty)}, ${q.rot}]` : `[${q.index}, ${n(q.tx)}, ${n(q.ty)}, ${q.rot}]`);
    return `  [ // plate ${pl.number}\n    ${items.join(',\n    ')}\n  ],`;
  });
  const partChoices = ['assembled', 'base', 'letters', ...plan.plates.map((pl) => `plate_${pl.number}`)].join(', ');
  const wIn = (layout.base.width / 25.4).toFixed(1), dIn = (layout.base.depth / 25.4).toFixed(1);

  return `// Name Puzzle Maker: drop-in letter puzzle for "${text}"
// Generated${generatedOn ? ` on ${generatedOn}` : ''} by Name Puzzle Maker. Rendered with OpenSCAD 2025.03+ (Manifold backend).
//
// Font: Andika Bold, SIL Open Font License 1.1 (c) SIL International.
// Keep Andika-Bold.ttf in a "fonts" folder next to this file (it is in the
// website's fonts/ folder), or install Andika on your computer.
//
// Base ${n(layout.base.width)} x ${n(layout.base.depth)} x ${n(p.base_thickness)} mm (${wIn} x ${dIn} in), ${plan.plates.length} plate(s) on ${bed.label} (${n(bed.width)} x ${n(bed.depth)} mm).
// The letter positions and base size below were computed for these exact
// settings. Small changes to fit_clearance, thicknesses or chamfers are safe;
// for a different name or letter height, use the website again.

use <fonts/${font.file}>

/* [Output] */
// What to render. Each plate is ready to slice: everything flat at Z = 0.
part = "plate_1"; // [${partChoices}]
// Letter index for part = "letter" (used by the website).
letter_index = 0;

/* [Fit] */
// Gap per side between letter and pocket: 0.2 snug, 0.3 default, 0.4 loose.
fit_clearance = ${n(p.fit_clearance)};
// 45 degree chamfer around the top of each pocket, so letters drop in easily.
lead_in = ${n(p.lead_in)};
lead_in_steps = ${p.lead_in_steps};

/* [Sizes] */
// Cap height of the capital letters (mm).
letter_height = ${n(p.letter_height)};
letter_thickness = ${n(p.letter_thickness)};
pocket_depth = ${n(p.pocket_depth)};
// Solid floor under the pockets.
base_floor = ${n(p.base_floor)};
// Vertical corner cut, 45 degrees in plan view.
corner_chamfer = ${n(p.corner_chamfer)};
// Top perimeter edge. Keep below side margin - 0.8 mm (${n(p.side_margin)} - 0.8).
edge_chamfer = ${n(p.edge_chamfer)};
// Bottom perimeter edge, counters elephant's foot.
bottom_chamfer = ${n(p.bottom_chamfer)};

/* [Hidden] */
base_thickness = pocket_depth + base_floor;
// Pocket openings sit side_margin = ${n(p.side_margin)} mm from the edge of the base's flat top face,
// with at least letter_gap = ${n(p.letter_gap)} mm of wall between neighbouring pockets.
base_size = [${n(layout.base.width)}, ${n(layout.base.depth)}];
font = ${str(font.openscadName)};
// text() size that makes capitals letter_height tall (cap height = ${font.capPerSize} x size).
font_size = letter_height / ${font.capPerSize};
text_fn = ${font.textFn};
// Cut a little above the top face so pockets never share a face with it.
overcut = 0.01;

letters = [
${letterRows.join('\n')}
];

// Bridges that join the dot of i and j to the stem, so each letter prints as
// one piece. [x0, y0, x1, y1] in units of font_size; the bridge is exactly as
// wide as the stem.
glyph_bridges = [
${bridgeRows.join('\n')}
];

// Build plates: [part, x, y, rotation]; part -1 is the base, otherwise a letter index.
plates = [
${plateRows.join('\n')}
];

// ---------------------------------------------------------------- modules

// One letter as a 2D shape, pen origin at [0, 0] on the baseline.
module glyph(ch) {
  text(ch, size = font_size, font = font, halign = "left", valign = "baseline", $fn = text_fn);
  for (b = [for (e = glyph_bridges) if (e[0] == ch) e[1]])
    translate([b[0], b[1]] * font_size) square([b[2] - b[0], b[3] - b[1]] * font_size);
}

module letter(i) linear_extrude(height = letter_thickness) glyph(letters[i][0]);

// Plan outline of the base: rectangle with 45 degree corner cuts, shrunk by inset.
function outline(inset) =
  let (w = base_size[0], d = base_size[1], i = inset,
       k = corner_chamfer - inset * (2 - sqrt(2)))
  [[i + k, i], [w - i - k, i], [w - i, i + k], [w - i, d - i - k],
   [w - i - k, d - i], [i + k, d - i], [i, d - i - k], [i, i + k]];

// Base slab with chamfered bottom and top edges, built as a stack of outlines.
module base_body() {
  layers = concat(
    bottom_chamfer > 0 ? [[bottom_chamfer, 0], [0, bottom_chamfer]] : [[0, 0]],
    edge_chamfer > 0 ? [[0, base_thickness - edge_chamfer], [edge_chamfer, base_thickness]]
                     : [[0, base_thickness]]);
  m = len(layers);
  points = [for (l = layers) for (q = outline(l[0])) [q[0], q[1], l[1]]];
  faces = concat(
    [[for (j = [0:7]) j]],
    [for (l = [0:m - 2]) for (j = [0:7]) [l * 8 + j, (l + 1) * 8 + j, (l + 1) * 8 + (j + 1) % 8, l * 8 + (j + 1) % 8]],
    [[for (j = [7:-1:0]) (m - 1) * 8 + j]]);
  polyhedron(points, faces);
}

// Pocket for letter i: the letter outline offset outward by fit_clearance,
// plus a stepped 45 degree lead-in that is fit_clearance + lead_in wide at the top.
module pocket(i) {
  translate([letters[i][1], letters[i][2], base_thickness]) {
    translate([0, 0, -pocket_depth])
      linear_extrude(height = pocket_depth + overcut)
        offset(delta = fit_clearance) glyph(letters[i][0]);
    for (k = [1:lead_in_steps])
      translate([0, 0, -k * lead_in / lead_in_steps])
        linear_extrude(height = k * lead_in / lead_in_steps + overcut)
          offset(delta = fit_clearance + lead_in * (lead_in_steps - k + 1) / lead_in_steps)
            glyph(letters[i][0]);
  }
}

module base() difference() {
  base_body();
  for (i = [0:len(letters) - 1]) pocket(i);
}

module assembled() {
  base();
  for (i = [0:len(letters) - 1])
    translate([letters[i][1], letters[i][2], base_floor]) letter(i);
}

module place(item) translate([item[1], item[2], 0]) rotate([0, 0, item[3]]) children();

module plate(number) {
  for (item = plates[number - 1])
    place(item) if (item[0] < 0) base(); else letter(item[0]);
}

// Every letter in a row, for a quick look.
module letters_row() {
  for (i = [0:len(letters) - 1]) translate([letters[i][1], 0, 0]) letter(i);
}

if (part == "assembled") assembled();
else if (part == "base") base();
else if (part == "letter") letter(letter_index);
else if (part == "letters") letters_row();
else for (number = [1:len(plates)]) if (part == str("plate_", number)) plate(number);
`;
}
