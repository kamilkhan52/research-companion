"""Server-side graph layout, computed once per build and stored in the graph JSON so the client
renders instantly (no O(n^2) force sim on the phone's JS thread) and every client agrees on
node positions.

Layout style (Litmaps-like): the Y axis is TIME — older papers sit near the top, more recent
ones toward the bottom — so recency is readable at a glance. The X axis is force-directed
(connected papers pull together, everything repels) so clusters form horizontally within each
time band. Repulsion uses a spatial grid (only nearby nodes push on each other), keeping the
whole thing O(n) per iteration rather than O(n^2), so 700+ nodes lay out in well under a second.
"""
from __future__ import annotations

import math
import random
import re

WIDTH = 2200.0
HEIGHT = 2200.0
_MARGIN = 80.0
_ITERATIONS = 140
_ARXIV_RE = re.compile(r"^(\d{2})(\d{2})\.\d{4,5}")


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


def compute_layout(nodes: list[dict], edges: list[dict], *, seed: int = 42) -> dict:
    """Mutate `nodes`, adding rounded 'x'/'y' screen coordinates, and return the canvas bounds
    {'width','height'}. Deterministic (seeded) so rebuilds don't reshuffle the graph."""
    n = len(nodes)
    if n == 0:
        return {"width": WIDTH, "height": HEIGHT}

    rnd = random.Random(seed)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}

    # --- Y = time. Map [minYear, maxYear] -> [top, bottom]; undated nodes go in a band just
    #     above the timeline so they read as "unknown date", not as the oldest.
    years = [_year_of(nd) for nd in nodes]
    known = [y for y in years if y is not None]
    ymin, ymax = (min(known), max(known)) if known else (0, 1)
    span = max(1, ymax - ymin)
    top, bottom = _MARGIN, HEIGHT - _MARGIN
    undated_y = top * 0.6

    def target_y(y: int | None) -> float:
        return undated_y if y is None else top + (y - ymin) / span * (bottom - top)

    ty = [target_y(y) for y in years]
    px = [rnd.uniform(_MARGIN, WIDTH - _MARGIN) for _ in range(n)]
    py = [ty[i] + rnd.uniform(-15, 15) for i in range(n)]

    adj = [(idx[e["source"]], idx[e["target"]]) for e in edges
           if e.get("source") in idx and e.get("target") in idx]

    cell = 140.0            # repulsion neighborhood radius
    k_rep = 9000.0          # repulsion strength
    ideal = 120.0           # spring rest length
    for it in range(_ITERATIONS):
        cool = 1.0 - it / _ITERATIONS
        fx = [0.0] * n
        fy = [0.0] * n

        # Grid-bucketed repulsion: only nodes within neighboring cells push on each other.
        grid: dict[tuple[int, int], list[int]] = {}
        for i in range(n):
            grid.setdefault((int(px[i] // cell), int(py[i] // cell)), []).append(i)
        for (cx, cy), members in grid.items():
            neighbors = [m for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                         for m in grid.get((cx + dx, cy + dy), [])]
            for i in members:
                for j in neighbors:
                    if j <= i:
                        continue
                    ddx = px[i] - px[j]
                    ddy = py[i] - py[j]
                    d2 = ddx * ddx + ddy * ddy + 0.01
                    f = k_rep / d2
                    fxi, fyi = f * ddx, f * ddy
                    fx[i] += fxi; fy[i] += fyi
                    fx[j] -= fxi; fy[j] -= fyi

        # Edge springs pull citing/cited papers together.
        for a, b in adj:
            ddx = px[a] - px[b]
            ddy = py[a] - py[b]
            d = math.sqrt(ddx * ddx + ddy * ddy) + 0.01
            f = (d - ideal) * 0.08
            fxi, fyi = f * ddx / d, f * ddy / d
            fx[a] -= fxi; fy[a] -= fyi
            fx[b] += fxi; fy[b] += fyi

        # Integrate: X moves freely (with cooling + a step cap); Y is a spring toward the node's
        # time position, so the temporal axis is preserved while X resolves clustering/overlap.
        max_step = 45.0 * cool
        for i in range(n):
            px[i] += max(-max_step, min(max_step, fx[i] * 0.02))
            py[i] += max(-max_step, min(max_step, fy[i] * 0.02))
            py[i] += (ty[i] - py[i]) * 0.2

    xmin = min(px)
    xspan = max(1.0, max(px) - xmin)
    for i, nd in enumerate(nodes):
        nd["x"] = round(_MARGIN + (px[i] - xmin) / xspan * (WIDTH - 2 * _MARGIN), 1)
        nd["y"] = round(py[i], 1)
    return {"width": WIDTH, "height": HEIGHT}
