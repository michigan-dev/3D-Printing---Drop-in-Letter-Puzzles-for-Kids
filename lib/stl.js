// Minimal binary STL helpers: parse, move, merge, write, and measure.
// Triangles are kept as Float32Array with 9 numbers per triangle.

/** Parse binary or ASCII STL into a Float32Array of triangle vertices. */
export function parseStl(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength >= 84) {
    const count = dv.getUint32(80, true);
    if (84 + count * 50 === u8.byteLength) {
      const tris = new Float32Array(count * 9);
      for (let t = 0; t < count; t++) {
        const o = 84 + t * 50 + 12; // skip the normal
        for (let k = 0; k < 9; k++) tris[t * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return tris;
    }
  }
  const text = new TextDecoder().decode(u8);
  const nums = [];
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) nums.push(+m[1], +m[2], +m[3]);
  return new Float32Array(nums);
}

/** Rotate about Z by `rot` degrees (multiples of 90 are exact), then translate. */
export function transformTris(tris, { tx = 0, ty = 0, tz = 0, rot = 0 }) {
  const out = new Float32Array(tris.length);
  const r = ((rot % 360) + 360) % 360;
  const c = r === 0 ? 1 : r === 90 ? 0 : r === 180 ? -1 : r === 270 ? 0 : Math.cos((r * Math.PI) / 180);
  const s = r === 0 ? 0 : r === 90 ? 1 : r === 180 ? 0 : r === 270 ? -1 : Math.sin((r * Math.PI) / 180);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1];
    out[i] = x * c - y * s + tx;
    out[i + 1] = x * s + y * c + ty;
    out[i + 2] = tris[i + 2] + tz;
  }
  return out;
}

export function mergeTris(list) {
  const total = list.reduce((a, t) => a + t.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const t of list) { out.set(t, o); o += t.length; }
  return out;
}

/** Write a binary STL (normals computed from the winding). */
export function writeBinaryStl(tris, header = 'Name Puzzle Maker') {
  const count = tris.length / 9;
  const buf = new ArrayBuffer(84 + count * 50);
  const dv = new DataView(buf);
  const head = new TextEncoder().encode(header.slice(0, 79));
  new Uint8Array(buf, 0, head.length).set(head);
  dv.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const b = t * 9;
    const ux = tris[b + 3] - tris[b], uy = tris[b + 4] - tris[b + 1], uz = tris[b + 5] - tris[b + 2];
    const vx = tris[b + 6] - tris[b], vy = tris[b + 7] - tris[b + 1], vz = tris[b + 8] - tris[b + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const o = 84 + t * 50;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, tris[b + k], true);
  }
  return new Uint8Array(buf);
}

/** Volume (mm^3), surface area (mm^2) and bounding box of a closed mesh. */
export function meshStats(tris) {
  let vol = 0, area = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let b = 0; b < tris.length; b += 9) {
    const ax = tris[b], ay = tris[b + 1], az = tris[b + 2];
    const bx = tris[b + 3], by = tris[b + 4], bz = tris[b + 5];
    const cx = tris[b + 6], cy = tris[b + 7], cz = tris[b + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    for (let k = 0; k < 9; k++) {
      const a = k % 3, v = tris[b + k];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { volume: Math.abs(vol), area, min, max };
}

/**
 * Rough PLA weight. Walls and top/bottom skins (~0.8 mm) are solid, the rest
 * is infill. A guide only; your slicer has the real number.
 */
export function estimateGrams({ volume, area }, { infill = 0.15, density = 1.24, shell = 0.8 } = {}) {
  const shellVol = Math.min(volume, area * shell);
  const mm3 = shellVol + infill * (volume - shellVol);
  return (mm3 / 1000) * density;
}
