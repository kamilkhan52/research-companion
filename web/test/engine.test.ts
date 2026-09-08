import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphEngine } from '@/graph/engine';

/** jsdom has no 2D context, which is why nothing in this suite has ever touched the engine. A
 *  no-op proxy is enough for the one thing tested here — the engine's listener bookkeeping —
 *  without pretending anything is being drawn. */
function stubCanvasContext() {
  const ctx = new Proxy({}, {
    get: () => () => ({ width: 0 }),
    set: () => true,
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
}

afterEach(() => vi.restoreAllMocks());

describe('GraphEngine lifecycle', () => {
  it('removes the very listener it added', () => {
    // `addEventListener('resize', () => this.resize())` paired with a `removeEventListener` of
    // a second arrow removes nothing, and the engine — with its canvas, node arrays and 2D
    // context — stays reachable from the window for the life of the page. Invisible until a
    // view is navigated in and out of, which the per-paper reference map is.
    stubCanvasContext();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    const engine = new GraphEngine(document.createElement('canvas'));
    const added = add.mock.calls.filter(([type]) => type === 'resize');
    expect(added).toHaveLength(1);

    engine.destroy();

    const removed = remove.mock.calls.filter(([type]) => type === 'resize');
    expect(removed).toHaveLength(1);
    // Reference equality is the whole point: any two distinct arrows would pass a looser check.
    expect(removed[0][1]).toBe(added[0][1]);
  });

  it('leaves no resize listener behind after several engines come and go', () => {
    stubCanvasContext();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    const handlers = new Set<unknown>();
    for (let i = 0; i < 3; i += 1) {
      const engine = new GraphEngine(document.createElement('canvas'));
      engine.destroy();
    }
    for (const [type, handler] of add.mock.calls) if (type === 'resize') handlers.add(handler);
    for (const [type, handler] of remove.mock.calls) if (type === 'resize') handlers.delete(handler);

    expect(handlers.size).toBe(0);
  });
});
