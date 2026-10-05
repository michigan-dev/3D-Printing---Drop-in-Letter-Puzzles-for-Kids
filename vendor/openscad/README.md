# OpenSCAD WebAssembly build (vendored)

These files are the official OpenSCAD WebAssembly build, unmodified, from
https://files.openscad.org/playground/ (the build used by the OpenSCAD Playground).

| File | Source | SHA-256 |
|---|---|---|
| `openscad.js`, `openscad.wasm` | `OpenSCAD-2025.03.25.wasm24456-WebAssembly-web.zip` | js `904a47f2…8d303f890d`, wasm `f72ce246…5c80c5ecf26` |

- Version: OpenSCAD 2025.03.25 (wasm24456), with the Manifold geometry backend (`--backend=manifold`).
- Size: `openscad.wasm` is 9.6 MB, well under GitHub's 50 MB warning and 100 MB limit.
- The zip's published checksum (`.sha256` next to it on files.openscad.org) was verified on download.

## License

OpenSCAD is free software under the GNU General Public License, version 2 or later
(see `COPYING`). Source code: https://github.com/openscad/openscad and the WebAssembly
build scripts at https://github.com/openscad/openscad-wasm. The website runs these files
unmodified as a separate program in a Web Worker.

To update: download a newer `*-WebAssembly-web.zip` from the URL above, check its
`.sha256`, replace both files, then run `node tools/build-glyphs.mjs`, `node --test`
and `node tests/render.mjs` to confirm nothing moved.
