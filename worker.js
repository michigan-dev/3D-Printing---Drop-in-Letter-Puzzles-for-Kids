// Web Worker: runs OpenSCAD (WebAssembly) off the main thread so the page
// stays responsive while a puzzle renders. Loaded as a module worker.
import OpenSCAD from './vendor/openscad/openscad.js';
import { createRunner } from './lib/engine.js';
import { buildPuzzle } from './lib/build.js';

const WASM_URL = new URL('./vendor/openscad/openscad.wasm', import.meta.url);
const FONT_URL = new URL('./fonts/Andika-Bold.ttf', import.meta.url);
const cache = new Map(); // rendered meshes, reused across builds
let runnerPromise = null;

async function compileWasm() {
  try {
    return await WebAssembly.compileStreaming(fetch(WASM_URL));
  } catch {
    // e.g. a server that does not send application/wasm
    const res = await fetch(WASM_URL);
    if (!res.ok) throw new Error(`Could not load the OpenSCAD engine (${res.status}).`);
    return WebAssembly.compile(await res.arrayBuffer());
  }
}

function getRunner() {
  runnerPromise ??= (async () => {
    const [wasmModule, fontRes] = await Promise.all([compileWasm(), fetch(FONT_URL)]);
    if (!fontRes.ok) throw new Error(`Could not load the Andika font (${fontRes.status}).`);
    const font = new Uint8Array(await fontRes.arrayBuffer());
    return createRunner({ OpenSCAD, wasmModule, fonts: { 'Andika-Bold.ttf': font } });
  })();
  runnerPromise.catch(() => { runnerPromise = null; });
  return runnerPromise;
}

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  if (type === 'warmup') {
    try {
      await getRunner();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', id, message: String(err.message || err) });
    }
    return;
  }
  if (type !== 'build') return;
  try {
    const run = await getRunner();
    const result = await buildPuzzle(run, data.job, {
      cache,
      onStep: (step) => self.postMessage({ type: 'step', id, step }),
    });
    // Copy cached meshes so transferring them never empties the cache.
    const letterMeshes = {};
    for (const [ch, tris] of Object.entries(result.letterMeshes)) letterMeshes[ch] = tris.slice();
    const baseMesh = result.baseMesh.slice();
    const transfer = [baseMesh.buffer, ...Object.values(letterMeshes).map((t) => t.buffer), ...result.plates.map((p) => p.stl.buffer)];
    self.postMessage({ type: 'done', id, result: { ...result, baseMesh, letterMeshes } }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err.message || err) });
  }
};
