// Render pipeline shared by worker.js (browser) and tests/render.mjs (node):
//   1. render each distinct letter once        ("Tracing letter outlines")
//   2. render the base with its pockets        ("Cutting pockets")
//   3. place copies on each plate, write STLs   ("Laying out the build plate")
// Meshes are cached, so changing only the printer re-plates without re-rendering.

import { parseStl, transformTris, mergeTris, writeBinaryStl, meshStats, estimateGrams } from './stl.js';

export const STEPS = ['letters', 'base', 'plates'];

/**
 * Make sure OpenSCAD resolves the bundled font (it silently falls back to
 * another font otherwise). Runs once per cache.
 */
export async function verifyFont(run, fontName, cache = new Map()) {
  if (cache.get('font-ok') === fontName) return;
  const r = await run(`echo(FONT = fontmetrics(font = ${JSON.stringify(fontName)}).font); square(1);`, 'svg', ['--enable=textmetrics']);
  const line = r.log.find((l) => l.startsWith('ECHO: FONT')) || '(no font information)';
  if (!/family = "Andika"/.test(line)) {
    throw new Error(`The Andika font did not load in OpenSCAD's virtual filesystem. OpenSCAD reported: ${line}. ` +
      `Log: ${r.log.filter((l) => /font/i.test(l)).join(' | ')}`);
  }
  cache.set('font-ok', fontName);
}

/**
 * @param {Function} run      createRunner() result
 * @param {object} job        prepareJob() result with status 'ready'
 * @param {object} [opts]
 * @param {(step: string, detail?: string) => void} [opts.onStep]
 * @param {Map} [opts.cache]  survives between builds
 */
export async function buildPuzzle(run, job, { onStep = () => {}, cache = new Map() } = {}) {
  const t0 = Date.now();
  const { params: p, layout, plan, scad, bed } = job;
  const warnings = [];
  await verifyFont(run, job.fontName || 'Andika:style=Bold', cache);
  const render = async (defines, what) => {
    const args = [];
    for (const [k, v] of Object.entries(defines)) args.push('-D', `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`);
    const r = await run(scad, 'binstl', args);
    for (const line of r.log) if (/^WARNING/.test(line)) warnings.push(`${what}: ${line}`);
    if (r.log.some((l) => l.includes("Can't get font"))) {
      throw new Error(`OpenSCAD could not find the Andika font while rendering the ${what}. Check fonts/Andika-Bold.ttf is reachable.`);
    }
    if (!r.ok) {
      const err = r.log.filter((l) => /ERROR|crash|abort/i.test(l)).join('\n') || r.log.slice(-5).join('\n');
      throw new Error(`OpenSCAD could not render the ${what}.\n${err}`);
    }
    const tris = parseStl(r.output);
    if (!tris.length) throw new Error(`OpenSCAD produced an empty ${what}.`);
    return { tris, ms: r.ms };
  };

  // 1. letters
  onStep('letters');
  const tLetters = Date.now();
  const letterMeshes = {};
  const letterKey = (ch) => JSON.stringify(['letter', ch, layout.fontSize, p.letter_thickness]);
  for (let i = 0; i < layout.letters.length; i++) {
    const ch = layout.letters[i].ch;
    if (letterMeshes[ch]) continue;
    const key = letterKey(ch);
    if (!cache.has(key)) cache.set(key, (await render({ part: 'letter', letter_index: i }, `letter "${ch}"`)).tris);
    letterMeshes[ch] = cache.get(key);
  }
  const lettersMs = Date.now() - tLetters;

  // 2. base
  onStep('base');
  const tBase = Date.now();
  const baseKey = JSON.stringify(['base', p, layout.base, layout.letters.map((L) => [L.ch, L.x, L.y])]);
  if (!cache.has(baseKey)) cache.set(baseKey, (await render({ part: 'base' }, 'base')).tris);
  const baseMesh = cache.get(baseKey);
  const baseMs = Date.now() - tBase;

  // 3. plates
  onStep('plates');
  const tPlates = Date.now();
  const plates = plan.plates.map((pl) => {
    const parts = pl.placements.map((q) =>
      transformTris(q.kind === 'base' ? baseMesh : letterMeshes[layout.letters[q.index].ch], { tx: q.tx, ty: q.ty, rot: q.rot }));
    const tris = mergeTris(parts);
    const s = meshStats(tris);
    // Never hand out a plate that would not print: on the bed, inside it.
    const tol = 1e-3;
    if (Math.abs(s.min[2]) > tol || s.min[0] < -tol || s.min[1] < -tol || s.max[0] > bed.width + tol || s.max[1] > bed.depth + tol) {
      throw new Error(`Plate ${pl.number} does not sit inside the ${bed.width} x ${bed.depth} mm bed at Z = 0.`);
    }
    return { number: pl.number, file: pl.file, label: pl.label, stl: writeBinaryStl(tris, `Name Puzzle Maker plate ${pl.number}`), triangles: tris.length / 9, bounds: s };
  });
  const platesMs = Date.now() - tPlates;

  const baseStats = meshStats(baseMesh);
  let grams = estimateGrams(baseStats);
  for (const L of layout.letters) grams += estimateGrams(meshStats(letterMeshes[L.ch]));

  return {
    plates,
    baseMesh,
    letterMeshes,
    baseStats,
    grams,
    warnings,
    timings: { letters: lettersMs, base: baseMs, plates: platesMs, total: Date.now() - t0 },
  };
}
