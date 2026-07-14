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
  4. Overlap is resolved, not simulated: a deterministic minimum-separation sweep nudges
     colliding nodes apart along Y (the continuous axis) inside their year band, spilling to
     X only when a node is pinned against a canvas edge, with tiny seeded jitter so
     single-year stacks don't form a perfect line.

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

    px = [0.0] * n
    dated = [i for i in range(n) if years[i] is not None]
    for i in dated:
        base = left + year_rank[years[i]] / n_ranks * (right - left) if year_rank else WIDTH / 2
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

    # --- Rule 2: Y = log-scaled citation impact, most-cited at the top; unknowns in the
    #     bottom band.
    top = _MARGIN
    ranked_bottom = HEIGHT - _MARGIN - _UNRANKED_BAND - _UNRANKED_GAP
    cites = [_citations_of(nd) for nd in nodes]
    known = [c for c in cites if c is not None]
    cmax_log = math.log10(1 + (max(known) if known else 0)) or 1.0

    py = [0.0] * n
    for i in range(n):
        c = cites[i]
        if c is None:
            py[i] = HEIGHT - _MARGIN - rnd.uniform(0, _UNRANKED_BAND)
        else:
            frac = math.log10(1 + c) / cmax_log  # 0 (uncited) .. 1 (most cited)
            py[i] = top + (1.0 - frac) * (ranked_bottom - top)

    # --- Rule 4: deterministic minimum-separation sweeps, nudging along Y (each node stays in
    #     its year band). Clamping happens INSIDE the sweep — a post-hoc clamp would re-stack
    #     everything it pinned to a margin — and a node pinned against its bound hands the
    #     remaining push to X instead. Bounds are PER CLASS: ranked nodes may not be pushed
    #     down into the unranked band, and unranked nodes may not escape upward out of it —
    #     either would silently falsify the Y axis.
    min_sep = 56.0
    band_top = HEIGHT - _MARGIN - _UNRANKED_BAND
    y_lo = [(_MARGIN * 0.5) if cites[i] is not None else band_top for i in range(n)]
    y_hi = [(ranked_bottom + _UNRANKED_GAP * 0.5) if cites[i] is not None
            else HEIGHT - _MARGIN * 0.25 for i in range(n)]
    for _ in range(30):
        moved = False
        grid: dict[tuple[int, int], list[int]] = {}
        for i in range(n):
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
                    new_i = max(y_lo[i], min(y_hi[i], py[i] + direction * push))
                    new_j = max(y_lo[j], min(y_hi[j], py[j] - direction * push))
                    absorbed = abs(new_i - py[i]) + abs(new_j - py[j])
                    py[i], py[j] = new_i, new_j
                    remainder = 2 * push - absorbed
                    if remainder > 0.5:
                        dir_x = 1.0 if (ddx > 0 or (ddx == 0 and i > j)) else -1.0
                        px[i] += dir_x * remainder / 2
                        px[j] -= dir_x * remainder / 2
                    moved = True
        if not moved:
            break

    for i, nd in enumerate(nodes):
        nd["x"] = round(px[i], 1)
        nd["y"] = round(py[i], 1)
    return {"width": WIDTH, "height": HEIGHT, "algo": LAYOUT_ALGO}
