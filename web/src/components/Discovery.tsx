import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addPaper,
  getDiscovery,
  startDiscovery,
  type DiscoveryJob,
  type DiscoverySuggestion,
} from '@/api/endpoints';
import { useActivePid } from '@/hooks/useLibrary';
import './Discovery.css';

interface Props { onNavigate: (hash: string) => void; }

export function Discovery({ onNavigate }: Props) {
  const [activePid] = useActivePid();
  const [goals, setGoals] = useState('');
  const [job, setJob] = useState<DiscoveryJob | null>(null);
  const [suggestions, setSuggestions] = useState<DiscoverySuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [addingId, setAddingId] = useState<string | null>(null);
  const [specificTitle, setSpecificTitle] = useState('');
  const [specificArxiv, setSpecificArxiv] = useState('');
  const scopeRef = useRef({ pid: activePid });
  scopeRef.current = { pid: activePid };
  const goalsKey = activePid ? `rc.draft.v1:${activePid}:discovery:goals` : '';

  const load = useCallback(async () => {
    const pid = activePid;
    if (!pid) return null;
    const response = await getDiscovery(pid);
    if (scopeRef.current.pid !== pid) return null;
    setGoals(localStorage.getItem(goalsKey) ?? response.goals ?? response.result?.goals ?? '');
    setSuggestions(response.result?.suggestions || []);
    setJob(response.job);
    if (response.job?.status === 'error') setError(response.job.error || 'Discovery failed');
    return response;
  }, [activePid, goalsKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setJob(null);
    setSuggestions([]);
    setShowAll(false);
    if (!activePid) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    void load()
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activePid, load]);

  // Schedule the next poll only after this request settles; setInterval would let slow
  // requests overlap and a stale "running" response overwrite the terminal snapshot.
  useEffect(() => {
    if (!activePid || job?.status !== 'running') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const response = await load();
        if (!response || cancelled || response.job?.status !== 'running') return;
      } catch {
        if (cancelled) return;
      }
      if (!cancelled) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activePid, job?.status, load]);

  async function beginDiscovery() {
    if (!activePid || !goals.trim()) return;
    setError(null);
    try {
      const response = await startDiscovery(activePid, goals.trim());
      if (scopeRef.current.pid === activePid) setJob(response.job);
      localStorage.removeItem(goalsKey);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function add(title: string, arxivId?: string, abstract?: string) {
    if (!activePid) return;
    const id = arxivId || title;
    setAddingId(id);
    setError(null);
    try {
      await addPaper(activePid, title, arxivId, abstract);
      setAdded((previous) => new Set(previous).add(id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAddingId(null);
    }
  }

  const visibleSuggestions = showAll ? suggestions : suggestions.slice(0, 5);
  if (loading) return <div className="lc-loading"><span className="spinner" /> Loading discovery…</div>;
  if (!activePid) return <div className="lc-empty"><p className="muted">Choose a project first.</p></div>;

  return (
    <div className="discovery">
      <section className="discovery-section">
        <h3>What do you want to understand?</h3>
        <textarea className="discovery-goals" value={goals} onChange={(event) => {
          setGoals(event.target.value);
          if (goalsKey) localStorage.setItem(goalsKey, event.target.value);
        }}
          placeholder="e.g. transformer attention mechanisms, efficient model training…" />
        <button className="btn primary" onClick={beginDiscovery} disabled={job?.status === 'running' || !goals.trim()}>
          {job?.status === 'running' ? `Discovering… ${job.phase || ''}` : 'Start discovery'}
        </button>
      </section>

      {job?.status === 'running' && <div className="discovery-progress"><span className="spinner" /> {job.phase || 'Searching…'}</div>}
      {error && <p className="build-progress-error">{error}</p>}

      {suggestions.length > 0 && (
        <section className="discovery-section">
          <h3>Suggestions ({suggestions.length})</h3>
          <div className="suggestion-list">
            {visibleSuggestions.map((suggestion) => {
              const id = suggestion.arxiv_id || suggestion.title;
              return <div key={id} className="suggestion-card">
                <div className="suggestion-body">
                  <div className="suggestion-title">{suggestion.title}</div>
                  <div className="suggestion-meta muted">
                    {suggestion.authors.slice(0, 2).join(', ')}{suggestion.authors.length > 2 ? ' et al.' : ''}
                    {suggestion.year ? ` · ${suggestion.year}` : ''}
                    {suggestion.citation_count ? ` · ${suggestion.citation_count} citations` : ''}
                  </div>
                  <p className="suggestion-abstract muted">{suggestion.abstract?.slice(0, 200)}{(suggestion.abstract?.length ?? 0) > 200 ? '…' : ''}</p>
                </div>
                <button className="btn ghost" onClick={() => void add(suggestion.title, suggestion.arxiv_id, suggestion.abstract)} disabled={added.has(id) || addingId === id}>
                  {added.has(id) ? 'Added ✓' : addingId === id ? 'Adding…' : '+ Add'}
                </button>
              </div>;
            })}
          </div>
          {suggestions.length > 5 && !showAll && <button className="btn ghost" onClick={() => setShowAll(true)}>Show all {suggestions.length}</button>}
        </section>
      )}

      <section className="discovery-section">
        <h3>Bring a specific paper</h3>
        <input className="discovery-input" placeholder="Paper title…" value={specificTitle} onChange={(event) => setSpecificTitle(event.target.value)} />
        <input className="discovery-input" placeholder="arXiv ID (e.g. 2309.06180)" value={specificArxiv} onChange={(event) => setSpecificArxiv(event.target.value)} />
        <button className="btn ghost" disabled={!specificTitle.trim() || addingId === specificTitle.trim()} onClick={() => {
          const title = specificTitle.trim();
          if (!title) return;
          void add(title, specificArxiv.trim() || undefined);
          setSpecificTitle('');
          setSpecificArxiv('');
        }}>Add to reading list</button>
      </section>
      {added.size > 0 && <button className="btn primary discovery-library-link" onClick={() => onNavigate('library')}>Go to library · {added.size} added</button>}
    </div>
  );
}
