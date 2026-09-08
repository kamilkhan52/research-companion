import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addPaper,
  cancelDiscovery,
  getDiscovery,
  hideSuggestion,
  startDiscovery,
  unhideSuggestion,
  type DiscoveryFind,
  type DiscoveryJob,
  type DiscoverySuggestion,
  type HiddenRecommendation,
} from '@/api/endpoints';
import { useActivePid, useLibrary, useProjectMembership } from '@/hooks/useLibrary';
import './Discovery.css';

interface Props { onNavigate: (hash: string) => void; }

/** How a suggestion is identified on this screen — for React keys, for the added/in-library
 *  checks, and for removing one from the list. One definition so they cannot drift, and stable
 *  across reloads: every poll rebuilds these objects, so anything keyed on object identity
 *  silently stops matching the moment a response lands. */
export function suggestionKey(suggestion: DiscoverySuggestion): string {
  return suggestion.arxiv_id || suggestion.title;
}

export function Discovery({ onNavigate }: Props) {
  const [activePid] = useActivePid();
  const [goals, setGoals] = useState('');
  const [job, setJob] = useState<DiscoveryJob | null>(null);
  const [suggestions, setSuggestions] = useState<DiscoverySuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const { isInProject } = useProjectMembership();
  const { refetch } = useLibrary();
  const [addingId, setAddingId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<HiddenRecommendation[]>([]);
  const [stopping, setStopping] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
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
    setHidden(response.hidden || []);
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
    setHidden([]);
    setShowAll(false);
    setShowHidden(false);
    setStopping(false);
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
      if (scopeRef.current.pid === activePid) { setJob(response.job); setStopping(false); }
      localStorage.removeItem(goalsKey);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  // A run is minutes of paid model work. Stopping is cooperative — the worker finishes the
  // stage it is inside, so the button stays "Stopping…" until the snapshot turns terminal.
  async function stopDiscovery() {
    // The disabled button is what actually prevents a second click — this reads `stopping` from
    // the render closure, so both halves of a genuine double-click see `false` and it would not
    // catch one either. Kept anyway: an idempotent guard in front of a paid job registry is
    // cheap. It is not the protection, and nothing here should be written as though it were.
    if (!activePid || stopping) return;
    setStopping(true);
    setError(null);
    try {
      const response = await cancelDiscovery(activePid);
      if (scopeRef.current.pid === activePid) setJob(response.job);
    } catch (caught) {
      setStopping(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function hide(suggestion: DiscoverySuggestion) {
    const pid = activePid;
    if (!pid) return;
    setError(null);
    // Drop it from the list first: the server is authoritative, but a card that lingers after
    // "Not this one" reads as a failure. `load` puts it back if the write is refused.
    // Keyed, not by object identity: a poll that lands between render and click replaces every
    // object, and an identity filter would then match nothing and leave the card sitting there.
    const key = suggestionKey(suggestion);
    setSuggestions((previous) => previous.filter((item) => suggestionKey(item) !== key));
    try {
      const { hidden: entry } = await hideSuggestion(pid, suggestion);
      if (scopeRef.current.pid === pid) setHidden((previous) => [...previous, entry]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      void load().catch(() => {});
    }
  }

  async function unhide(entry: HiddenRecommendation) {
    const pid = activePid;
    if (!pid) return;
    setError(null);
    try {
      await unhideSuggestion(pid, entry.keys);
      // The stored result keeps every suggestion, so the paper comes back without a re-run.
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function add(title: string, arxivId?: string, abstract?: string, year?: number | null) {
    if (!activePid) return;
    const id = arxivId || title;
    setAddingId(id);
    setError(null);
    try {
      await addPaper(activePid, title, arxivId, abstract, year);
      setAdded((previous) => new Set(previous).add(id));
      refetch();  // membership everywhere else updates immediately
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

      {job?.status === 'running' && <div className="discovery-progress">
        <span className="spinner" /> <span className="discovery-phase">{job.phase || 'Searching…'}</span>
        <button className="btn ghost danger" onClick={() => void stopDiscovery()} disabled={stopping}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      </div>}
      {job?.status === 'cancelled' && <p className="muted discovery-stopped">
        Discovery stopped — nothing more will be charged for this run.
      </p>}
      {/* THIS run's finds. Kept separate from the suggestion list below, which is the last
          COMPLETED run's persisted result: after a stop those are a different run's papers, and
          presenting them as what the stopped run found would be a lie the reader cannot check. */}
      {job && job.status !== 'error' && (job.finds?.length ?? 0) > 0 && (
        <section className="discovery-section discovery-finds">
          <h3>{job.status === 'running' ? 'Turning up so far' : 'What this run reached before it stopped'}</h3>
          <p className="muted">
            {job.finds_stage === 'ranked'
              ? 'Ranked, but this run did not finish — start again for the full set.'
              : 'Early finds, chosen on provenance before anything judged them. Some will not survive.'}
          </p>
          <ul className="discovery-find-list">
            {job.finds!.map((find: DiscoveryFind) => (
              <li key={`${find.title}|${find.year ?? ''}`}>
                <span className="discovery-find-title">{find.title}</span>
                {find.reason ? <span className="muted discovery-find-reason">{find.reason}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && <p className="build-progress-error">{error}</p>}

      {suggestions.length > 0 && (
        <section className="discovery-section">
          <h3>Suggestions ({suggestions.length})</h3>
          <div className="suggestion-list">
            {visibleSuggestions.map((suggestion) => {
              const id = suggestionKey(suggestion);
              const inLibrary = added.has(id) || isInProject({ arxivId: suggestion.arxiv_id, title: suggestion.title });
              return <div key={id} className="suggestion-card">
                <div className="suggestion-body">
                  <div className="suggestion-title">{suggestion.title}</div>
                  <div className="suggestion-meta muted">
                    {suggestion.authors.slice(0, 2).join(', ')}{suggestion.authors.length > 2 ? ' et al.' : ''}
                    {suggestion.year ? ` · ${suggestion.year}` : ''}
                    {suggestion.citation_count ? ` · ${suggestion.citation_count} citations` : ''}
                  </div>
                  {suggestion.abstract ? (
                    <p className="suggestion-abstract muted">{suggestion.abstract.slice(0, 200)}{suggestion.abstract.length > 200 ? '…' : ''}</p>
                  ) : null}
                </div>
                <div className="suggestion-actions">
                  <button className="btn ghost" onClick={() => void add(suggestion.title, suggestion.arxiv_id, suggestion.abstract, suggestion.year)} disabled={inLibrary || addingId === id}>
                    {added.has(id) ? 'Added ✓' : inLibrary ? 'In library' : addingId === id ? 'Adding…' : '+ Add'}
                  </button>
                  <button className="btn ghost suggestion-hide" onClick={() => void hide(suggestion)}
                    aria-label={`Stop recommending ${suggestion.title}`}>Not this one</button>
                </div>
              </div>;
            })}
          </div>
          {suggestions.length > 5 && !showAll && <button className="btn ghost" onClick={() => setShowAll(true)}>Show all {suggestions.length}</button>}
        </section>
      )}

      {hidden.length > 0 && (
        <section className="discovery-section discovery-hidden">
          <button className="btn ghost" onClick={() => setShowHidden((previous) => !previous)}
            aria-expanded={showHidden}>
            {showHidden ? 'Hide' : 'Show'} {hidden.length} you told Discover to skip
          </button>
          {showHidden && <ul className="discovery-hidden-list">
            {hidden.map((entry) => (
              <li key={entry.keys.join('|')}>
                <span>{entry.title || 'Untitled paper'}</span>
                <button className="btn ghost" onClick={() => void unhide(entry)}
                  aria-label={`Recommend ${entry.title || 'this paper'} again`}>Undo</button>
              </li>
            ))}
          </ul>}
        </section>
      )}

      {/* DR-149: adding a paper you already know is a Library action now, not something to
          find at the bottom of a Discover result list. Point at it rather than duplicating it. */}
      <section className="discovery-section discovery-known">
        <h3>Already know the paper?</h3>
        <p className="muted">Add it straight to your reading list from the Library.</p>
        <button className="btn ghost" onClick={() => onNavigate('library')}>Go to Library</button>
      </section>
      {added.size > 0 && <button className="btn primary discovery-library-link" onClick={() => onNavigate('library')}>Go to library · {added.size} added</button>}
    </div>
  );
}
