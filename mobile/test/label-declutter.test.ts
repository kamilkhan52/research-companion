import {
  bucketScale, pickVisibleLabels, zoomBucket, type LabelCandidate,
} from '@/graph/labelDeclutter';

const at = (id: string, x: number, y: number, priority = 1, pinned = false): LabelCandidate =>
  ({ id, x, y, priority, pinned });

describe('pickVisibleLabels', () => {
  it('keeps one label per screen cell, and keeps the highest-priority one', () => {
    // Three nodes close enough to share a cell at this zoom; only the biggest keeps its label.
    const out = pickVisibleLabels(
      [at('small', 0, 0, 1), at('big', 5, 2, 9), at('mid', 8, 3, 5)],
      { scale: 1, cellWidth: 100, cellHeight: 26 },
    );
    expect(out).toEqual(new Set(['big']));
  });

  it('admits more labels as the zoom spreads nodes apart — the whole point', () => {
    const nodes = [at('a', 0, 0), at('b', 60, 0), at('c', 120, 0)];
    const cells = { cellWidth: 100, cellHeight: 26 };
    // Zoomed out they collide; zoomed in the same nodes occupy different cells.
    expect(pickVisibleLabels(nodes, { scale: 0.25, ...cells }).size).toBe(1);
    expect(pickVisibleLabels(nodes, { scale: 2, ...cells }).size).toBe(3);
  });

  it('never drops a pinned label, whatever it collides with', () => {
    const out = pickVisibleLabels(
      [at('huge', 0, 0, 100), at('selected', 1, 1, 0, true)],
      { scale: 1, cellWidth: 200, cellHeight: 200 },
    );
    expect(out.has('selected')).toBe(true);
    expect(out.has('huge')).toBe(true);   // pinned takes no cell, so it displaces nothing
  });

  it('is stable when priorities tie, so labels do not flicker between re-renders', () => {
    const nodes = [at('zeta', 0, 0, 5), at('alpha', 1, 1, 5)];
    const opts = { scale: 1, cellWidth: 200, cellHeight: 200 };
    const first = pickVisibleLabels(nodes, opts);
    const reversed = pickVisibleLabels([...nodes].reverse(), opts);
    expect(first).toEqual(reversed);
    expect(first).toEqual(new Set(['alpha']));
  });

  it('depends on zoom but NOT on panning', () => {
    // Translation is applied by the canvas transform, never passed in — so a pan cannot change
    // the outcome. Shifting every node by the same amount is not the same thing, but this pins
    // the API shape that makes pan-independence true: there is nowhere to put a translate.
    const opts = { scale: 1, cellWidth: 100, cellHeight: 26 };
    expect(pickVisibleLabels([at('a', 0, 0), at('b', 500, 0)], opts).size).toBe(2);
  });

  it('shows everything rather than nothing if the cell size is degenerate', () => {
    const out = pickVisibleLabels([at('a', 0, 0), at('b', 1, 1)], {
      scale: 1, cellWidth: 0, cellHeight: 26,
    });
    expect(out.size).toBe(2);
  });

  it('handles an empty candidate list', () => {
    expect(pickVisibleLabels([], { scale: 1, cellWidth: 100, cellHeight: 26 }).size).toBe(0);
  });
});

describe('zoomBucket', () => {
  it('changes once per quarter-doubling, so a pinch does not recompute every frame', () => {
    expect(zoomBucket(1)).toBe(0);
    expect(zoomBucket(1.05)).toBe(0);         // small drift: same bucket
    expect(zoomBucket(2)).toBe(4);            // one doubling = 4 buckets
    expect(zoomBucket(0.5)).toBe(-4);
  });

  it('round-trips through bucketScale closely enough to declutter with', () => {
    expect(bucketScale(zoomBucket(2))).toBeCloseTo(2);
    expect(bucketScale(zoomBucket(0.25))).toBeCloseTo(0.25);
  });

  it('survives a non-positive scale instead of returning -Infinity', () => {
    expect(zoomBucket(0)).toBe(0);
    expect(Number.isFinite(bucketScale(zoomBucket(0)))).toBe(true);
  });
});
