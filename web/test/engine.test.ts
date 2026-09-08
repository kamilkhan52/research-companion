import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphEngine } from '@/graph/engine';

/** jsdom has no 2D context, which is why nothing in this suite has ever touched the engine.
 *
 *  This stub covers ONLY what constructing and destroying an engine needs, and THROWS for
 *  anything else — deliberately, because a proxy that answers everything can never fail. A whole
 *  `render()` pass would run against a permissive one without drawing and without complaining,
 *  and a later assertion about what was drawn would pass vacuously: the same "green against a
 *  broken implementation" shape we keep finding, relocated into a fixture.
 *
 *  So widening this is a deliberate edit with a failing test in front of it. If you are here
 *  because something threw: decide whether you actually want to assert on drawing, which needs a
 *  real canvas stub or a headless runner (see `docs/web-rebuild-plan.md`), not one more entry. */
const STUBBED_CONTEXT_METHODS = new Set(['setTransform']);

function stubCanvasContext() {
  const ctx = new Proxy({}, {
    get: (_target, prop) => {
      const name = String(prop);
      if (!STUBBED_CONTEXT_METHODS.has(name)) {
        throw new Error(`canvas stub: 2D context "${name}" is not stubbed — see the note above.`);
      }
      return () => ({ width: 0 });
    },
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
