"""Server-side graph layout, computed once per build and stored in the graph JSON so the client
renders instantly (no force sim on the phone's JS thread) and every client agrees on positions.

THE LAYOUT RULES (U.8 — Litmaps-informed, and deliberately explainable in one sentence each):

  1. X = publication time. Distinct years get evenly spaced vertical bands, oldest at the LEFT,
     newest at the RIGHT (Litmaps' default X axis). Year rank — not linear year — because
     citation-graph years cluster hard; linear spacing left huge dead stretches and packed
     recent years into a sliver. Undated nodes inherit the average X of their graph neighbors
     (they live in the timeframe of the papers that cite them) instead of a mystery band.
  2. Y = citation impact. log10(1 + overall citations), most-cited at the TOP (Litmaps'
     default Y axis) — so the influential papers a reader has heard of float up, and the
     top-right corner is "recent + influential". Nodes with an unknown citation count sit in
     a band at the bottom: visually "unranked", not fake-zero-cited.
  3. No force simulation. Both axes carry meaning, so nothing may push a node somewhere
     semantically wrong; the previous force-directed X was exactly the "what is the
     positioning logic?" illegibility this replaces. Edges consequently read left→right
     (older work ← cited by newer work).
  4. Overlap is resolved, not simulated. Ranked nodes get deterministic minimum-separation
     sweeps along Y (the continuous axis); any spill to X is clamped inside the node's year
     band so time ordering is never violated. Unknown-citation nodes are GRID-PACKED per year
     inside the unranked band — Y there carries no meaning, so packing is free — and the band
     grows downward (taller canvas) when a year's cohort outgrows it.

Everything is deterministic (seeded) so rebuilds don't reshuffle the map. Clients draw axis
legends from these semantics ("older → newer", "↑ more cited"); if the rules here change, the
legends in mobile GraphCanvas / web Graph must change with them.
"""
from __future__ import annotations

import math
import random
import re

WIDTH = 2200.0
HEIGHT = 2200.0
_MARGIN = 80.0
_ARXIV_RE = re.compile(r"^(\d{2})(\d{2})\.\d{4,5}")

# The bottom strip reserved for unknown-citation nodes (rule 2), separated from the ranked
# region by a small gap so "bottom of the ranking" and "unranked" don't blur together.
_UNRANKED_BAND = 140.0
_UNRANKED_GAP = 60.0


def _year_of(node: dict) -> int | None:
    """A node's publication year: its explicit year, else parsed from a new-style arXiv id
    (YYMM.NNNNN -> 20YY), else unknown."""
    y = node.get("year")
    if isinstance(y, int) and 1980 <= y <= 2100:
        return y
    aid = node.get("arxiv_id")
    if aid:
        m = _ARXIV_RE.match(str(aid).strip())
        if m:
            return 2000 + int(m.group(1))
    return None


def _citations_of(node: dict) -> int | None:
    c = node.get("citation_count")
    return c if isinstance(c, int) and c >= 0 else None


# Stamped into the graph JSON's layout dict. Clients show the axis legends ONLY for this
# value: coordinates persisted by older algorithms (force-directed X) carry different meaning,
# and labeling them "older → newer / more cited" would be wrong until the next rebuild.
LAYOUT_ALGO = "semantic-v2"


