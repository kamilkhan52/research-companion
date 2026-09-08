// DR-093 (web) — the per-paper reference graph. A derived VIEW over the graph the Map already
// built: this paper in the middle, what it references to the left, what on the reading list
// cites it to the right. The server lays it out, so this renders those coordinates rather than
// simulating: an ego view whose satellites drift is unreadable, because the whole point is that
// left means "before this" and right means "after it".

import { useEffect, useRef, useState } from 'react';
import { getPaperGraph, type PaperEgo } from '@/api/endpoints';
import type { GraphNode } from '@/api/graph-types';
import { GraphEngine } from '@/graph/engine';
import { useActivePid } from '@/hooks/useLibrary';
import { paperHash } from '@/routes';
import './PaperGraph.css';

interface Props { slug: string; onNavigate: (hash: string) => void; }

/** What the header says about reach. Kept out of the component so the wording of the one
 *  genuinely confusing case — a scan that has not run vs. one that found nothing — is testable.
 *  `external_citer_count` is null before any forward scan; reporting that as "0 others cite
 *  this" states an absence nobody has checked for. */
export function citationSummary(ego: PaperEgo): string {
  const parts = [
    `${ego.references_count} reference${ego.references_count === 1 ? '' : 's'}`,
    `cited by ${ego.citers_count} in this project`,
  ];
  if (ego.external_citer_count !== null) {
    parts.push(`${ego.external_citer_count} elsewhere`);
  }
  return parts.join(' · ');
}

export function PaperGraph({ slug, onNavigate }: Props) {
  const [activePid] = useActivePid();
  const [ego, setEgo] = useState<PaperEgo | null>(null);
  const [building, setBuilding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEgo(null);
    setSelected(null);
    if (!activePid) { setLoading(false); return () => { cancelled = true; }; }
    getPaperGraph(activePid, slug)
      .then((response) => {
        if (cancelled) return;
        setEgo(response.ego);
        setBuilding(response.build?.status === 'running');
      })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activePid, slug]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ego) return;
    const engine = new GraphEngine(canvas, {
      onNodeClick: (node) => setSelected(node),
    });
    engine.setData(ego.nodes, ego.edges, []);
    // The layout is centred on the origin, so an unfitted canvas shows empty space.
    engine.zoomToFit();
    return () => engine.destroy();
  }, [ego]);

  if (loading) return <div className="lc-loading"><span className="spinner" /> Loading reference map…</div>;
  if (error) return <div className="lc-empty"><p className="muted">{error}</p></div>;

  // Not an error, deliberately (DR-046). A paper with no ego view has simply never been part of
  // a build — the offer is to build the map, or to wait for the one already running.
  if (!ego) {
    return (
      <div className="lc-empty">
        <h3>No reference map for this paper yet</h3>
        <p className="muted">
          {building
            ? 'The project map is building now. This paper will appear in it when that finishes.'
            : 'Reference maps come from the project map. Build it once and every paper gets one.'}
        </p>
        {!building && <button className="btn primary" onClick={() => onNavigate('graph')}>Open the map</button>}
      </div>
    );
  }

  return (
    <div className="paper-graph">
      <header className="paper-graph-head">
        <p className="muted">{citationSummary(ego)}</p>
        {ego.capped && <p className="muted paper-graph-capped">
          Showing the most significant on each side; the counts above are the full totals.
        </p>}
      </header>
      <div className="paper-graph-canvas-wrap">
        <canvas ref={canvasRef} className="paper-graph-canvas" />
      </div>
      {selected && (
        <aside className="paper-graph-detail">
          <div className="paper-graph-detail-title">{selected.title || selected.id}</div>
          <div className="muted">{[selected.year, selected.kind === 'project' ? 'In this project' : 'Not in this project']
            .filter(Boolean).join(' · ')}</div>
          <div className="btn-row paper-graph-detail-actions">
            {/* Only a project node has a reading-list entry to open. An external node is a
                citation record, not a paper this reader has. */}
            {selected.kind === 'project' && selected.slug && (
              <button className="btn primary" onClick={() => onNavigate(paperHash(selected.slug!))}>Open paper</button>
            )}
            <button className="btn ghost" onClick={() => setSelected(null)}>Close</button>
          </div>
        </aside>
      )}
    </div>
  );
}
