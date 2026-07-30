// Which node labels to draw, so they stop overlapping.
//
// Spacing alone cannot fix this and it is worth being precise about why. A label box is
// `max(r * 3.6, 74)` px wide (GraphCanvas) against roughly 34px of inter-node separation, so a
// label is 2–4x the gap between nodes AT EVERY ZOOM. Once labels are drawn at constant screen size
// — which is the other half of this change — zooming in genuinely does buy room, because the nodes
// spread while the text does not. But at any given zoom some labels still have to be dropped.
//
// The technique is the one sigma.js uses: bucket label candidates into constant-size cells in
// SCREEN space and keep the highest-priority candidate per cell. O(n), no pairwise tests.
//
// The useful property is that the result depends only on `scale`, never on translate: panning
// cannot change which labels win, so this is recomputed on zoom alone — and only when a quantized
// zoom bucket changes, not per frame.

export interface LabelCandidate {
  id: string;
  /** Canvas-space position (the same coordinates the nodes are laid out in). */
  x: number;
  y: number;
  /** Higher wins its cell. Node radius works well: bigger node = more significant paper. */
  priority: number;
  /** Always drawn, and never occupies a cell — the reader asked for this one. */
  pinned?: boolean;
}

export interface DeclutterOptions {
  /** Current zoom. Canvas coordinates are multiplied by this to reach screen space. */
  scale: number;
  /** Screen-space cell size. Label boxes are wide and short, so these differ a lot. */
  cellWidth: number;
  cellHeight: number;
}

/**
 * The ids whose labels should be drawn. Pinned candidates are always included.
 *
 * Ties break on id rather than input order so the result is stable: an unstable choice would make
 * labels flicker between two nodes as unrelated state re-renders the canvas.
 */
export function pickVisibleLabels(
  candidates: readonly LabelCandidate[],
  { scale, cellWidth, cellHeight }: DeclutterOptions,
): Set<string> {
  const visible = new Set<string>();
  if (!candidates.length) return visible;
  // A degenerate cell size would put every node in cell 0 and hide all but one label; treat it as
  // "no decluttering" instead, which fails toward showing too much rather than too little.
  const safeScale = scale > 0 ? scale : 1;
  const w = cellWidth > 0 ? cellWidth : 0;
  const h = cellHeight > 0 ? cellHeight : 0;
  if (!w || !h) {
    for (const c of candidates) visible.add(c.id);
    return visible;
  }

  const best = new Map<string, LabelCandidate>();
  for (const c of candidates) {
    if (c.pinned) {
      visible.add(c.id);
      continue;
    }
    const key = `${Math.floor((c.x * safeScale) / w)}:${Math.floor((c.y * safeScale) / h)}`;
    const held = best.get(key);
    if (!held
        || c.priority > held.priority
        || (c.priority === held.priority && c.id < held.id)) {
      best.set(key, c);
    }
  }
  for (const winner of best.values()) visible.add(winner.id);
  return visible;
}

/**
 * A coarse bucket for a zoom level, so the declutter recomputes on meaningful zoom changes rather
 * than on every frame of a pinch. Logarithmic because zoom is multiplicative: the same number of
 * buckets then covers each doubling.
 */
export function zoomBucket(scale: number, perDoubling = 4): number {
  if (!(scale > 0)) return 0;
  return Math.round(Math.log2(scale) * perDoubling);
}

/** The scale a bucket represents — used to compute the declutter for that bucket. */
export function bucketScale(bucket: number, perDoubling = 4): number {
  return 2 ** (bucket / perDoubling);
}
