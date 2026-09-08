import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaperGraph, citationSummary } from '@/components/PaperGraph';

const active = vi.hoisted(() => ({ pid: 'project-1' as string | null }));
const api = vi.hoisted(() => ({ getPaperGraph: vi.fn() }));
const engine = vi.hoisted(() => ({
  setData: vi.fn(), zoomToFit: vi.fn(), destroy: vi.fn(),
  options: null as { onNodeClick?: (node: unknown) => void } | null,
}));

vi.mock('@/hooks/useLibrary', () => ({ useActivePid: () => [active.pid, vi.fn()] }));
vi.mock('@/api/endpoints', () => api);
vi.mock('@/graph/engine', () => ({
  // jsdom has no 2D context, so the real engine cannot draw here. The contract under test is
  // what this component HANDS the engine, which is exactly what the double records.
  GraphEngine: class {
    constructor(_canvas: unknown, options: { onNodeClick?: (node: unknown) => void }) {
      engine.options = options;
    }
    setData = engine.setData;
    zoomToFit = engine.zoomToFit;
    destroy = engine.destroy;
  },
}));

function node(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, kind: 'project', slug: id, title: `Title ${id}`, authors: [], venue: '',
    year: 2024, arxiv_id: null, doi: null, url: null, group: null, list_status: 'unread',
    cited_by_project_count: 0, significant_cited_by_count: 0, cites_count: 0, x: 0, y: 0,
    ...extra,
  };
}

function ego(overrides: Record<string, unknown> = {}) {
  return {
    center_id: 'attention',
    nodes: [node('attention'), node('resnet', { x: -560 }), node('gpt3', { x: 560 })],
    edges: [{ source: 'attention', target: 'resnet', significant: false }],
    references_count: 1,
    citers_count: 1,
    external_citer_count: 42,
    capped: false,
    layout: { algo: 'ego-v1' },
    ...overrides,
  };
}

beforeEach(() => {
  active.pid = 'project-1';
  vi.clearAllMocks();
  engine.options = null;
  api.getPaperGraph.mockResolvedValue({ ego: ego(), build: null });
});

describe('citationSummary', () => {
  it('reports references, in-project citers, and works elsewhere', () => {
    expect(citationSummary(ego() as never)).toBe('1 reference · cited by 1 in this project · 42 elsewhere');
  });

  it('says nothing about elsewhere when no forward scan has run', () => {
    // null is "nobody has looked", which is not the same claim as "nothing cites this".
    expect(citationSummary(ego({ external_citer_count: null }) as never))
      .toBe('1 reference · cited by 1 in this project');
  });

  it('distinguishes a scan that found none from one that never ran', () => {
    expect(citationSummary(ego({ external_citer_count: 0 }) as never)).toContain('0 elsewhere');
  });

  it('pluralises references', () => {
    expect(citationSummary(ego({ references_count: 3 }) as never)).toContain('3 references');
    expect(citationSummary(ego({ references_count: 1 }) as never)).toContain('1 reference');
  });
});

describe('PaperGraph', () => {
  it('hands the server layout straight to the canvas and fits it', async () => {
    render(<PaperGraph slug="attention" onNavigate={vi.fn()} />);

    await waitFor(() => expect(engine.setData).toHaveBeenCalled());
    const [nodes, edges, recommendations] = engine.setData.mock.calls[0];
    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(1);
    // No recommendations on an ego view — it is a view over what is already there.
    expect(recommendations).toEqual([]);
    // The layout is centred on the origin, so without this the graph sits off-screen.
    expect(engine.zoomToFit).toHaveBeenCalled();
  });

  it('offers the map, not an error, when the paper has no ego view', async () => {
    // DR-046: a paper outside the built graph is an absence, not a failure.
    api.getPaperGraph.mockResolvedValue({ ego: null, build: null });
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<PaperGraph slug="attention" onNavigate={onNavigate} />);

    await screen.findByText(/No reference map for this paper yet/);
    await user.click(screen.getByRole('button', { name: 'Open the map' }));
    expect(onNavigate).toHaveBeenCalledWith('graph');
  });

  it('says the map is already building rather than offering to build it again', async () => {
    api.getPaperGraph.mockResolvedValue({ ego: null, build: { status: 'running' } });
    render(<PaperGraph slug="attention" onNavigate={vi.fn()} />);

    expect(await screen.findByText(/building now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open the map' })).not.toBeInTheDocument();
  });

  it('says the totals are the real ones when a side was trimmed', async () => {
    api.getPaperGraph.mockResolvedValue({ ego: ego({ capped: true, references_count: 200 }), build: null });
    render(<PaperGraph slug="attention" onNavigate={vi.fn()} />);

    expect(await screen.findByText(/most significant on each side/)).toBeInTheDocument();
    expect(screen.getByText(/200 references/)).toBeInTheDocument();
  });

  it('opens a project node the reader picked', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<PaperGraph slug="attention" onNavigate={onNavigate} />);
    await waitFor(() => expect(engine.options).not.toBeNull());

    engine.options!.onNodeClick!(node('resnet'));

    await user.click(await screen.findByRole('button', { name: 'Open paper' }));
    expect(onNavigate).toHaveBeenCalledWith('paper/resnet');
  });

  it('offers no Open for an external node, which is a citation not a paper here', async () => {
    render(<PaperGraph slug="attention" onNavigate={vi.fn()} />);
    await waitFor(() => expect(engine.options).not.toBeNull());

    engine.options!.onNodeClick!(node('some-doi', { kind: 'external', slug: null, title: 'Elsewhere' }));

    expect(await screen.findByText('Elsewhere')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open paper' })).not.toBeInTheDocument();
  });

  it('tears the canvas down when the paper changes', async () => {
    const { rerender } = render(<PaperGraph slug="attention" onNavigate={vi.fn()} />);
    await waitFor(() => expect(engine.setData).toHaveBeenCalledTimes(1));

    rerender(<PaperGraph slug="resnet" onNavigate={vi.fn()} />);

    await waitFor(() => expect(engine.destroy).toHaveBeenCalled());
    await waitFor(() => expect(api.getPaperGraph).toHaveBeenCalledWith('project-1', 'resnet'));
  });

  it('reports a failed fetch', async () => {
    api.getPaperGraph.mockRejectedValue(new Error('Network error'));
    render(<PaperGraph slug="attention" onNavigate={vi.fn()} />);

    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });
});
