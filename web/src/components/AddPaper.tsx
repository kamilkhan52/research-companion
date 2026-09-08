// DR-149 (web) — adding a paper you already know belongs to the Library, beside the active
// project, not at the bottom of a long Discover result list. This sheet keeps the entry paths
// together: a known identifier or link, and an intentional jump into exploratory Discover.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { addPaper, isPaperExistsElsewhere, type PaperLocation } from '@/api/endpoints';
import { addPaperDraftKey, parseKnownPaper } from '@/lib/paper-reference';

interface Props {
  pid: string;
  onClose: () => void;
  /** The paper was created — open it. `source` is what to retrieve, when the input named one. */
  onAdded: (slug: string, source: string | null) => void;
  onExplore: () => void;
}

export function AddPaperSheet({ pid, onClose, onAdded, onExplore }: Props) {
  const draftKey = addPaperDraftKey(pid);
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? '');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState<PaperLocation[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Dismissal always works, including mid-flight: `POST /papers` scans every project the caller
  // owns and can be slow, and a modal with no exit is worse than a late answer. Closing cannot
  // cancel the request, so it is the LANDING that is suppressed — a dismissed add neither jumps
  // the reader into a paper they walked away from nor reports its failure to a screen they left.
  // EVERY exit routes through here. "Explore with Discover" is a leave too: an add that lands
  // after it would otherwise navigate the reader off the screen they just chose.
  const closed = useRef(false);
  const exit = useCallback((leave: () => void) => { closed.current = true; leave(); }, []);
  const dismiss = useCallback(() => exit(onClose), [exit, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  function updateText(value: string) {
    setText(value);
    // A refusal is about the text that produced it. Editing makes it stale, and a duplicate
    // list left under a different title reads as if it described the new one.
    setError(null);
    setElsewhere(null);
    if (value) localStorage.setItem(draftKey, value); else localStorage.removeItem(draftKey);
  }

  async function submit() {
    const parsed = parseKnownPaper(text);
    if (!parsed.title || adding) return;
    setAdding(true);
    setError(null);
    setElsewhere(null);
    try {
      const { paper } = await addPaper(pid, parsed.title, parsed.arxivId);
      localStorage.removeItem(draftKey);
      // The paper is on the reading list either way; the Library refetches when this closes.
      if (closed.current) return;
      onAdded(paper.slug, parsed.source);
    } catch (caught) {
      if (closed.current) return;
      // The cross-project duplicate is a refusal the reader can act on, not a failure: name
      // where the paper already is instead of rendering the payload that carries the answer.
      if (caught instanceof ApiError && isPaperExistsElsewhere(caught.detail)) {
        setElsewhere(caught.detail.matches);
        setError(caught.detail.message);
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="add-paper-overlay" role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <section className="add-paper-sheet" role="dialog" aria-modal="true" aria-label="Add a paper">
        <div className="add-paper-head">
          <h2>Add a paper</h2>
          <button className="icon-btn" onClick={dismiss} aria-label="Close">✕</button>
        </div>
        <p className="muted add-paper-hint">Paste a title, DOI, arXiv id or link, or a direct PDF link.</p>
        <div className="add-paper-row">
          <input
            ref={inputRef}
            className="add-paper-input"
            value={text}
            onChange={(event) => updateText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }}
            placeholder="Title, DOI, or arXiv link"
            aria-label="Paper title, DOI, or arXiv link"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn primary" onClick={() => void submit()} disabled={!text.trim() || adding}>
            {adding ? 'Adding…' : 'Add'}
          </button>
        </div>
        {error && <p className="build-progress-error" role="alert">{error}</p>}
        {elsewhere && elsewhere.length > 0 && (
          <ul className="add-paper-matches">
            {elsewhere.map((match) => (
              <li key={`${match.project_id}:${match.slug}`}>
                <strong>{match.title}</strong>
                <span className="muted"> — in {match.project_name}
                  {match.has_notes ? ', with notes' : match.has_discussion ? ', with a discussion' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="add-paper-explore">
          <span className="muted">Not sure what to read next?</span>
          <button className="btn ghost" onClick={() => exit(onExplore)}>Explore with Discover</button>
        </div>
      </section>
    </div>
  );
}
