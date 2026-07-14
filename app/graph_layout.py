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
  3. No force simulation and no iterative relaxation. Both axes carry meaning, so nothing may
     push a node somewhere semantically wrong; the previous force-directed X was exactly the
     "what is the positioning logic?" illegibility this replaces. Edges consequently read
     left→right (older work ← cited by newer work).
  4. Overlap is impossible by construction: every year band is a small set of COLUMNS spaced
     one min-separation apart (never wider than the band, and the canvas widens first if year
     bands would crowd each other), and nodes are packed greedily down the columns — ranked
     nodes at (or just below) their citation-target Y in target order, unknown-citation nodes
     row by row inside the bottom band, which grows the canvas downward when a cohort
     outgrows it. Any two nodes therefore differ by at least the minimum separation in X
     (different columns/bands) or in Y (same column). Dense same-year/same-citation cohorts —
     the common "many recent zero-cited references" case — pack instead of colliding.

Everything is deterministic so rebuilds don't reshuffle the map. Clients draw axis
legends from these semantics ("older → newer", "↑ more cited"); if the rules here change, the
legends in mobile GraphCanvas / web Graph must change with them.
"""
from __future__ import annotations

import math
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


def compute_layout(nodes: list[dict], edges: list[dict]) -> dict:
    """Mutate `nodes`, adding rounded 'x'/'y' screen coordinates per the module rules, and
    return the canvas bounds + algo marker {'width','height','algo'}. Fully deterministic —
    the packing needs no randomness at all."""
    n = len(nodes)
    if n == 0:
        return {"width": WIDTH, "height": HEIGHT, "algo": LAYOUT_ALGO}

    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    adj = [(idx[e["source"]], idx[e["target"]]) for e in edges
           if e.get("source") in idx and e.get("target") in idx]

    # --- Rule 1: X = year rank bands, oldest left -> newest right. The canvas widens first
    #     if bands would sit closer than ~1.4 minimum separations, so neighboring bands can
    #     never crowd each other.
    min_sep = 56.0
    years = [_year_of(nd) for nd in nodes]
    year_rank = {y: i for i, y in enumerate(sorted({y for y in years if y is not None}))}
    n_ranks = max(1, len(year_rank) - 1)
    width = max(WIDTH, 2 * _MARGIN + n_ranks * min_sep * 1.4)
    left, right = _MARGIN, width - _MARGIN
    gap = (right - left) / max(1, n_ranks)

    def band_base(rank: int) -> float:
        return left + rank / n_ranks * (right - left) if year_rank else width / 2

    # Columns inside a band: spaced min_sep apart, spanning at most (gap - min_sep) so the
    # nearest columns of ADJACENT bands are still >= min_sep apart in X.
    col_span = max(0.0, min(gap * 0.9, gap - min_sep)) if year_rank else (right - left)
    n_cols = max(1, int(col_span // min_sep) + 1)

    def column_x(base: float, col: int) -> float:
        return base + (col - (n_cols - 1) / 2) * min_sep

    # Undated nodes inherit the average X of their graph neighbors (two passes so chains
    # settle), then snap to the nearest year band; isolated undated nodes take the center.
    band_of = [0.0] * n
    approx_x = [width / 2] * n
    for i in range(n):
        if years[i] is not None:
            approx_x[i] = band_base(year_rank[years[i]])
            band_of[i] = approx_x[i]
    undated = [i for i in range(n) if years[i] is None]
    if undated:
        neighbor: dict[int, list[int]] = {}
        for a, b in adj:
            neighbor.setdefault(a, []).append(b)
            neighbor.setdefault(b, []).append(a)
        for _ in range(2):
            for i in undated:
                anchors = [approx_x[j] for j in neighbor.get(i, [])]
                if anchors:
                    approx_x[i] = sum(anchors) / len(anchors)
        bases = sorted({band_base(r) for r in year_rank.values()}) or [width / 2]
        for i in undated:
            band_of[i] = min(bases, key=lambda b: abs(b - approx_x[i]))

    # --- Rule 2: target Y from log-scaled citation impact (most-cited at the top); unknown
    #     counts head for the bottom band.
    top = _MARGIN
    ranked_bottom = HEIGHT - _MARGIN - _UNRANKED_BAND - _UNRANKED_GAP
    band_top = HEIGHT - _MARGIN - _UNRANKED_BAND
    cites = [_citations_of(nd) for nd in nodes]
    known = [c for c in cites if c is not None]
    cmax_log = math.log10(1 + (max(known) if known else 0)) or 1.0

    def target_y(c: int) -> float:
        frac = math.log10(1 + c) / cmax_log  # 0 (uncited) .. 1 (most cited)
        return top + (1.0 - frac) * (ranked_bottom - top)

    # --- Rules 3+4: deterministic column packing per band. Ranked nodes are placed in target-Y
    #     order at max(target, cursor + min_sep) on whichever column keeps them closest to
    #     their target; unknowns then pack row-by-row from the band top. Separation holds by
    #     construction (see module docstring), with zero iteration.
    px = [0.0] * n
    py = [0.0] * n
    max_y_placed = band_top
    by_band: dict[float, list[int]] = {}
    for i in range(n):
        by_band.setdefault(band_of[i], []).append(i)
    for base, members in sorted(by_band.items()):
        ranked = sorted((i for i in members if cites[i] is not None),
                        key=lambda i: (target_y(cites[i]), nodes[i]["id"]))
        cursor = [top - min_sep] * n_cols
        for i in ranked:
            t = target_y(cites[i])
            # The column where this node lands closest to its target (ties: leftmost).
            col = min(range(n_cols), key=lambda c: (max(t, cursor[c] + min_sep), c))
            y = max(t, cursor[col] + min_sep)
            cursor[col] = y
            px[i] = column_x(base, col)
            py[i] = y

        unknown = sorted((i for i in members if cites[i] is None), key=lambda i: nodes[i]["id"])
        for k, i in enumerate(unknown):
            row, col = divmod(k, n_cols)
            px[i] = column_x(base, col)
            py[i] = band_top + _UNRANKED_GAP * 0.5 + row * min_sep
        if members:
            max_y_placed = max(max_y_placed, max(py[i] for i in members))

    height = max(HEIGHT, max_y_placed + _MARGIN)

    for i, nd in enumerate(nodes):
        nd["x"] = round(px[i], 1)
        nd["y"] = round(py[i], 1)
    return {"width": round(width, 1), "height": round(height, 1), "algo": LAYOUT_ALGO}
