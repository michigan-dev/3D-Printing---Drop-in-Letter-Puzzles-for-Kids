#!/usr/bin/env node
// Renders real STLs for the test names with the same wasm build, font and
// pipeline the website uses, and writes them to tests/output/ along with a
// JSON file of the expected numbers for tests/validate_stl.py.
//
// Usage: node tests/render.mjs

import fs from 'node:fs';
import { loadNodeRunner, repoPath } from './node-runner.mjs';
import { prepareJob, plateFileName, fileStem } from '../lib/job.js';
import { buildPuzzle } from '../lib/build.js';
import { parseStl, transformTris, writeBinaryStl, mergeTris, meshStats } from '../lib/stl.js';

export const CASES = [
  { rawName: 'Mia', caseStyle: 'first', heightIn: 2, printer: 'a1' },
  { rawName: 'EMMA', caseStyle: 'caps', heightIn: 3, printer: 'a1' },
  { rawName: 'Jiggy', caseStyle: 'first', heightIn: 2.5, printer: 'a1' },
  { rawName: 'Bartholomew', caseStyle: 'first', heightIn: 3, printer: 'a1' },
  { rawName: 'Lily', caseStyle: 'first', heightIn: 3, printer: 'mk4' }, // splits onto 2 plates
];

const outDir = repoPath('tests/output/');
fs.mkdirSync(outDir, { recursive: true });
const run = await loadNodeRunner();
const summary = [];

for (const input of CASES) {
  let job = prepareJob(input);
  const label = `${job.text} (${input.caseStyle === 'caps' ? 'ALL CAPS' : 'First capital'}, ${input.heightIn} in, ${job.bed.label})`;
  const note = [];
  if (job.status !== 'ready') {
    note.push(`On ${job.bed.label} the app blocks this build: status "${job.status}"` +
      (job.maxHeightIn ? `, offers ${job.maxHeightIn} in instead.` : `, base would be ${job.layout.base.width.toFixed(0)} mm wide (${job.widthAtMin.toFixed(0)} mm at 2 in).`));
    // Still exercise the engine on the requested size with a bed big enough.
    const custom = { width: Math.min(1000, Math.ceil(job.layout.base.width + 20)), depth: 400 };
    job = prepareJob({ ...input, printer: 'custom', customBed: custom });
    note.push(`Rendered on a custom ${custom.width} x ${custom.depth} mm bed to test the geometry and timing.`);
  }
  if (job.status !== 'ready') throw new Error(`${label}: ${job.status}`);
  const steps = [];
  const result = await buildPuzzle(run, job, { onStep: (s) => steps.push(s) });
  const stem = fileStem(job.text);
  const files = [];
  for (const pl of result.plates) {
    const name = plateFileName(job.text, pl.number, result.plates.length);
    fs.writeFileSync(outDir + name, pl.stl);
    files.push(name);
  }
  // The downloadable .scad must reproduce each plate by itself (desktop OpenSCAD path).
  for (const pl of result.plates) {
    const direct = await run(job.scad, 'binstl', ['-D', `part="plate_${pl.number}"`]);
    if (!direct.ok) throw new Error(`.scad plate_${pl.number} failed:\n${direct.log.join('\n')}`);
    const a = meshStats(parseStl(direct.output)), b = pl.bounds;
    const bv = meshStats(parseStl(pl.stl)).volume;
    const same = Math.abs(a.volume - bv) / bv < 1e-4 && [0, 1, 2].every((k) => Math.abs(a.min[k] - b.min[k]) < 1e-3 && Math.abs(a.max[k] - b.max[k]) < 1e-3);
    if (!same) throw new Error(`.scad plate_${pl.number} differs from the site's plate STL`);
    note.push(`.scad part="plate_${pl.number}" rendered directly matches the plate STL (volume ${(bv / 1000).toFixed(1)} cm3, ${(direct.ms / 1000).toFixed(1)} s).`);
  }
  // Assembled view (letters seated in the base) for the fit check.
  const assembled = mergeTris([
    result.baseMesh,
    ...job.layout.letters.map((L) => transformTris(result.letterMeshes[L.ch], { tx: L.x, ty: L.y, tz: job.params.base_floor })),
  ]);
  fs.writeFileSync(outDir + `${stem}-assembled.stl`, writeBinaryStl(assembled));
  fs.writeFileSync(outDir + `${stem}.scad`, job.scad);
  const meta = {
    text: job.text,
    label,
    bed: job.bed,
    params: job.params,
    base: job.layout.base,
    baselineY: job.layout.baselineY,
    fontSize: job.layout.fontSize,
    letters: job.layout.letters.map((L) => ({ ch: L.ch, x: L.x, y: L.y })),
    margins: job.layout.margins,
    grow: job.layout.grow,
    minWall: job.layout.minWall,
    cornerWall: job.layout.cornerWall,
    plates: job.plan.plates.map((pl, i) => ({ file: files[i], placements: pl.placements })),
    timings: result.timings,
    grams: result.grams,
    warnings: result.warnings,
    notes: note,
  };
  fs.writeFileSync(outDir + `${stem}.json`, JSON.stringify(meta, null, 2));
  summary.push(meta);
  console.log(`${label}: ${files.join(', ')}`);
  for (const n of note) console.log(`  ${n}`);
  console.log(`  base ${job.layout.base.width.toFixed(2)} x ${job.layout.base.depth.toFixed(2)} x ${job.params.base_thickness} mm, ` +
    `${result.plates.length} plate(s), ~${result.grams.toFixed(0)} g PLA`);
  console.log(`  render: letters ${(result.timings.letters / 1000).toFixed(1)} s, base ${(result.timings.base / 1000).toFixed(1)} s, ` +
    `plates ${(result.timings.plates / 1000).toFixed(2)} s, total ${(result.timings.total / 1000).toFixed(1)} s`);
  if (result.warnings.length) console.log('  OpenSCAD warnings:\n    ' + result.warnings.join('\n    '));
}
fs.writeFileSync(outDir + 'summary.json', JSON.stringify(summary.map((m) => ({ label: m.label, timings: m.timings, base: m.base, notes: m.notes })), null, 2));
