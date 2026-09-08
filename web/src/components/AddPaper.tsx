// DR-149 (web) — adding a paper you already know belongs to the Library, beside the active
// project, not at the bottom of a long Discover result list. This sheet keeps the entry paths
// together: a known identifier or link, and an intentional jump into exploratory Discover.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { addPaper, isPaperExistsElsewhere, uploadPaper, MAX_UPLOAD_BYTES, type PaperLocation } from '@/api/endpoints';
import { addPaperDraftKey, parseKnownPaper, titleFromPdfName } from '@/lib/paper-reference';

interface Props {
  pid: string;
  onClose: () => void;
  /** The paper was created — open it. `source` is what to retrieve, when the input named one. */
  onAdded: (slug: string, source: string | null) => void;
  /** A paper was created. Fires even when the reader has already left, because an add that
   *  lands after a dismissal still changed the reading list and nothing else reloads it. */
  onListChanged: () => void;
  onExplore: () => void;
}

export function AddPaperSheet({ pid, onClose, onAdded, onListChanged, onExplore }: Props) {
  const draftKey = addPaperDraftKey(pid);
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? '');
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState<PaperLocation[] | null>(null);
  // An upload that failed AFTER the reading-list entry was created. The entry exists, so a
  // second add would duplicate it — and unlike mobile, the web reading screen has no upload
  // action to send the reader to: its fetch form takes an arXiv id or a public URL, and a
  // paper you are uploading is by definition on neither. So the retry stays here, holding the
  // file, and re-sends exactly those bytes to the paper already created.
  const [stranded, setStranded] = useState<{ slug: string; file: File } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    setStranded(null);
    if (value) localStorage.setItem(draftKey, value); else localStorage.removeItem(draftKey);
  }

  /** Both add paths hit the same two refusals, and the cross-project one is a choice the reader
   *  can act on rather than a failure — so name where the paper already is, instead of the
   *  payload that carries the answer. */
  function reportAddFailure(caught: unknown) {
    if (caught instanceof ApiError && isPaperExistsElsewhere(caught.detail)) {
      setElsewhere(caught.detail.matches);
      setError(caught.detail.message);
    } else {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function upload(file: File) {
    if (adding || uploading) return;
    // Reset first. A refusal below must not leave the previous attempt's recovery action or
    // duplicate list on screen, pointing at a different file's paper.
    setError(null);
    setElsewhere(null);
    setStranded(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      // Ceil, not round: 40.4 MB is over the limit, and "That PDF is 40 MB. The limit is 40 MB."
      // reads as a contradiction.
      setError(`That PDF is ${Math.ceil(file.size / 1_000_000)} MB. The limit is 40 MB.`);
      return;
    }
    setUploading(true);
    try {
      // A local PDF has no identifier, so its filename is the provisional title; extraction
      // then offers the real one on the paper screen.
      const { paper } = await addPaper(pid, titleFromPdfName(file.name));
      onListChanged();
      await send(paper.slug, file);
    } catch (caught) {
      if (closed.current) return;
      reportAddFailure(caught);
    } finally {
      setUploading(false);
    }
  }

  /** Post the bytes for a reading-list entry that already exists — the tail of a first upload
   *  and the whole of a retry, so both behave identically. */
  async function send(slug: string, file: File) {
    try {
      await uploadPaper(pid, slug, file);
    } catch (caught) {
      if (closed.current) return;
      setStranded({ slug, file });
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    if (closed.current) return;
    exit(() => onAdded(slug, null));
  }

  async function retryUpload() {
    if (!stranded || uploading) return;
    setUploading(true);
    setError(null);
    try {
      await send(stranded.slug, stranded.file);
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    const parsed = parseKnownPaper(text);
    if (!parsed.title || adding || uploading) return;
    setAdding(true);
    setError(null);
    setElsewhere(null);
    setStranded(null);
    try {
      const { paper } = await addPaper(pid, parsed.title, parsed.arxivId);
      localStorage.removeItem(draftKey);
      onListChanged();
      if (closed.current) return;
      onAdded(paper.slug, parsed.source);
    } catch (caught) {
      if (closed.current) return;
      reportAddFailure(caught);
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
          <button className="btn primary" onClick={() => void submit()} disabled={!text.trim() || adding || uploading}>
            {adding ? 'Adding…' : 'Add'}
          </button>
        </div>
        <div className="add-paper-or"><span className="muted">or</span></div>
        <input
          ref={fileRef}
          className="add-paper-file"
          type="file"
          accept="application/pdf,.pdf"
          aria-label="PDF file"
          disabled={adding || uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clear the input so choosing the SAME file again still fires a change event —
            // which is exactly what a reader does after a failed upload.
            event.target.value = '';
            if (file) void upload(file);
          }}
        />
        <button className="btn ghost add-paper-upload" onClick={() => fileRef.current?.click()}
          disabled={adding || uploading}>
          {uploading ? 'Uploading…' : 'Upload a PDF'}
        </button>
        <p className="muted add-paper-hint">For a paper that is on no public index. Up to 40 MB.</p>
        {error && <p className="build-progress-error" role="alert">{error}</p>}
        {stranded && (
          <div className="add-paper-stranded">
            <p className="muted">
              “{stranded.file.name}” is on your reading list; only its upload did not go through.
            </p>
            <div className="add-paper-stranded-actions">
              <button className="btn primary" onClick={() => void retryUpload()} disabled={uploading}>
                {uploading ? 'Uploading…' : 'Send it again'}
              </button>
              <button className="btn ghost" onClick={() => exit(() => onAdded(stranded.slug, null))}>
                Open the paper
              </button>
            </div>
          </div>
        )}
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
