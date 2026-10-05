#!/usr/bin/env python3
"""Fit check on the assembled test puzzles in tests/output/.

At mid pocket depth (below the lead-in) it slices the base and the seated
letters, then for every letter:
  * rebuilds the letter's original outline (what the pocket is cut from) and the
    expected pocket: that outline offset outward by fit_clearance with mitred
    corners (what OpenSCAD's offset(delta=...) does); checks the real pocket wall
    lies on it, both ways
  * checks the real letter lies inside the original outline, is never closer than
    fit_clearance to the pocket wall, and has its vertical corners cut off
  * checks the letter's top and bottom faces are chamfered (45 degrees, inset
    from the full outline)
  * checks the letter is one connected piece, that the bar joining an i / j dot
    is bridge_width wide, and that the pocket has a pathway for it: the bar, dot
    and stem all sit inside ONE pocket opening, at mid depth and at the top
  * checks counters keep a solid post in the pocket whenever the clearance
    leaves one (a counter narrower than twice the clearance closes up)
  * checks, with an exact boolean, that the letter and the base do not overlap

Usage: python3 tests/fit_check.py
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import trimesh
from shapely.geometry import Polygon, MultiPolygon, LineString, box
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


def original_outline(L):
    """The letter's un-chamfered outline (what pockets are cut from) in base coordinates."""
    parts = [Polygon(list(zip(sh["outer"][0::2], sh["outer"][1::2])),
                     [list(zip(h[0::2], h[1::2])) for h in sh["holes"]]) for sh in L["outline"]["shapes"]]
    parts += [box(*bar) for bar in L["outline"]["bars"]]
    return unary_union(parts)


