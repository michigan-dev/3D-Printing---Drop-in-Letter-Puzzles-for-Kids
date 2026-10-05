#!/usr/bin/env node
// Slices the real base (OpenSCAD, same scad as the site) for many names, heights and clearances and checks
// that every i / j pocket is ONE opening that contains the whole bar between the dot and the stem.
// Usage: node tests/check_channels.mjs
import { loadNodeRunner, parseSvgContours } from './node-runner.mjs';
import { prepareJob } from '../lib/job.js';
import { GLYPHS } from '../lib/glyphs.js';

const run = await loadNodeRunner();
const dec = new TextDecoder();
const inside = (x, y, c) => {
  let r = false;
  for (let i = 0, j = c.length - 2; i < c.length; j = i, i += 2) {
    const xi = c[i], yi = c[i + 1], xj = c[j], yj = c[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
};
const area = (c) => { let a = 0; for (let i = 0; i < c.length; i += 2) { const j = (i + 2) % c.length; a += c[i] * c[j + 1] - c[j] * c[i + 1]; } return Math.abs(a / 2); };

const NAMES = ['Patrick', 'Mia', 'Ellie', 'Olivia', 'Julian', 'Jiggy', 'Ivy', 'Jojo'];
let total = 0;
const bad = [];
for (const name of NAMES) for (const heightMm of [14, 40]) for (const fit of [2, 0.3]) {
  const job = prepareJob({ rawName: name, caseStyle: 'first', heightMm, printer: 'custom', customBed: { width: 1000, depth: 1000 }, advanced: { fit_clearance: fit } });
  if (job.status !== 'ready') continue;
  // a cross-section of the base at mid pocket depth
  const section = job.scad.slice(0, job.scad.indexOf('if (part == "assembled")')) +
    `projection(cut = true) translate([0, 0, -${job.params.base_floor + job.params.pocket_depth / 2}]) base();`;
  const r = await run(section, 'svg');
  if (!r.ok) throw new Error(r.log.join('\n'));
  const contours = parseSvgContours(dec.decode(r.output)).filter((c) => c.length >= 6);
  const slabArea = job.layout.base.width * job.layout.base.depth;
  const sc = job.layout.fontSize;
  for (const L of job.layout.letters) {
    for (const [x0, y0, x1, y1] of GLYPHS[L.ch].bridges) {
      total++;
      const cx = ((x0 + x1) / 2) * sc + L.x, half = job.params.bridge_width / 2;
      const corners = [[cx - half, y0 * sc + L.y], [cx + half, y0 * sc + L.y], [cx + half, y1 * sc + L.y], [cx - half, y1 * sc + L.y]];
      const mid = [cx, ((y0 + y1) / 2) * sc + L.y];
      const pocket = contours.filter((c) => inside(...mid, c) && area(c) < slabArea * 0.9).sort((a, b) => area(a) - area(b))[0];
      if (!pocket || !corners.every((p) => inside(p[0], p[1], pocket))) bad.push(`${name} '${L.ch}' at ${heightMm} mm, clearance ${fit}`);
    }
  }
}
if (bad.length) { console.error(`FAILED: ${bad.length} of ${total} i/j bars have no channel:\n  ` + bad.join('\n  ')); process.exit(1); }
console.log(`OK: all ${total} i/j bars (${NAMES.length} names, 2 heights, 2 clearances) sit inside their pocket: the channel between dot and stem is there.`);
