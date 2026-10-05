// Node helper: load the same vendored OpenSCAD wasm + font the website uses.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../lib/engine.js';

const root = new URL('../', import.meta.url);
export const repoPath = (p) => fileURLToPath(new URL(p, root));

export async function loadNodeRunner() {
  const { default: OpenSCAD } = await import(new URL('vendor/openscad/openscad.js', root).href);
  const wasmBinary = fs.readFileSync(repoPath('vendor/openscad/openscad.wasm'));
  const fonts = { 'Andika-Bold.ttf': fs.readFileSync(repoPath('fonts/Andika-Bold.ttf')) };
  return createRunner({ OpenSCAD, wasmBinary, fonts });
}

/** Parse OpenSCAD SVG export into contours: [[x0,y0,x1,y1,...], ...] with +Y up. */
export function parseSvgContours(svgText) {
  const contours = [];
  const d = [...svgText.matchAll(/d="([^"]*)"/g)].map((m) => m[1]).join(' ');
  for (const chunk of d.split(/M/).slice(1)) {
    const nums = [...chunk.matchAll(/(-?[\d.]+(?:e-?\d+)?),(-?[\d.]+(?:e-?\d+)?)/g)];
    const pts = [];
    for (const m of nums) pts.push(parseFloat(m[1]), -parseFloat(m[2]));
    if (pts.length >= 6) contours.push(pts);
  }
  return contours;
}