# The corner chamfer is cut with offset(chamfer=true), whose join runs a hair along nearly-straight curve
# facets, so a chamfered letter can sit up to ~0.01 mm outside its original outline. 0.03 mm is far below
# what a 0.4 mm nozzle can print, so that is the tolerance for "inside" and "never closer than the clearance".
TOL_CHAMFER_JOIN = 0.03
SHARP = set("AEFHIKLMNTVWXYZ")  # capitals with sharp vertical corners
corner_cut_seen = False
for meta_path in sorted(p for p in OUT.glob("*.json") if p.name != "summary.json"):
    meta = json.loads(meta_path.read_text())
    p = meta["params"]
    c = p["fit_clearance"]
    asm = trimesh.load(OUT / f"{meta['stem']}-assembled.stl", force="mesh")
    bodies = asm.split(only_watertight=False)
    base = max(bodies, key=lambda b: b.extents[0] * b.extents[1])
    letters = [b for b in bodies if b is not base]
    z = p["base_floor"] + (p["pocket_depth"] - p["lead_in"]) / 2
    z_top = p["base_thickness"] - 0.02
    base_sec = as_list(section_polygons(base, z))
    slab = max(base_sec, key=lambda g: g.area)
    posts = [g for g in base_sec if g is not slab]
    top_slab = max(as_list(section_polygons(base, z_top)), key=lambda g: g.area)
    originals = [original_outline(L) for L in meta["letters"]]
    print(f"\n== {meta['label']}: slice at z = {z:.2f} mm, clearance {c} mm, vertical-corner chamfer {p['letter_corner_chamfer']} mm")
    if len(letters) != len(meta["letters"]):
        failures.append(f"{meta['text']}: {len(letters)} letter bodies for {len(meta['letters'])} letters")
    worst_all = 0
    for b in sorted(letters, key=lambda b: b.bounds[0][0]):
        sec = as_list(section_polygons(b, z))
        letter = unary_union(sec)
        k = next(i for i, o in enumerate(originals) if o.contains(letter.representative_point()))
        L, orig = meta["letters"][k], originals[k]
        ch = L["ch"]
        tag = f"{meta['text']} '{ch}'"
        one_piece = len(sec) == 1 and len(b.split(only_watertight=False)) == 1
        if not one_piece:
            failures.append(f"{tag}: letter is {len(sec)} pieces")
        # the pocket: the hole in the slab around this letter, minus any posts inside it
        hole = next(Polygon(r) for r in slab.interiors if Polygon(r).contains(letter.representative_point()))
        inner_posts = [q for q in posts if hole.contains(q)]
        pocket = hole.difference(unary_union(inner_posts)) if inner_posts else hole
        expected = orig.buffer(c, join_style="mitre", mitre_limit=1e6)
        on_expected = max(expected.boundary.distance(pt) for pt in boundary_samples(pocket))
        on_pocket = max(pocket.boundary.distance(pt) for pt in boundary_samples(expected))
        dev = max(on_expected, on_pocket)
        worst_all = max(worst_all, dev)
        gaps = np.array([pocket.boundary.distance(pt) for pt in boundary_samples(letter)])
        inside = orig.buffer(TOL_CHAMFER_JOIN).contains(letter)
        removed = orig.area - letter.area
        ok = dev < 0.005 and gaps.min() > c - TOL_CHAMFER_JOIN and one_piece and inside
        if not ok:
            failures.append(f"{tag}: pocket off the offset outline by {dev:.4f} mm, min gap {gaps.min():.4f}, inside original={inside}")
        if p["letter_corner_chamfer"] > 0 and ch in SHARP:
            corner_cut_seen |= removed > 0.02
            if removed <= 0.02:
                failures.append(f"{tag}: vertical corners are not chamfered (removed {removed:.3f} mm2)")
        # top / bottom face chamfers: just inside each face the outline is pulled in from the full outline
        zt, zb = b.bounds[1][2], b.bounds[0][2]
        ct, cb = p["letter_chamfer"], p["letter_bottom_chamfer"]
        top_sec = unary_union(as_list(section_polygons(b, zt - 0.05)))
        bot_sec = unary_union(as_list(section_polygons(b, zb + 0.05)))
        cham_ok = True
        nominal_top = zb + p["letter_thickness"]
        # expected inset of the outline at each probe height (45 degrees): top chamfer ct below the nominal
        # top, bottom chamfer cb above the bottom. On a stroke narrower than 2 * ct the stroke ends in a
        # ridge below the nominal top, so the top is probed where the letter really ends.
        for amount, sec_face, inset in ((ct, top_sec, ct - (nominal_top - (zt - 0.05))), (cb, bot_sec, cb - 0.05)):
            if amount > 0 and inset > 0.1:
                cham_ok &= sec_face.area < letter.area
                if not sec_face.is_empty:
                    cham_ok &= letter.buffer(-(inset - 0.15), join_style="mitre", mitre_limit=1e6).buffer(0.02).contains(sec_face.buffer(-0.02))
        cham_ok &= p["letter_thickness"] - ct <= (zt - zb) <= p["letter_thickness"] + 1e-3
        if not cham_ok:
            failures.append(f"{tag}: top/bottom faces are not chamfered by {ct}/{cb} mm")
        # the i / j dot bar and its pathway through the pocket
        bar = ""
        for bx0, by0, bx1, by1 in L["outline"]["bars"]:
            yy = (by0 + by1) / 2
            width = letter.intersection(LineString([(b.bounds[0][0] - 1, yy), (b.bounds[1][0] + 1, yy)])).length
            path_mid = pocket.buffer(0.001).contains(box(bx0, by0, bx1, by1)) and pocket.geom_type == "Polygon"
            top_hole = next(Polygon(r) for r in top_slab.interiors if Polygon(r).contains(letter.representative_point()))
            path_top = top_hole.buffer(0.001).contains(expected.buffer(-0.01))
            joined = len(sec) == 1 and pocket.contains(letter)
            bar = f", dot bar {width:.2f} mm wide, pocket pathway for bar+dot+stem: mid-depth={path_mid} top={path_top}"
            if abs(width - p["bridge_width"]) > 0.02:
                failures.append(f"{tag}: dot bar is {width:.3f} mm wide, expected {p['bridge_width']}")
            if not (path_mid and path_top and joined):
                failures.append(f"{tag}: the pocket does not hold the bar between dot and stem (mid={path_mid}, top={path_top}, joined={joined})")
        # counters: a post stays in the pocket as long as the counter is wider than twice the clearance
        counters = len(expected.interiors) if expected.geom_type == "Polygon" else 0
        if counters != len(inner_posts):
            failures.append(f"{tag}: expected {counters} posts, found {len(inner_posts)}")
        # exact boolean: the seated letter must not overlap the base anywhere
        overlap = trimesh.boolean.intersection([b, base], engine="manifold").volume if b.bounds[0][2] < base.bounds[1][2] else 0.0
        if overlap > 1e-3:
            failures.append(f"{tag}: letter overlaps the base by {overlap:.4f} mm3")
        print(f"   '{ch}': pocket wall vs offset(outline, {c}) max {dev:.4f} mm apart; gap to wall min {gaps.min():.3f} mm; "
              f"one piece={one_piece}; corners cut {removed:.2f} mm2; chamfered {ct}/{cb} mm={bool(cham_ok)}{bar}; "
              f"posts={len(inner_posts)}/{counters}; overlap with base {overlap:.4f} mm3 -> {'OK' if ok else 'FAIL'}")
    print(f"   worst pocket deviation from the offset outline: {worst_all:.4f} mm")

if not corner_cut_seen:
    failures.append("no sharp capital had its vertical corners cut in any test case")
print()
if failures:
    print(f"FAILED ({len(failures)}):")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("Fit check passed: pockets are the letter outlines offset by the clearance, letters are one piece with chamfered "
      "corners and faces, every i/j bar has its pathway, and no letter overlaps the base.")
