#!/usr/bin/env python3
"""Validate the STLs in tests/output/ (made by tests/render.mjs).

For every plate STL:
  * every body is watertight, consistently wound, positive volume
  * no zero-area (zero-thickness) faces
  * minimum Z = 0 for every body
  * every body lies inside the bed
  * no two bodies overlap, and all are at least part_spacing apart
  * body count = 1 base + one per letter (so i/j with dots are one piece)
And for the base:
  * outer size matches the expected width x depth x thickness
  * at the top surface: pocket openings sit side_margin from the top face's
    edge, walls between pockets >= letter_gap, corner walls >= corner_min_wall

Usage: python3 tests/validate_stl.py   (needs: pip install -r tests/requirements.txt)
"""
import json
import sys
from pathlib import Path

import numpy as np
import trimesh
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union

OUT = Path(__file__).parent / "output"
TOL = 0.01  # mm
failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
    return cond


def section_polygons(mesh, z):
    """Cross-section of a mesh at height z as a shapely (Multi)Polygon."""
    sec = mesh.section(plane_origin=[0, 0, z], plane_normal=[0, 0, 1])
    if sec is None:
        return MultiPolygon()
    planar, to3d = sec.to_2D()
    polys = []
    for p in planar.polygons_full:
        pts = np.column_stack([p.exterior.xy[0], p.exterior.xy[1], np.zeros(len(p.exterior.xy[0])), np.ones(len(p.exterior.xy[0]))])
        ext = (to3d @ pts.T).T[:, :2]
        holes = []
        for r in p.interiors:
            h = np.column_stack([r.xy[0], r.xy[1], np.zeros(len(r.xy[0])), np.ones(len(r.xy[0]))])
            holes.append((to3d @ h.T).T[:, :2])
        polys.append(Polygon(ext, holes))
    return unary_union(polys)


