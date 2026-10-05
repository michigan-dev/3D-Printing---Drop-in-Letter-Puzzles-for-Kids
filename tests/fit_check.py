#!/usr/bin/env python3
"""Fit check on the assembled test puzzles in tests/output/.

At mid pocket depth (below the lead-in) it slices the base and the seated
letters, then for every letter:
  * builds the expected pocket: the letter outline offset outward by
    fit_clearance with mitred corners (what OpenSCAD's offset(delta=...) does)
  * samples points along the real pocket wall and checks each lies on the
    expected outline, and samples the expected outline against the real wall
  * samples the letter outline and checks the gap to the pocket wall is never
    below fit_clearance (it is exactly fit_clearance along straight and curved
    edges, and larger only in inside corners, as any outward offset must be)
  * checks the letter's top and bottom faces are chamfered (45 degrees, inset
    from the full outline) and the bar joining an i / j dot is bridge_width wide
  * checks that the letter slice is one connected piece (i, j and any other
    dotted letter included) and that counters keep a solid post in the pocket

Usage: python3 tests/fit_check.py
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import trimesh
from shapely.geometry import Polygon, MultiPolygon, LineString
from shapely.ops import unary_union

from validate_stl import section_polygons, OUT

failures = []


def as_list(g):
    if g.is_empty:
        return []
    return list(g.geoms) if isinstance(g, MultiPolygon) else [g]


def boundary_samples(poly, step=0.25):
    pts = []
    for ring in [poly.exterior, *poly.interiors]:
        n = max(8, int(ring.length / step))
        pts += [ring.interpolate(i / n, normalized=True) for i in range(n)]
    return pts


for meta_path in sorted(OUT.glob("name-puzzle-*.json")):
    meta = json.loads(meta_path.read_text())
    p = meta["params"]
    c = p["fit_clearance"]
    asm = trimesh.load(OUT / f"name-puzzle-{meta['text'].lower()}-assembled.stl", force="mesh")
    bodies = asm.split(only_watertight=False)
    base = max(bodies, key=lambda b: b.extents[0] * b.extents[1])
    letters = [b for b in bodies if b is not base]
    z = p["base_floor"] + (p["pocket_depth"] - p["lead_in"]) / 2
    base_sec = as_list(section_polygons(base, z))
    slab = max(base_sec, key=lambda g: g.area)
    posts = [g for g in base_sec if g is not slab]
    scad = (OUT / f"name-puzzle-{meta['text'].lower()}.scad").read_text()
    bridges = {m.group(1): [float(v) for v in m.group(2).split(",")]
               for m in re.finditer(r'\["(\w)", \[([^\]]+)\]\]', scad[scad.index("glyph_bridges"):])}
    print(f"\n== {meta['label']}: slice at z = {z:.2f} mm, clearance {c} mm")
    if len(letters) != len(meta["letters"]):
        failures.append(f"{meta['text']}: {len(letters)} letter bodies for {len(meta['letters'])} letters")
    worst_all = 0
    for b in sorted(letters, key=lambda b: b.bounds[0][0]):
        sec = as_list(section_polygons(b, z))
        # find the letter by position: the closest pen x to the body's left edge
        ch = min(meta["letters"], key=lambda L: abs(L["x"] - b.bounds[0][0]))["ch"]
        one_piece = len(sec) == 1 and len(b.split(only_watertight=False)) == 1
        if not one_piece:
            failures.append(f"{meta['text']} '{ch}': letter is {len(sec)} pieces")
        letter = unary_union(sec)
        # the pocket: the hole in the slab around this letter, minus any posts inside it
        hole = next(Polygon(r) for r in slab.interiors if Polygon(r).contains(letter.representative_point()))
        inner_posts = [q for q in posts if hole.contains(q)]
        pocket = hole.difference(unary_union(inner_posts)) if inner_posts else hole
        expected = letter.buffer(c, join_style="mitre", mitre_limit=1e6)
        on_expected = max(expected.boundary.distance(pt) for pt in boundary_samples(pocket))
        on_pocket = max(pocket.boundary.distance(pt) for pt in boundary_samples(expected))
        dev = max(on_expected, on_pocket)
        gaps = np.array([pocket.boundary.distance(pt) for pt in boundary_samples(letter)])
        exact = float(np.mean(np.abs(gaps - c) < 0.002))
        worst_all = max(worst_all, dev)
        ok = dev < 0.005 and gaps.min() > c - 0.002 and one_piece
        if not ok:
            failures.append(f"{meta['text']} '{ch}': pocket off the offset outline by {dev:.4f} mm, min gap {gaps.min():.4f}")
        # chamfers: just inside the top / bottom faces the outline is pulled in from the full outline
        zt, zb = b.bounds[1][2], b.bounds[0][2]
        ct, cb = p["letter_chamfer"], p["letter_bottom_chamfer"]
        top_sec = unary_union(as_list(section_polygons(b, zt - 0.05)))
        bot_sec = unary_union(as_list(section_polygons(b, zb + 0.05)))
        cham_ok = True
        if ct > 0:
            cham_ok &= letter.buffer(-(ct - 0.15), join_style="mitre", mitre_limit=1e6).buffer(0.02).contains(top_sec.buffer(-0.02))
            cham_ok &= top_sec.area < letter.area
        if cb > 0:
            cham_ok &= letter.buffer(-(cb - 0.15), join_style="mitre", mitre_limit=1e6).buffer(0.02).contains(bot_sec.buffer(-0.02))
            cham_ok &= bot_sec.area < letter.area
        cham_ok &= abs((zt - zb) - p["letter_thickness"]) < 1e-3
        if not cham_ok:
            failures.append(f"{meta['text']} '{ch}': top/bottom faces are not chamfered by {ct}/{cb} mm")
        bar = ""
        if ch in bridges:
            x0, y0, x1, y1 = bridges[ch]
            L = next(L for L in meta["letters"] if L["ch"] == ch and abs(L["x"] - b.bounds[0][0]) < 20)
            yy = L["y"] + (y0 + y1) / 2 * meta["fontSize"]
            hit = letter.intersection(LineString([(b.bounds[0][0] - 1, yy), (b.bounds[1][0] + 1, yy)]))
            width = hit.length
            bar = f", dot bar {width:.2f} mm wide"
            if abs(width - p["bridge_width"]) > 0.02:
                failures.append(f"{meta['text']} '{ch}': dot bar is {width:.3f} mm wide, expected {p['bridge_width']}")
        counters = len(letter.interiors) if letter.geom_type == "Polygon" else 0
        print(f"   '{ch}': pocket wall vs offset(letter, {c}): max {dev:.4f} mm apart; letter-to-wall gap "
              f"min {gaps.min():.4f} mm, exactly {c} at {exact:.0%} of {len(gaps)} points (rest are inside corners); "
              f"one piece={one_piece}, chamfered {ct}/{cb} mm={bool(cham_ok)}{bar}, counters={counters}, posts={len(inner_posts)} -> {'OK' if ok else 'FAIL'}")
        if counters != len(inner_posts):
            failures.append(f"{meta['text']} '{ch}': {counters} counters but {len(inner_posts)} posts")
    print(f"   worst pocket deviation from the offset outline: {worst_all:.4f} mm")

print()
if failures:
    print(f"FAILED ({len(failures)}):")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("Fit check passed: every pocket is its letter offset by the clearance, every letter is one piece.")
