// Web Worker: runs OpenSCAD (WebAssembly) off the main thread so the page
// stays responsive while a puzzle renders. Loaded as a module worker.
import OpenSCAD from './vendor/openscad/openscad.js';
import { createRunner } from './lib/engine.js';
import { buildPuzzle } from './lib/build.js';

const WASM_URL = new URL('./vendor/openscad/openscad.wasm', import.meta.url);
const cache = new Map(); // rendered meshes, reused across builds
const runners = new Map(); // font file -> Promise<runner>; each font is fetched once, when first needed

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

function getRunner(fontFile) {
  if (!runners.has(fontFile)) {
    const promise = (async () => {
      const [wasmModule, fontRes] = await Promise.all([compileWasm(), fetch(new URL(`./fonts/${fontFile}`, import.meta.url))]);
      if (!fontRes.ok) throw new Error(`Could not load the font ${fontFile} (${fontRes.status}).`);
      const font = new Uint8Array(await fontRes.arrayBuffer());
      return createRunner({ OpenSCAD, wasmModule, fonts: { [fontFile]: font } });
    })();
    promise.catch(() => runners.delete(fontFile));
    runners.set(fontFile, promise);
  }
  return runners.get(fontFile);
}

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  if (type === 'warmup') {
    try {
      await getRunner(data.fontFile || 'Andika-Bold.ttf');
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', id, message: String(err.message || err) });
    }
    return;
  }
  if (type !== 'build') return;
  try {
    const run = await getRunner(data.job.fontFile);
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