def validate_case(meta_path):
    meta = json.loads(meta_path.read_text())
    p, bed = meta["params"], meta["bed"]
    print(f"\n== {meta['label']}")
    for n in meta["notes"]:
        print(f"   note: {n}")
    total_bodies = 0
    base_mesh = None
    for plate in meta["plates"]:
        mesh = trimesh.load(OUT / plate["file"], force="mesh")
        bodies = mesh.split(only_watertight=False)
        total_bodies += len(bodies)
        degenerate = int((mesh.area_faces < 1e-9).sum())
        check(degenerate == 0, f"{plate['file']}: {degenerate} zero-area faces")
        bounds2d = []
        for i, b in enumerate(bodies):
            tag = f"{plate['file']} body {i}"
            check(b.is_watertight, f"{tag}: not watertight")
            check(b.is_winding_consistent, f"{tag}: inconsistent winding")
            check(b.volume > 0, f"{tag}: non-positive volume {b.volume}")
            lo, hi = b.bounds
            check(abs(lo[2]) < 1e-4, f"{tag}: min Z = {lo[2]:.4f}, not 0")
            check(lo[0] >= -1e-4 and lo[1] >= -1e-4 and hi[0] <= bed["width"] + 1e-4 and hi[1] <= bed["depth"] + 1e-4,
                  f"{tag}: outside bed {bed['width']}x{bed['depth']}: {lo[:2]}..{hi[:2]}")
            bounds2d.append((lo, hi))
            if abs(hi[2] - p["base_thickness"]) < 1e-3 and (hi[0] - lo[0]) > 0.9 * min(meta["base"]["width"], meta["base"]["depth"]) and len(b.faces) > 500 and base_mesh is None and (hi[1] - lo[1]) >= meta["base"]["depth"] - 1:
                base_mesh = b
        # spacing between bodies (bounding boxes at least part_spacing apart => no overlap);
        # 0.005 mm tolerance because STL stores float32 coordinates
        min_gap = np.inf
        for i in range(len(bounds2d)):
            for j in range(i + 1, len(bounds2d)):
                (a0, a1), (b0, b1) = bounds2d[i], bounds2d[j]
                gx = max(b0[0] - a1[0], a0[0] - b1[0])
                gy = max(b0[1] - a1[1], a0[1] - b1[1])
                min_gap = min(min_gap, max(gx, gy))
        if len(bounds2d) > 1:
            check(min_gap >= p["part_spacing"] - 0.005, f"{plate['file']}: parts only {min_gap:.2f} mm apart")
        print(f"   {plate['file']}: {len(bodies)} bodies, all watertight={all(b.is_watertight for b in bodies)}, "
              f"zero-area faces={degenerate}, min Z={min(b.bounds[0][2] for b in bodies):.4f}, "
              f"min gap between parts={min_gap:.2f} mm, bed {bed['width']}x{bed['depth']}")
    expected_bodies = 1 + len(meta["letters"])
    check(total_bodies == expected_bodies, f"expected {expected_bodies} bodies (base + letters), found {total_bodies}")

    # ---- base dimensions
    if not check(base_mesh is not None, "could not identify the base body"):
        return
    ext = base_mesh.extents
    w, d = sorted(ext[:2], reverse=True) if meta["base"]["width"] >= meta["base"]["depth"] else sorted(ext[:2])
    ew, ed, et = meta["base"]["width"], meta["base"]["depth"], p["base_thickness"]
    ok = abs(w - ew) < TOL and abs(d - ed) < TOL and abs(ext[2] - et) < 1e-3
    check(ok, f"base {w:.3f} x {d:.3f} x {ext[2]:.3f}, expected {ew:.3f} x {ed:.3f} x {et}")
    print(f"   base measured {w:.2f} x {d:.2f} x {ext[2]:.2f} mm, expected {ew:.2f} x {ed:.2f} x {et:.2f} mm "
          f"({w / 25.4:.2f} x {d / 25.4:.2f} in) -> {'OK' if ok else 'MISMATCH'}")

    # ---- margins and walls, measured on the assembled base (not rotated)
    asm = trimesh.load(OUT / f"name-puzzle-{meta['text'].lower()}-assembled.stl", force="mesh")
    base = max(asm.split(only_watertight=False), key=lambda b: b.extents[0] * b.extents[1])
    z = p["base_thickness"] - 0.0005
    top = section_polygons(base, z)
    top = max(top.geoms, key=lambda g: g.area) if isinstance(top, MultiPolygon) else top
    outer = Polygon(top.exterior)
    holes = [Polygon(r) for r in top.interiors]
    # pockets are holes whose area is large (counter posts are separate polygons inside holes)
    pockets = [h for h in holes if h.area > 5]
    check(len(pockets) == len(meta["letters"]), f"expected {len(meta['letters'])} pocket openings, found {len(pockets)}")
    ox0, oy0, ox1, oy1 = outer.bounds
    px0 = min(h.bounds[0] for h in pockets); py0 = min(h.bounds[1] for h in pockets)
    px1 = max(h.bounds[2] for h in pockets); py1 = max(h.bounds[3] for h in pockets)
    meas = {"left": px0 - ox0, "right": ox1 - px1, "bottom": py0 - oy0, "top": oy1 - py1}
    exp = {k: p["side_margin"] + meta["grow"].get(k, 0) for k in meas}
    for k in meas:
        check(abs(meas[k] - exp[k]) < 0.02, f"{k} margin {meas[k]:.3f}, expected {exp[k]:.3f}")
    print("   top-surface margins (mm): " + ", ".join(f"{k} {meas[k]:.3f} (exp {exp[k]:.3f})" for k in meas))
    pockets.sort(key=lambda h: h.bounds[0])
    walls = [pockets[i].distance(pockets[j]) for i in range(len(pockets)) for j in range(i + 1, len(pockets))]
    if walls:
        check(min(walls) >= p["letter_gap"] - 0.02, f"pocket wall {min(walls):.3f} < {p['letter_gap']}")
        print(f"   thinnest wall between pockets: {min(walls):.3f} mm (min {p['letter_gap']}), layout predicted {meta['minWall']:.3f}")
    edge_wall = min(h.distance(outer.exterior) for h in pockets)
    check(edge_wall >= min(p["side_margin"], p["corner_min_wall"]) - 0.02, f"wall to outer edge {edge_wall:.3f}")
    print(f"   thinnest wall to the edge (incl. corner cuts): {edge_wall:.3f} mm (min {p['corner_min_wall']} at corners, "
          f"{p['side_margin']} at sides), layout predicted corner wall {meta['cornerWall']:.3f}")


def main():
    cases = sorted(p for p in OUT.glob("name-puzzle-*.json"))
    if not cases:
        sys.exit("No test output found: run `node tests/render.mjs` first.")
    for c in cases:
        validate_case(c)
    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print(f"All STL checks passed for {len(cases)} cases.")


if __name__ == "__main__":
    main()
