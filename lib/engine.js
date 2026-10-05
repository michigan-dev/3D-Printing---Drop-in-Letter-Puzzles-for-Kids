// Thin wrapper around the official OpenSCAD WebAssembly build.
// Shared by worker.js (browser) and the node test/tool scripts so that the
// STLs we validate are produced by exactly the same code path as the site.
//
// An Emscripten OpenSCAD instance can only run main() once, so every call
// gets a fresh instance. The compiled WebAssembly.Module (browser) or the
// raw bytes (node) are reused, which keeps instantiation cheap.

export const FONT_VFS_DIR = '/fonts';

/**
 * @param {object} opts
 * @param {Function} opts.OpenSCAD       default export of vendor/openscad/openscad.js
 * @param {WebAssembly.Module} [opts.wasmModule]  precompiled module (browser)
 * @param {Uint8Array} [opts.wasmBinary]         raw wasm bytes (node)
 * @param {Record<string, Uint8Array>} opts.fonts  file name -> TTF bytes
 */
export function createRunner({ OpenSCAD, wasmModule, wasmBinary, fonts }) {
  /**
   * Run OpenSCAD once.
   * @param {string} scad     source text
   * @param {string} format   'binstl' | 'stl' | 'svg' | 'echo'
   * @returns {Promise<{ok: boolean, output: Uint8Array|null, log: string[], ms: number}>}
   */
  return async function run(scad, format = 'binstl', extraArgs = []) {
    const log = [];
    const moduleArgs = {
      noInitialRun: true,
      print: (t) => log.push(t),
      printErr: (t) => log.push(t),
    };
    if (wasmModule) {
      moduleArgs.instantiateWasm = (imports, done) => {
        WebAssembly.instantiate(wasmModule, imports).then((inst) => done(inst, wasmModule));
        return {};
      };
    } else if (wasmBinary) {
      moduleArgs.wasmBinary = wasmBinary;
    }
    const inst = await OpenSCAD(moduleArgs);
    inst.FS.mkdirTree(FONT_VFS_DIR);
    for (const [name, bytes] of Object.entries(fonts)) {
      inst.FS.writeFile(`${FONT_VFS_DIR}/${name}`, bytes);
    }
    inst.FS.writeFile('/input.scad', scad);
    const ext = format === 'binstl' ? 'stl' : format;
    const outPath = `/output.${ext}`;
    const args = ['/input.scad', '-o', outPath, '--backend=manifold', ...extraArgs];
    if (format === 'binstl') args.push('--export-format=binstl');
    const t0 = Date.now();
    let rc;
    try {
      rc = inst.callMain(args);
    } catch (err) {
      log.push(`OpenSCAD crashed: ${err && err.message ? err.message : err}`);
      rc = -1;
    }
    const ms = Date.now() - t0;
    let output = null;
    try {
      output = inst.FS.readFile(outPath);
    } catch {
      output = null;
    }
    const failed = rc !== 0 || !output || log.some((l) => /^ERROR:/.test(l));
    return { ok: !failed, output, log, ms };
  };
}
