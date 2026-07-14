import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useGraph } from '@/hooks/useGraph';
import { useActivePid } from '@/hooks/useLibrary';
import { GraphEngine } from '@/graph/engine';
import type { GraphNode, GraphRecommendation } from '@/api/graph-types';
import { addPaper } from '@/api/endpoints';
import './Graph.css';

type FilterKind = 'all' | 'project' | 'external' | 'significant';

const FILTERS: { key: FilterKind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'project', label: 'In project' },
  { key: 'external', label: 'External' },
  { key: 'significant', label: 'Significant' },
];

interface Props {
  onNavigate: (hash: string) => void;
}

export function Graph({ onNavigate }: Props) {
  const [activePid] = useActivePid();
  const { graph, recommendations, build, hasGraph, totalPapers, readyPapers, stalePapers, loading, error, refetch, startBuild } = useGraph(activePid);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [filter, setFilter] = useState<FilterKind>('all');
  const [query, setQuery] = useState('');

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const hasSemanticScholarData = edges.some((edge) =>
    edge.provenance?.includes('semantic_scholar')
  );

  const filteredNodes = useMemo(() => {
    let result = nodes;
    if (filter === 'project') result = result.filter((n) => n.kind === 'project');
    if (filter === 'external') result = result.filter((n) => n.kind === 'external');
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter((n) =>
        n.title.toLowerCase().includes(q) || n.authors.some((a) => a.toLowerCase().includes(q))
      );
    }
    return result;
  }, [nodes, filter, query]);

  const highlightedIds = useMemo(() => {
    if (filter === 'all' && !query.trim()) return undefined;
    return new Set(filteredNodes.map((n) => n.id));
  }, [filteredNodes, filter, query]);

  const filteredEdges = useMemo(() => {
    if (filter === 'significant') return edges.filter((e) => e.significant);
    return edges;
  }, [edges, filter]);

  const setCanvasRef = useCallback((el: HTMLCanvasElement | null) => {
    if (!el) return;
    canvasRef.current = el;
    const engine = new GraphEngine(el, {
      onNodeClick: (n) => setSelectedNode(n),
    });
    engineRef.current = engine;

    // Feed data if already loaded (canvas mounts after data resolves)
    if (nodes.length > 0) {
      engine.setData(nodes, filteredEdges, recommendations);
    }
    if (highlightedIds) {
      engine.setOptions({ highlightedNodeIds: highlightedIds });
    }

    return () => { engine.destroy(); engineRef.current = null; };
  }, []);

  // Feed data
  useEffect(() => {
    engineRef.current?.setOptions({ highlightedNodeIds: highlightedIds });
  }, [highlightedIds]);

  useEffect(() => {
    if (nodes.length > 0 && engineRef.current) {
      engineRef.current.setData(nodes, filteredEdges, recommendations);
    }
  }, [nodes, filteredEdges, recommendations]);

  if (loading) {
    return (
      <div className="lc-loading">
        <span className="spinner" /> Loading graph…
      </div>
    );
  }

  if (error) {
    return (
      <div className="lc-empty">
        <p className="muted">{error}</p>
        <button className="btn ghost" onClick={refetch}>Retry</button>
      </div>
    );
  }

  if (!hasGraph) {
    return (
      <div className="graph-empty">
        <h3>No reference graph yet</h3>
        <p className="muted">
          {totalPapers > 0
            ? `${readyPapers} of ${totalPapers} papers ready.`
            : 'Add papers to your project to build a citation graph.'}
        </p>
        {build && build.status === 'error' && (
          <p className="build-progress-error">{build.error || 'Build failed'}</p>
        )}
        {build && build.status === 'running' ? (
          <BuildProgress build={build} />
        ) : totalPapers > 0 ? (
          <button className="btn primary" onClick={() => startBuild()}>
            Build graph
          </button>
        ) : (
          <button className="btn ghost" onClick={() => onNavigate('discover')}>
            Find papers
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="graph-screen">
      {stalePapers.length > 0 && build?.status !== 'running' && <div className="graph-stale"><span>{stalePapers.length} papers changed since this map was built.</span><button className="btn ghost" onClick={() => startBuild(true)}>Rebuild map</button></div>}
      <div className="graph-controls">
        <input
          className="graph-search"
          type="text"
          placeholder="Search title, author…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="graph-filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`filter-btn ${filter === f.key ? 'filter-btn-active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={() => engineRef.current?.zoomToFit()}>
          Fit
        </button>
      </div>

      <canvas ref={setCanvasRef} className="graph-canvas" />

      {hasSemanticScholarData && (
        <a
          className="graph-attribution"
          href="https://www.semanticscholar.org/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Reference metadata provided by Semantic Scholar ↗
        </a>
      )}

      {build && build.status === 'error' && (
        <div className="build-progress build-progress-compact" style={{ position: 'absolute', bottom: 'var(--space-md)', left: 'var(--space-md)', right: 'var(--space-md)' }}>
          <p className="build-progress-error">{build.error || 'Build failed'}</p>
          <button className="btn ghost" onClick={() => startBuild()}>Rebuild</button>
        </div>
      )}

      {selectedNode && (
        <NodeDetail node={selectedNode} edges={edges} nodes={nodes} onNavigate={onNavigate} onClose={() => setSelectedNode(null)} />
      )}

      {build && build.status === 'running' && (
        <BuildProgress build={build} compact />
      )}

      {recommendations.length > 0 && (
        <RecommendationsPanel recs={recommendations.slice(0, 6)} pid={activePid} />
      )}
    </div>
  );
}

function NodeDetail({
  node, edges, nodes, onNavigate, onClose,
}: {
  node: GraphNode;
  edges: { source: string; target: string }[];
  nodes: GraphNode[];
  onNavigate: (hash: string) => void;
  onClose: () => void;
}) {
  const cites = edges.filter((e) => e.source === node.id).map((e) => nodes.find((n) => n.id === e.target)).filter(Boolean) as GraphNode[];
  const citedBy = edges.filter((e) => e.target === node.id).map((e) => nodes.find((n) => n.id === e.source)).filter(Boolean) as GraphNode[];

  return (
    <div className="node-detail">
      <div className="node-detail-head">
        <h3>{node.title}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {node.authors.length > 0 && (
        <p className="muted">{node.authors.slice(0, 6).join(', ')}{node.authors.length > 6 ? ', et al.' : ''}</p>
      )}
      {node.year && <p className="muted">{node.venue ? `${node.venue}, ` : ''}{node.year}</p>}
      {node.slug && (
        <button className="btn ghost" onClick={() => onNavigate(`paper/${encodeURIComponent(node.slug!)}`)}>
          Open paper ›
        </button>
      )}
      {node.url && /^https?:/.test(node.url) && (
        <a className="btn ghost" href={node.url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', textDecoration: 'none', textAlign: 'center' }}>
          Open source ↗
        </a>
      )}
      {cites.length > 0 && (
        <div className="node-detail-section">
          <h4>Cites ({cites.length})</h4>
          <ul className="node-ref-list">
            {cites.map((n) => (
              <li key={n.id}>{n.title}</li>
            ))}
          </ul>
        </div>
      )}
      {citedBy.length > 0 && (
        <div className="node-detail-section">
          <h4>Cited by ({citedBy.length})</h4>
          <ul className="node-ref-list">
            {citedBy.map((n) => (
              <li key={n.id}>{n.title}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BuildProgress({
  build, compact,
}: {
  build: { status: string; total: number; done: number; current_title: string | null; current_slug: string | null; error: string | null };
  compact?: boolean;
}) {
  const pct = build.total > 0 ? Math.round((build.done / build.total) * 100) : 0;
  return (
    <div className={`build-progress ${compact ? 'build-progress-compact' : ''}`}>
      <div className="build-progress-bar">
        <div className="build-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="muted">
        {pct}% — {build.done}/{build.total} papers
        {build.current_title ? ` — ${build.current_title}` : ''}
      </p>
      {build.error && <p className="build-progress-error">{build.error}</p>}
    </div>
  );
}

function RecommendationsPanel({ recs, pid }: { recs: GraphRecommendation[]; pid: string | null }) {
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  async function add(rec: GraphRecommendation) {
    if (!pid) return;
    try { await addPaper(pid, rec.title, rec.arxiv_id || undefined); setAdded((previous) => new Set(previous).add(rec.id)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }
  return (
    <div className="recs-panel">
      <h4>Recommended</h4>
      <div className="recs-list">
        {recs.map((r) => (
          <div key={r.id} className="recs-item">
            <div className="recs-title">{r.title}</div>
            <div className="recs-reasons">
              {r.recommend_reasons.map((rr, i) => (
                <span key={i} className="recs-reason">{rr}</span>
              ))}
            </div>
            <button className="btn ghost" disabled={added.has(r.id)} onClick={() => void add(r)}>{added.has(r.id) ? 'Added ✓' : '+ Add'}</button>
          </div>
        ))}
      </div>
      {error && <p className="build-progress-error">{error}</p>}
    </div>
  );
}
