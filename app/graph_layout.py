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

    # --- Y = time, by year RANK rather than linear year value: distinct years get evenly
    #     spaced bands. Linear mapping made edge lengths wildly uneven — a citation graph's
    #     years cluster hard (most papers within a few years, a few from decades back), so
    #     linear left huge empty stretches that stretched some edges across half the canvas
    #     while packing recent years (and their edges) into a sliver. Rank spacing keeps the
    #     old->new reading while bounding how long a cross-year edge can get.
    #     Undated nodes go in a band just above the timeline so they read as "unknown date".
    years = [_year_of(nd) for nd in nodes]
    year_rank = {y: i for i, y in enumerate(sorted({y for y in years if y is not None}))}
    n_ranks = max(1, len(year_rank) - 1)
    top, bottom = _MARGIN, HEIGHT - _MARGIN
    undated_y = top * 0.6

    def target_y(y: int | None) -> float:
        return undated_y if y is None else top + year_rank[y] / n_ranks * (bottom - top)

    ty = [target_y(y) for y in years]

    adj = [(idx[e["source"]], idx[e["target"]]) for e in edges
           if e.get("source") in idx and e.get("target") in idx]

    # --- X init: project papers evenly spaced; every other node starts at the average X of its
    #     graph neighbors (+ jitter). Starting connected nodes together matters more than the
    #     springs: with random init the springs have to drag nodes across the whole canvas and
    #     never fully converge, leaving most edges enormously long.
    px = [WIDTH / 2.0] * n
    projects = [i for i, nd in enumerate(nodes) if nd.get("kind") == "project"]
    for k, i in enumerate(projects):
        px[i] = _MARGIN + (k + 0.5) / max(1, len(projects)) * (WIDTH - 2 * _MARGIN)
    neighbor_x: dict[int, list[float]] = {}
    for a, b in adj:
        neighbor_x.setdefault(b, []).append(px[a])
        neighbor_x.setdefault(a, []).append(px[b])
    for i in range(n):
        if i in neighbor_x and nodes[i].get("kind") != "project":
            px[i] = sum(neighbor_x[i]) / len(neighbor_x[i]) + rnd.uniform(-90, 90)
        elif nodes[i].get("kind") != "project":
            px[i] = rnd.uniform(_MARGIN, WIDTH - _MARGIN)
    py = [ty[i] + rnd.uniform(-15, 15) for i in range(n)]

    cell = 140.0            # repulsion neighborhood radius
    k_rep = 5000.0          # repulsion strength
    ideal = 110.0           # spring rest length
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
                    fx[i] += fxi
                    fy[i] += fyi
                    fx[j] -= fxi
                    fy[j] -= fyi

        # Edge springs pull citing/cited papers together.
        for a, b in adj:
            ddx = px[a] - px[b]
            ddy = py[a] - py[b]
            d = math.sqrt(ddx * ddx + ddy * ddy) + 0.01
            f = (d - ideal) * 0.2
            fxi, fyi = f * ddx / d, f * ddy / d
            fx[a] -= fxi
            fy[a] -= fyi
            fx[b] += fxi
            fy[b] += fyi

        # Integrate: X moves freely (with cooling + a step cap); Y is pulled SOFTLY toward the
        # node's time band. Soft (not hard) pinning matters: a hard pin flattens each year into
        # a 1D line, which forces crowded years to spread enormously wide in X (very long
        # edges). A gentle pull keeps old->new reading top->bottom while letting clusters form
        # as compact 2D blobs.
        max_step = 45.0 * cool
        for i in range(n):
            px[i] += max(-max_step, min(max_step, fx[i] * 0.02))
            py[i] += max(-max_step, min(max_step, fy[i] * 0.02))
            py[i] += (ty[i] - py[i]) * 0.06

    # Minimum-separation pass: the sim reduces crowding but the Y-pin can leave same-year
    # neighbors nearly on top of each other (edges "too short" to read). Push any pair closer
    # than MIN_SEP apart along X only (preserving the temporal Y), a few sweeps until settled.
    MIN_SEP = 60.0
    for _ in range(24):
        moved = False
        grid: dict[tuple[int, int], list[int]] = {}
        for i in range(n):
            grid.setdefault((int(px[i] // MIN_SEP), int(py[i] // MIN_SEP)), []).append(i)
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
                    if d < MIN_SEP:
                        push = (MIN_SEP - d) / 2 + 0.5
                        direction = 1.0 if (ddx > 0 or (ddx == 0 and i > j)) else -1.0
                        px[i] += direction * push
                        px[j] -= direction * push
                        moved = True
        if not moved:
            break

    # Translate X to start at the margin, growing the canvas if needed rather than rescaling —
    # squeezing back into a fixed width would undo the minimum separation in dense year bands.
    xmin = min(px)
    xspan = max(px) - xmin
    width = max(WIDTH, xspan + 2 * _MARGIN)
    offset = _MARGIN + (width - 2 * _MARGIN - xspan) / 2  # center when narrower than the canvas
    for i, nd in enumerate(nodes):
        nd["x"] = round(offset + px[i] - xmin, 1)
        nd["y"] = round(py[i], 1)
    return {"width": round(width, 1), "height": HEIGHT}
