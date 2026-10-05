// three.js preview: "Assembled" (letters seated in the base) and "Print
// layout" (plates as they will print), with the bed drawn underneath.
// Before a build it draws a live preview from the JavaScript layout; after a
// build it shows the real meshes OpenSCAD produced.

import { offsetContour, glyphOuterContours } from './layout.js';

export const LETTER_COLORS = ['#3fb1ea']; // every letter is blue
const BASE_COLOR = '#4cbd88'; // the base is green
const POCKET_COLOR = '#2f8f62'; // darker green: the opening of each pocket
const BED_COLOR = '#f4eee5';
const GRID_COLOR = '#ddd3c5';
const BED_EDGE = '#8a7e72';
const ERROR_COLOR = '#c0392b';
const PLATE_GAP = 40; // mm between beds when showing several plates

/**
 * @param {HTMLElement} host  element that receives the canvas
 * @returns {Promise<object>} the viewer, or { error: 'load' | 'webgl' } when it cannot run
 */
export async function createViewer(host) {
  let THREE;
  try {
    THREE = await import('three');
  } catch {
    return { error: 'load' };
  }
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return { error: 'webgl' };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '3D preview of the puzzle. Use arrow keys to rotate and plus or minus to zoom.');
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 20000);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc9bfb3, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-0.6, -1.2, 2);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(1, 0.8, 0.6);
  scene.add(fill);

  let content = new THREE.Group();
  let focus = content; // what the camera frames
  scene.add(content);
  const orbit = { theta: -Math.PI / 2 - 0.25, phi: 0.95, radius: 400, target: new THREE.Vector3() };
  let fitRadius = 400;
  let pending = false;

  const materials = new Map(); // shared across rebuilds, never disposed
  const mat = (color) => {
    if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0 }));
    return materials.get(color);
  };
  const isShared = (m) => [...materials.values()].includes(m);

  function render() {
    pending = false;
    const { theta, phi, radius, target } = orbit;
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.cos(theta),
      target.y + radius * Math.sin(phi) * Math.sin(theta),
      target.z + radius * Math.cos(phi),
    );
    camera.lookAt(target);
    renderer.render(scene, camera);
  }
  const requestRender = () => {
    if (!pending) { pending = true; requestAnimationFrame(render); }
  };

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    frame(false);
    requestRender();
  }
  new ResizeObserver(resize).observe(host);

  // Fit the camera distance to the content's bounding sphere.
  function frame(resetAngles) {
    const box = new THREE.Box3().setFromObject(focus);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    orbit.target.copy(sphere.center);
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    fitRadius = (sphere.radius / Math.sin(Math.min(vFov, hFov) / 2)) * (camera.aspect < 1.4 ? 1.02 : 0.92);
    orbit.radius = fitRadius;
    if (resetAngles) { orbit.theta = -Math.PI / 2 - 0.25; orbit.phi = 0.95; }
  }

  // ---------------------------------------------------------------- input
  const pointers = new Map();
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      orbit.theta -= dx * 0.008;
      if (e.pointerType !== 'touch') orbit.phi = clampPhi(orbit.phi - dy * 0.008);
      requestRender();
    }
  });
  const release = (e) => pointers.delete(e.pointerId);
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = 0.12;
    const actions = {
      ArrowLeft: () => { orbit.theta += step; },
      ArrowRight: () => { orbit.theta -= step; },
      ArrowUp: () => { orbit.phi = clampPhi(orbit.phi - step); },
      ArrowDown: () => { orbit.phi = clampPhi(orbit.phi + step); },
      '+': () => zoom(1 / 1.15),
      '=': () => zoom(1 / 1.15),
      '-': () => zoom(1.15),
      '0': () => frame(true),
    };
    if (actions[e.key]) { e.preventDefault(); actions[e.key](); requestRender(); }
  });
  const clampPhi = (p) => Math.min(1.45, Math.max(0.05, p));
  function zoom(f) {
    orbit.radius = Math.min(fitRadius * 4, Math.max(fitRadius * 0.15, orbit.radius * f));
    requestRender();
  }

  // ------------------------------------------------------------- geometry
  const shapeFrom = (pts, scale, dx = 0, dy = 0) => {
    const s = new THREE.Shape();
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] * scale + dx, y = pts[i + 1] * scale + dy;
      if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
    }
    s.closePath();
    return s;
  };
  const pathFrom = (pts, scale, dx = 0, dy = 0) => {
    const p = new THREE.Path();
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] * scale + dx, y = pts[i + 1] * scale + dy;
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    p.closePath();
    return p;
  };
  const extrude = (shapes, depth) => new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments: 1 });

  /** Letter solid from glyph outlines (pen origin at 0,0). */
  function previewLetterGeometry(glyph, scale, thickness, bridgeWidth) {
    const shapes = glyph.shapes.map((sh) => {
      const s = shapeFrom(sh.outer, scale);
      s.holes = sh.holes.map((h) => pathFrom(h, scale));
      return s;
    });
    for (const [x0, y0, x1, y1] of glyph.bridges) {
      const cx = ((x0 + x1) / 2) * scale, h = bridgeWidth / 2;
      shapes.push(shapeFrom([cx - h, y0 * scale, cx + h, y0 * scale, cx + h, y1 * scale, cx - h, y1 * scale], 1));
    }
    return extrude(shapes, thickness);
  }

  function octagon(w, d, c) {
    return [c, 0, w - c, 0, w, c, w, d - c, w - c, d, c, d, 0, d - c, 0, c];
  }

  /**
   * The base as it looks before a build: a solid slab with the opening of every pocket drawn on its
   * top face. The openings are the real shapes from the layout (letter outline + clearance + lead-in,
   * including the channel for the bar between an i / j dot and its stem); the finished build shows
   * the true recessed pockets. Dot, bar and stem are separate overlapping flats, so no boolean is needed.
   */
  function previewBase(layout, p, glyphs) {
    const g = new THREE.Group();
    const outline = octagon(layout.base.width, layout.base.depth, p.corner_chamfer);
    g.add(new THREE.Mesh(extrude([shapeFrom(outline, 1)], p.base_thickness), mat(BASE_COLOR)));
    const delta = p.fit_clearance + p.lead_in;
    for (const L of layout.letters) {
      for (const c of glyphOuterContours(glyphs[L.ch], layout.fontSize, p.bridge_width)) {
        const flat = new THREE.Mesh(new THREE.ShapeGeometry(shapeFrom(offsetContour(c, delta, 0.5), 1, L.x, L.y)), mat(POCKET_COLOR));
        flat.position.z = p.base_thickness + 0.05;
        g.add(flat);
      }
    }
    return g;
  }

  function meshFromTris(tris, material) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, material);
  }

  function bedObject(bed, withGrid, offsetX = 0) {
    const g = new THREE.Group();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(bed.width, bed.depth), new THREE.MeshBasicMaterial({ color: BED_COLOR, transparent: true, opacity: withGrid ? 1 : 0.55 }));
    plane.position.set(offsetX + bed.width / 2, bed.depth / 2, -0.3);
    g.add(plane);
    const pts = [];
    if (withGrid) {
      for (let x = 10; x < bed.width; x += 10) pts.push(x, 0, x, bed.depth);
      for (let y = 10; y < bed.depth; y += 10) pts.push(0, y, bed.width, y);
      const pos = [];
      for (let i = 0; i < pts.length; i += 4) pos.push(pts[i] + offsetX, pts[i + 1], -0.2, pts[i + 2] + offsetX, pts[i + 3], -0.2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: GRID_COLOR })));
    }
    g.add(outlineLoop([0, 0, bed.width, 0, bed.width, bed.depth, 0, bed.depth], BED_EDGE, offsetX, 0, -0.1, !withGrid));
    return g;
  }

  function outlineLoop(flat, color, dx = 0, dy = 0, z = 0, dashed = false) {
    const pos = [];
    for (let i = 0; i < flat.length; i += 2) pos.push(flat[i] + dx, flat[i + 1] + dy, z);
    pos.push(flat[0] + dx, flat[1] + dy, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const material = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 6, gapSize: 4 })
      : new THREE.LineBasicMaterial({ color });
    const line = new THREE.Line(geo, material);
    if (dashed) line.computeLineDistances();
    return line;
  }

  function disposeContent() {
    content.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !isShared(o.material)) o.material.dispose();
    });
    scene.remove(content);
    content = new THREE.Group();
    focus = content;
    scene.add(content);
  }

  /**
   * @param {object} s
   * @param {'assembled'|'plate'} s.view
   * @param {object} s.layout, s.params, s.bed, s.glyphs
   * @param {object} [s.plan]   planPlates() result (needed for the plate view)
   * @param {object} [s.built]  build result with baseMesh / letterMeshes
   * @param {boolean} [s.tooBig]
   * @param {boolean} [s.resetCamera]
   */
  function show(s) {
    disposeContent();
    const { layout, params: p, bed, glyphs } = s;
    if (!layout) { requestRender(); return; }
    const letterMat = (i) => mat(LETTER_COLORS[i % LETTER_COLORS.length]);
    const letterGeo = new Map();
    const getLetter = (ch) => {
      if (!letterGeo.has(ch)) {
        letterGeo.set(ch, s.built
          ? (() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(s.built.letterMeshes[ch], 3)); g.computeVertexNormals(); return g; })()
          : previewLetterGeometry(glyphs[ch], layout.fontSize, p.letter_thickness, p.bridge_width));
      }
      return letterGeo.get(ch);
    };
    const makeBase = () => (s.built ? meshFromTris(s.built.baseMesh, mat(BASE_COLOR)) : previewBase(layout, p, glyphs));

    if (s.view === 'plate' && s.plan && s.plan.ok) {
      s.plan.plates.forEach((pl, k) => {
        const ox = k * (bed.width + PLATE_GAP);
        content.add(bedObject(bed, true, ox));
        for (const q of pl.placements) {
          const obj = q.kind === 'base' ? makeBase() : new THREE.Mesh(getLetter(layout.letters[q.index].ch), letterMat(q.index));
          obj.rotation.z = (q.rot * Math.PI) / 180;
          obj.position.set(q.tx + ox, q.ty, 0);
          content.add(obj);
        }
      });
    } else {
      // Assembled: the base centred on the bed outline; the camera frames the puzzle
      // (or puzzle and bed together when it does not fit).
      const ox = (bed.width - layout.base.width) / 2, oy = (bed.depth - layout.base.depth) / 2;
      content.add(bedObject(bed, false));
      focus = new THREE.Group();
      content.add(focus);
      const base = makeBase();
      base.position.set(ox, oy, 0);
      focus.add(base);
      layout.letters.forEach((L, i) => {
        const m = new THREE.Mesh(getLetter(L.ch), letterMat(i));
        m.position.set(ox + L.x, oy + L.y, p.base_floor);
        focus.add(m);
      });
      if (s.tooBig) {
        focus = content;
        content.add(outlineLoop(octagon(layout.base.width, layout.base.depth, p.corner_chamfer), ERROR_COLOR, ox, oy, p.base_thickness + 0.2));
        content.add(outlineLoop(octagon(layout.base.width, layout.base.depth, p.corner_chamfer), ERROR_COLOR, ox, oy, 0.05));
      }
    }
    frame(!!s.resetCamera);
    requestRender();
  }

  resize();
  return {
    show,
    zoomIn: () => zoom(1 / 1.2),
    zoomOut: () => zoom(1.2),
    reset: () => { frame(true); requestRender(); },
  };
}
