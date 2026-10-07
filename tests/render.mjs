#!/usr/bin/env node
// Renders real STLs for the test names with the same wasm build, font and
// pipeline the website uses, and writes them to tests/output/ along with a
// JSON file of the expected numbers for tests/validate_stl.py.
//
// Usage: node tests/render.mjs

import fs from 'node:fs';
import { loadNodeRunner, repoPath } from './node-runner.mjs';
import { prepareJob, nameSeparatePlates, isAlreadySplit } from '../lib/job.js';
import { planPlates } from '../lib/layout.js';
import { buildPuzzle, makePlateStls } from '../lib/build.js';
import { parseStl, transformTris, writeBinaryStl, mergeTris, meshStats } from '../lib/stl.js';

export const CASES = [
  { rawName: 'Mia', caseStyle: 'first', heightIn: 2, printer: 'a1' },
  { rawName: 'EMMA', caseStyle: 'caps', heightIn: 3, printer: 'a1' },
  { rawName: 'Jiggy', caseStyle: 'first', heightIn: 2.5, printer: 'a1' },
  { rawName: 'Bartholomew', caseStyle: 'first', heightIn: 3, printer: 'a1' },
  { rawName: 'Lily', caseStyle: 'first', heightIn: 3, printer: 'mk4' }, // splits onto 2 plates
  { rawName: 'Ellie', caseStyle: 'first', printer: 'a1' }, // default 14 mm, dotted i, chamfered letters
  { rawName: 'Charlotte', caseStyle: 'first', heightMm: 40, printer: 'a1' }, // too long to lie straight: base turned 45 degrees
  { rawName: 'Patrick', caseStyle: 'first', font: 'serif', printer: 'a1' }, // Bree Serif at the default 14 mm: dotted i, serif I/j family
  { rawName: 'Ijay', caseStyle: 'first', font: 'serif', heightMm: 40, printer: 'a1' }, // serif capital I and a j with its top line
];

const outDir = repoPath('tests/output/');
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (!f.startsWith('.')) fs.rmSync(outDir + f); // no stale files
const STAMP = '2026-01-01_12-00-00'; // fixed, so file names (typed word + date and time) are the same on every run
const run = await loadNodeRunner();
const summary = [];

for (const input of CASES) {
  let job = prepareJob({ ...input, fileStamp: STAMP });
  const label = `${job.text} (${input.caseStyle === 'caps' ? 'ALL CAPS' : 'First capital'}, ${job.heightMm} mm / ${(job.heightMm / 25.4).toFixed(2)} in, ${job.fontFamily}, ${job.bed.label})`;
  const note = [];
  if (job.status !== 'ready') {
    note.push(`On ${job.bed.label} the app blocks this build: status "${job.status}"` +
      (job.maxHeightMm ? `, offers ${job.maxHeightMm} mm instead.` : `, base would be ${job.layout.base.width.toFixed(0)} mm wide (${job.widthAtMin.toFixed(0)} mm at ${job.minHeightMm} mm).`));
    // Still exercise the engine on the requested size with a bed big enough.
    const custom = { width: Math.min(1000, Math.ceil(job.layout.base.width + 20)), depth: 400 };
    job = prepareJob({ ...input, printer: 'custom', customBed: custom, fileStamp: STAMP });
    note.push(`Rendered on a custom ${custom.width} x ${custom.depth} mm bed to test the geometry and timing.`);
  }
  if (job.status !== 'ready') throw new Error(`${label}: ${job.status}`);
  const steps = [];
  const result = await buildPuzzle(run, job, { onStep: (s) => steps.push(s) });
  const stem = job.stem;
  const files = [];
  for (const pl of result.plates) {
    const name = pl.file;
    fs.writeFileSync(outDir + name, pl.stl);
    files.push(name);
  }
  // "Two colours?" downloads: base alone and letters alone, as the app builds them from the same meshes.
  let separate = [];
  if (!isAlreadySplit(job.plan.plates)) {
    const plan2 = planPlates(job.layout, job.bed, job.params, { separate: true });
    nameSeparatePlates(job.stem, plan2.plates);
    const stls = makePlateStls(plan2, job.layout, result.baseMesh, result.letterMeshes, job.bed);
    separate = plan2.plates.map((pl, i) => {
      fs.writeFileSync(outDir + pl.file, stls[i].stl);
      return { file: pl.file, placements: pl.placements, hasBase: pl.hasBase, letterCount: pl.letterCount };
    });
    note.push(`two-colour downloads: ${separate.map((s) => s.file).join(', ')}`);
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
    stem,
    label,
    bed: job.bed,
    params: job.params,
    base: job.layout.base,
    baselineY: job.layout.baselineY,
    fontSize: job.layout.fontSize,
    // The un-chamfered outline of every letter in base coordinates (mm): what the pocket is cut from.
    letters: job.layout.letters.map((L) => ({
      ch: L.ch, x: L.x, y: L.y,
      outline: {
        shapes: job.glyphs[L.ch].shapes.map((sh) => ({
          outer: sh.outer.map((v, i) => v * job.layout.fontSize + (i % 2 ? L.y : L.x)),
          holes: sh.holes.map((h) => h.map((v, i) => v * job.layout.fontSize + (i % 2 ? L.y : L.x))),
        })),
        bars: job.glyphs[L.ch].bridges.map(([x0, y0, x1, y1]) => {
          const cx = ((x0 + x1) / 2) * job.layout.fontSize + L.x, half = job.params.bridge_width / 2;
          return [cx - half, y0 * job.layout.fontSize + L.y, cx + half, y1 * job.layout.fontSize + L.y];
        }),
      },
    })),
    margins: job.layout.margins,
    grow: job.layout.grow,
    minWall: job.layout.minWall,
    cornerWall: job.layout.cornerWall,
    plates: job.plan.plates.map((pl, i) => ({ file: files[i], placements: pl.placements })),
    separate,
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