def compute_layout(nodes: list[dict], edges: list[dict], *, seed: int = 42) -> dict:
    """Mutate `nodes`, adding rounded 'x'/'y' screen coordinates per the module rules, and
    return the canvas bounds + algo marker {'width','height','algo'}. Deterministic (seeded)."""
    n = len(nodes)
    if n == 0:
        return {"width": WIDTH, "height": HEIGHT, "algo": LAYOUT_ALGO}

    rnd = random.Random(seed)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    adj = [(idx[e["source"]], idx[e["target"]]) for e in edges
           if e.get("source") in idx and e.get("target") in idx]

    # --- Rule 1: X = year rank bands, oldest left -> newest right.
    years = [_year_of(nd) for nd in nodes]
    year_rank = {y: i for i, y in enumerate(sorted({y for y in years if y is not None}))}
    n_ranks = max(1, len(year_rank) - 1)
    left, right = _MARGIN, WIDTH - _MARGIN
    band_halfwidth = min(60.0, (right - left) / max(1, n_ranks) * 0.35)

    gap = (right - left) / max(1, n_ranks)
    x_cap = max(band_halfwidth, gap * 0.45)  # a node may never leave its year band (rule 4)

    def band_base(rank: int) -> float:
        return left + rank / n_ranks * (right - left) if year_rank else WIDTH / 2

    px = [0.0] * n
    band_of = [0.0] * n  # each node's year-band center (undated: nearest inferred band)
    dated = [i for i in range(n) if years[i] is not None]
    for i in dated:
        base = band_base(year_rank[years[i]])
        band_of[i] = base
        px[i] = base + rnd.uniform(-band_halfwidth, band_halfwidth)

    # Undated nodes: average X of graph neighbors (two passes so chains of undated nodes
    # settle), else the canvas center.
    undated = [i for i in range(n) if years[i] is None]
    if undated:
        neighbor: dict[int, list[int]] = {}
        for a, b in adj:
            neighbor.setdefault(a, []).append(b)
            neighbor.setdefault(b, []).append(a)
        for i in undated:
            px[i] = WIDTH / 2 + rnd.uniform(-band_halfwidth, band_halfwidth)
        for _ in range(2):
            for i in undated:
                anchors = [px[j] for j in neighbor.get(i, [])]
                if anchors:
                    px[i] = sum(anchors) / len(anchors) + rnd.uniform(-band_halfwidth / 2,
                                                                      band_halfwidth / 2)
        # Snap each undated node to its NEAREST year band so the grid packing and the X-spill
        # clamp below have a well-defined band for it too.
        bases = sorted({band_base(r) for r in year_rank.values()}) or [WIDTH / 2]
        for i in undated:
            band_of[i] = min(bases, key=lambda b: abs(b - px[i]))

    # --- Rule 2: Y = log-scaled citation impact, most-cited at the top; unknowns in the
    #     bottom band.
    top = _MARGIN
    ranked_bottom = HEIGHT - _MARGIN - _UNRANKED_BAND - _UNRANKED_GAP
    cites = [_citations_of(nd) for nd in nodes]
    known = [c for c in cites if c is not None]
    cmax_log = math.log10(1 + (max(known) if known else 0)) or 1.0

    min_sep = 56.0
    band_top = HEIGHT - _MARGIN - _UNRANKED_BAND

    py = [0.0] * n
    ranked_idx = [i for i in range(n) if cites[i] is not None]
    for i in ranked_idx:
        frac = math.log10(1 + cites[i]) / cmax_log  # 0 (uncited) .. 1 (most cited)
        py[i] = top + (1.0 - frac) * (ranked_bottom - top)

    # Unknown-citation nodes: deterministic per-year grid inside the unranked band. Columns
    # fit within the year band (X ordering preserved); rows extend the band downward when a
    # cohort outgrows it, growing the canvas rather than overlapping or escaping upward.
    unknown_idx = [i for i in range(n) if cites[i] is None]
    cols = max(1, int((2 * x_cap) // min_sep) + 1)
    max_rows = 0
    by_band: dict[float, list[int]] = {}
    for i in unknown_idx:
        by_band.setdefault(band_of[i], []).append(i)
    for base, members in by_band.items():
        members.sort(key=lambda i: nodes[i]["id"])  # deterministic
        for k, i in enumerate(members):
            row, col = divmod(k, cols)
            px[i] = base + (col - (cols - 1) / 2) * min_sep
            py[i] = band_top + _UNRANKED_GAP * 0.5 + row * min_sep
            max_rows = max(max_rows, row + 1)
    band_height = max(_UNRANKED_BAND, _UNRANKED_GAP * 0.5 + max_rows * min_sep)
    height = HEIGHT + max(0.0, band_height - _UNRANKED_BAND)

    # --- Rule 4 (ranked region): deterministic minimum-separation sweeps along Y, clamped
    #     INSIDE the sweep (a post-hoc clamp re-stacked everything it pinned to a margin).
    #     A node pinned against its Y bound hands the remaining push to X, clamped to its year
    #     band so time ordering survives. Unknowns are already packed and never move.
    y_lo, y_hi = _MARGIN * 0.5, ranked_bottom + _UNRANKED_GAP * 0.5
    for _ in range(30):
        moved = False
        grid: dict[tuple[int, int], list[int]] = {}
        for i in ranked_idx:
            grid.setdefault((int(px[i] // min_sep), int(py[i] // min_sep)), []).append(i)
        for (cx, cy), members in grid.items():
            neighbors = [m for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                         for m in grid.get((cx + dx, cy + dy), [])]
            for i in members:
                for j in neighbors:
                    if j <= i:
                        continue
                    ddx = px[i] - px[j]
                    ddy = py[i] - py[j]
                    d = math.sqrt(ddx * ddx + ddy * ddy)
                    if d >= min_sep:
                        continue
                    push = (min_sep - d) / 2 + 0.5
                    direction = 1.0 if (ddy > 0 or (ddy == 0 and i > j)) else -1.0
                    new_i = max(y_lo, min(y_hi, py[i] + direction * push))
                    new_j = max(y_lo, min(y_hi, py[j] - direction * push))
                    absorbed = abs(new_i - py[i]) + abs(new_j - py[j])
                    py[i], py[j] = new_i, new_j
                    remainder = 2 * push - absorbed
                    if remainder > 0.5:
                        dir_x = 1.0 if (ddx > 0 or (ddx == 0 and i > j)) else -1.0
                        px[i] = max(band_of[i] - x_cap,
                                    min(band_of[i] + x_cap, px[i] + dir_x * remainder / 2))
                        px[j] = max(band_of[j] - x_cap,
                                    min(band_of[j] + x_cap, px[j] - dir_x * remainder / 2))
                    moved = True
        if not moved:
            break

    for i, nd in enumerate(nodes):
        nd["x"] = round(px[i], 1)
        nd["y"] = round(py[i], 1)
    return {"width": WIDTH, "height": round(height, 1), "algo": LAYOUT_ALGO}
