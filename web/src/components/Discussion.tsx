import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approve,
  cancelChatJob,
  continueDiscussion,
  continueJob,
  finishJob,
  getActiveChatJob,
  getChatJob,
  getFavoriteModels,
  getLatestRetrievalJob,
  getOpeningDraft,
  getRetrievalJob,
  getReview,
  getRelated,
  getSession,
  reopen,
  replyJob,
  requestChangesJob,
  retryJob,
  setSessionMode,
  startJob,
  startRetrievalJob,
} from '@/api/endpoints';
import type { ChatJob, RelatedWork, RetrievalJob } from '@/api/endpoints';
import type { FavoriteModel, ReadingMode, SessionState } from '@/api/types';
import type { OpeningDraft, ReviewResponse, Session, SessionTurn } from '@/api/session-types';
import { ApiError } from '@/api/client';
import { useActivePid, useProjectDefaults } from '@/hooks/useLibrary';
import { useAudio } from '@/audio/AudioProvider';
import { RichMarkdown } from '@/components/RichMarkdown';
import { parseKnownPaper } from '@/lib/paper-reference';
import './Discussion.css';

interface Props {
  slug: string;
  /** What the reader named when they added this paper — an arXiv id or a direct PDF link.
   *  Prefills the fetch form, and starts the fetch itself when nothing has been tried yet, so
   *  adding a known paper is one gesture rather than "add, then paste the same link again". */
  source?: string;
  onNavigate: (hash: string) => void;
}
type View = 'compose' | 'chat' | 'review' | 'start';
interface WatchableJob { id: string; status: 'running' | 'done' | 'error'; }

/** One request at a time. A terminal snapshot invalidates the watch synchronously, so an older
 * response can never overwrite it. Network blips retry; a 404 signals the caller to reconcile
 * with canonical server state (the server may have restarted after persisting the result). */
function useJobWatcher<T extends WatchableJob>(
  pid: string | null,
  load: (pid: string, id: string) => Promise<{ job: T }>,
) {
  const [job, setJob] = useState<T | null>(null);
  const [missingVersion, setMissingVersion] = useState(0);
  const generationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    generationRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const start = useCallback((jobId: string) => {
    stop();
    const generation = generationRef.current;
    setJob(null);

    const poll = async () => {
      if (!pid || generationRef.current !== generation) return;
      try {
        const { job: snapshot } = await load(pid, jobId);
        if (generationRef.current !== generation) return;
        if (snapshot.status !== 'running') {
          generationRef.current += 1; // invalidate before React can schedule another response
          timerRef.current = null;
          setJob(snapshot);
          return;
        }
        setJob(snapshot);
      } catch (error) {
        if (generationRef.current !== generation) return;
        if (error instanceof ApiError && error.status === 404) {
          generationRef.current += 1;
          timerRef.current = null;
          setJob(null);
          setMissingVersion((value) => value + 1);
          return;
        }
      }
      if (generationRef.current === generation) {
        timerRef.current = setTimeout(poll, 1000);
      }
    };

    void poll();
  }, [load, pid, stop]);

  const accept = useCallback((snapshot: T) => {
    if (snapshot.status === 'running') start(snapshot.id);
    else {
      stop();
      setJob(snapshot);
    }
  }, [start, stop]);

  const clear = useCallback(() => {
    stop();
    setJob(null);
  }, [stop]);

  useEffect(() => clear, [clear]);
  return { job, missingVersion, start, accept, clear };
}

export function Discussion({ slug, source, onNavigate }: Props) {
  const [activePid] = useActivePid();
  const defaults = useProjectDefaults();
  const [view, setView] = useState<View>('compose');
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [paperTitle, setPaperTitle] = useState('');
  const [paperYear, setPaperYear] = useState<number | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [draft, setDraft] = useState<OpeningDraft | null>(null);
  const [model, setModel] = useState('');
  const [favorites, setFavorites] = useState<FavoriteModel[]>([]);
  const [readingMode, setReadingMode] = useState<ReadingMode>('balanced');
  const [deliveryMode, setDeliveryMode] = useState<'reading' | 'listening'>(() => localStorage.getItem('rc_delivery_mode') === 'listening' ? 'listening' : 'reading');
  const [related, setRelated] = useState<RelatedWork[] | null>(null);
  const [stopping, setStopping] = useState(false);
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [notesBlock, setNotesBlock] = useState('');
  const [synthesis, setSynthesis] = useState('');
  const [candidates, setCandidates] = useState<RetrievalJob['candidates']>([]);
  const [arxivId, setArxivId] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);
  const { playText } = useAudio();
  // Update during render rather than waiting for an effect: an A request that resolves during
  // B's render must never write A's transcript/review/draft into B's screen.
  const routeRef = useRef({ pid: activePid, slug });
  routeRef.current = { pid: activePid, slug };

  const chatWatch = useJobWatcher<ChatJob>(activePid, getChatJob);
  const retrievalWatch = useJobWatcher<RetrievalJob>(activePid, getRetrievalJob);
  const streamText = (chatWatch.job?.items || [])
    .filter((item): item is { kind: 'text'; text: string } => item.kind === 'text')
    .map((item) => item.text)
    .join('');

  useEffect(() => {
    void getFavoriteModels()
      .then(({ models }) => setFavorites(Array.isArray(models) ? models : []))
      .catch(() => {});
  }, []);
  useEffect(() => { if (!model && defaults.model) setModel(defaults.model); }, [defaults.model, model]);
  useEffect(() => { localStorage.setItem('rc_delivery_mode', deliveryMode); }, [deliveryMode]);
  useEffect(() => {
    const key = activePid ? `rc.draft.v1:${activePid}:discussion:${slug}:reply` : '';
    if (key) setReply(localStorage.getItem(key) || '');
  }, [activePid, slug]);
  useEffect(() => {
    const key = activePid ? `rc.draft.v1:${activePid}:discussion:${slug}:reply` : '';
    if (key) { if (reply) localStorage.setItem(key, reply); else localStorage.removeItem(key); }
  }, [activePid, reply, slug]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [turns, streamText]);

  const loadReview = useCallback(async () => {
    const pid = activePid;
    const expectedSlug = slug;
    if (!pid) return;
    const result = await getReview(pid, expectedSlug);
    if (routeRef.current.pid !== pid || routeRef.current.slug !== expectedSlug) return;
    setReview(result);
    setNotesBlock(result.notes_block || '');
    setSynthesis(result.synthesis_proposed || '');
    setView('review');
  }, [activePid, slug]);

  const applySession = useCallback((session: Session) => {
    setPaperTitle(session.paper.title);
    setPaperYear(session.paper.year ?? null);
    setTurns((session.transcript || []).map((turn) => ({ ...turn, narration: '' })));
    setSessionState(session.state as SessionState);
    setReadingMode(session.reading_mode || 'balanced');
  }, []);

  const fetchCanonicalSession = useCallback(async () => {
    const pid = activePid;
    const expectedSlug = slug;
    if (!pid) return null;
    const session = await getSession(pid, expectedSlug);
    if (routeRef.current.pid !== pid || routeRef.current.slug !== expectedSlug) return null;
    applySession(session);
    if (session.state === 'notes_drafted') await loadReview();
    return session;
  }, [activePid, applySession, loadReview, slug]);

  const loadDraft = useCallback(async () => {
    const pid = activePid;
    const expectedSlug = slug;
    if (!pid) return;
    const opening = await getOpeningDraft(pid, expectedSlug);
    if (routeRef.current.pid !== pid || routeRef.current.slug !== expectedSlug) return;
    setDraft(opening);
    setModel(opening.model || '');
    setView('compose');
  }, [activePid, slug]);

  // Initialize per (project, paper). Cancellation handles React StrictMode and direct A -> B
  // navigation without a one-shot ref that would strand the prior paper's state on screen.
  useEffect(() => {
    let cancelled = false;
    chatWatch.clear();
    retrievalWatch.clear();
    setView('compose');
    setTurns([]);
    setDraft(null);
    setReview(null);
    setWorking(false);
    setError(null);
    setRetrievalError(null);
    setCandidates([]);
    setRelated(null);
    const named = source ? parseKnownPaper(source) : null;
    setArxivId(named?.arxivId ?? '');
    setPdfUrl(named?.pdfUrl ?? '');

    const initialize = async () => {
      if (!activePid) return;
      try {
        let session = await getSession(activePid, slug);
        if (cancelled) return;
        applySession(session);
        if (session.state === 'notes_drafted') {
          await loadReview();
          return;
        }
        if ((session.transcript || []).length > 0) {
          setView('chat');
          const { job } = await getActiveChatJob(activePid, slug);
          if (cancelled) return;
          if (job?.status === 'running') {
            setWorking(true);
            chatWatch.start(job.id);
          } else {
            // Close the session-fetch/active-job race: a turn may have persisted between them.
            session = await getSession(activePid, slug);
            if (!cancelled) applySession(session);
          }
          return;
        }
        if (!session.paper.retrieved) {
          setView('start');
          const { job } = await getLatestRetrievalJob(activePid, slug);
          if (cancelled) return;
          if (job) { retrievalWatch.accept(job); return; }
          // Nothing has been tried for this paper yet and the reader named a concrete source,
          // so fetch it. Gated on there being no prior job: a fetch that already failed must
          // surface its error and wait for a decision, not silently retry on every re-entry.
          // The start is server-deduped by slug, so a repeated effect joins rather than doubles.
          const concrete = named?.arxivId || named?.pdfUrl;
          if (!concrete) return;
          await beginRetrieval({ arxiv_id: named?.arxivId, pdf_url: named?.pdfUrl });
          return;
        }
        await loadDraft();
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void initialize();
    return () => { cancelled = true; };
  // watcher callbacks are stable for a pid; including the whole watcher objects would restart
  // initialization on every snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePid, slug, source, applySession, loadDraft, loadReview]);

  useEffect(() => {
    const job = chatWatch.job;
    if (!job || job.status === 'running') return;
    setWorking(false);
    void fetchCanonicalSession().then((session) => {
      const shouldPlay = job.delivery_mode === 'listening' || localStorage.getItem('rc_autoplay') === '1';
      if (job.status !== 'done' || !shouldPlay || !session) return;
      const assistantIndex = session.transcript.reduce((count, turn) => count + (turn.role === 'assistant' ? 1 : 0), 0) - 1;
      const lastAssistant = [...session.transcript].reverse().find((turn) => turn.role === 'assistant');
      if (lastAssistant?.canonical) void playText({ id: `${slug}:${assistantIndex}`, title: session.paper.title, text: lastAssistant.canonical });
    }).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    if (job.status === 'error') setError(job.error || 'Turn failed');
  }, [chatWatch.job, fetchCanonicalSession, playText, slug]);

  useEffect(() => {
    if (chatWatch.missingVersion === 0) return;
    setWorking(false);
    void fetchCanonicalSession().catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [chatWatch.missingVersion, fetchCanonicalSession]);

  useEffect(() => {
    const job = retrievalWatch.job;
    if (!job || job.status === 'running') return;
    setWorking(false);
    if (job.status === 'error') {
      setRetrievalError(job.error || 'Paper retrieval failed');
    } else if (job.candidates.length > 0) {
      setCandidates(job.candidates);
    } else if (job.retrieved) {
      void loadDraft().catch((caught) => {
        setRetrievalError(caught instanceof Error ? caught.message : String(caught));
      });
    }
  }, [loadDraft, retrievalWatch.job]);

  useEffect(() => {
    if (retrievalWatch.missingVersion === 0 || !activePid) return;
    let cancelled = false;
    getLatestRetrievalJob(activePid, slug)
      .then(({ job }) => { if (!cancelled && job) retrievalWatch.accept(job); })
      .catch((caught) => {
        if (!cancelled) setRetrievalError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => { cancelled = true; };
  }, [activePid, retrievalWatch.accept, retrievalWatch.missingVersion, slug]);

  async function beginRetrieval(opts?: { arxiv_id?: string; pdf_url?: string }) {
    if (!activePid) return;
    setWorking(true);
    setRetrievalError(null);
    setCandidates([]);
    try {
      const { job } = await startRetrievalJob(activePid, slug, opts);
      retrievalWatch.accept(job);
    } catch (caught) {
      setWorking(false);
      setRetrievalError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function submitJob(start: () => Promise<{ job: { id: string } }>) {
    if (!activePid) return;
    setError(null);
    setWorking(true);
    try {
      const { job } = await start();
      chatWatch.start(job.id);
      void fetchCanonicalSession(); // show the server-recorded user/revision turn immediately
    } catch (caught) {
      setWorking(false);
      void fetchCanonicalSession();
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function stopGeneration() {
    if (!activePid || !chatWatch.job?.id) return;
    setStopping(true);
    try { await cancelChatJob(activePid, chatWatch.job.id); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setStopping(false); }
  }

  async function changeReadingMode(next: ReadingMode) {
    if (!activePid) return;
    const previous = readingMode;
    setReadingMode(next);
    try { await setSessionMode(activePid, slug, next); }
    catch (caught) { setReadingMode(previous); setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  async function showRelated() {
    if (!activePid) return;
    if (related) { setRelated(null); return; }
    try { setRelated((await getRelated(activePid, slug)).related); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  async function handleApprove() {
    if (!activePid) return;
    try {
      await approve(activePid, slug, {
        notes_block: notesBlock,
        synthesis,
        proposal_revision: review?.proposal_revision ?? null,
      });
      onNavigate('library');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleRequestChanges() {
    const text = prompt('What should change?');
    if (!text || !activePid) return;
    setView('chat');
    await submitJob(() => requestChangesJob(activePid, { slug, text, delivery_mode: deliveryMode, model: model || null }));
  }

  async function handleReopen() {
    if (!activePid) return;
    try {
      await reopen(activePid, slug);
      await fetchCanonicalSession();
      setView('chat');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleContinueCommitted() {
    if (!activePid) return;
    try { await continueDiscussion(activePid, slug); setSessionState('in_discussion'); setView('chat'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  const lastIsUser = turns.length > 0 && turns[turns.length - 1]?.role === 'user';
  const delivery = { delivery_mode: deliveryMode, model: model || null } as const;

  if (view === 'start') {
    const retrievalRunning = retrievalWatch.job?.status === 'running';
    return (
      <div className="discussion">
        <div className="compose-panel">
          <h3>{paperTitle || 'Start reading'}</h3>
          <p className="muted">Fetch the paper before starting the discussion.</p>
          <label className="field"><span>arXiv ID (e.g. 2309.06180)</span>
            <input className="discovery-input" value={arxivId} onChange={(event) => setArxivId(event.target.value)} placeholder="2309.06180" /></label>
          <label className="field"><span>or PDF URL</span>
            <input className="discovery-input" value={pdfUrl} onChange={(event) => setPdfUrl(event.target.value)} placeholder="https://…/paper.pdf" /></label>
          {retrievalError && <p className="build-progress-error">{retrievalError}</p>}
          {retrievalRunning && (
            <div className="lc-loading"><span className="spinner" />
              {retrievalWatch.job?.phase === 'hunting' ? 'Searching for a PDF…' : 'Fetching paper…'}
            </div>
          )}
          <button className="btn primary" onClick={() => beginRetrieval({ arxiv_id: arxivId || undefined, pdf_url: pdfUrl || undefined })} disabled={retrievalRunning || working}>
            {retrievalRunning || working ? 'Fetching…' : 'Fetch paper'}
          </button>
          {candidates.length > 0 && (
            <div className="candidate-list">
              <p className="muted">Multiple matches found. Pick the right one:</p>
              {candidates.map((candidate) => (
                <button key={candidate.arxiv_id} className="btn ghost" onClick={() => beginRetrieval({ arxiv_id: candidate.arxiv_id })} style={{ width: '100%', textAlign: 'left' }}>
                  {candidate.title} — arXiv:{candidate.arxiv_id}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (error) {
    return <div className="discussion"><div className="lc-empty"><p className="muted">{error}</p>
      <button className="btn ghost" onClick={() => setError(null)}>Dismiss</button></div></div>;
  }

  if (view === 'review' && review) {
    return (
      <div className="discussion"><div className="review-panel">
        <h3>{paperTitle ? `Review — ${paperTitle}` : 'Approve notes'}</h3>
        <p className="muted">{review.summary}</p>
        <div className="review-sec"><div className="review-label muted">Paper Notes block</div>
          <textarea className="review-textarea" value={notesBlock} onChange={(event) => setNotesBlock(event.target.value)} /></div>
        <div className="review-sec"><div className="review-label muted">Project Notes</div>
          <textarea className="review-textarea" value={synthesis} onChange={(event) => setSynthesis(event.target.value)} /></div>
        <div className="btn-row">
          <button className="btn primary" onClick={handleApprove}>Approve & commit</button>
          <button className="btn ghost" onClick={handleRequestChanges}>Request changes</button>
          <button className="btn ghost" onClick={handleReopen}>Back to discussion</button>
        </div>
      </div></div>
    );
  }

  if (view === 'compose' && draft) {
    return (
      <div className="discussion"><div className="compose-panel">
        <h3>{draft.title ? `Start — ${draft.title}` : 'Start reading'}</h3>
        <p className="muted">Choose how the analyst should meet you, then edit the opening prompt if needed.</p>
        <SessionControls readingMode={readingMode} onReadingMode={changeReadingMode} deliveryMode={deliveryMode}
          onDeliveryMode={setDeliveryMode} model={model} onModel={setModel} favorites={favorites} />
        <textarea className="compose-textarea" value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
        <div className="btn-row"><button className="btn primary" onClick={() => {
          setView('chat');
          void submitJob(() => startJob(activePid!, { slug, prompt: draft.prompt, mode: readingMode, ...delivery }));
        }} disabled={working}>Generate paper summary</button></div>
      </div></div>
    );
  }

  return (
    <div className="discussion">
      <header className="discussion-toolbar">
        <div><span className="muted">{[sessionState === 'committed' ? 'Read' : 'Discussion', paperYear].filter(Boolean).join(' · ')}</span><h2>{paperTitle}</h2></div>
        <SessionControls readingMode={readingMode} onReadingMode={changeReadingMode} deliveryMode={deliveryMode}
          onDeliveryMode={setDeliveryMode} model={model} onModel={setModel} favorites={favorites} compact />
        <button className="btn ghost" onClick={() => void showRelated()}>Related works</button>
      </header>
      {related && <RelatedPanel related={related} onNavigate={onNavigate} onClose={() => setRelated(null)} />}
      {sessionState === 'committed' && <div className="discussion-state-banner"><span>This reading is complete.</span><button className="btn primary" onClick={() => void handleContinueCommitted()}>Continue discussion</button></div>}
      <div className="chat-scroll" ref={chatRef}>
        {turns.length === 0 && !working
          ? <div className="lc-empty"><p className="muted">No turns yet.</p></div>
          : turns.map((turn, index) => <TurnBubble key={index} turn={turn} index={index} turns={turns} canRetry={sessionState !== 'committed'} onRetry={(assistantIndex, retryModel) => {
              chatWatch.clear();
              void submitJob(() => retryJob(activePid!, { slug, assistant_index: assistantIndex, ...delivery, model: retryModel ?? delivery.model }));
            }} currentModel={model} onListen={(assistantIndex, text) => void playText({ id: `${slug}:${assistantIndex}`, title: paperTitle || slug, text })} onNavigate={onNavigate} />)}
        {working && <StreamBubble text={streamText} onNavigate={onNavigate} />}
      </div>
      {working && <div className="stop-row">
        {deliveryMode === 'listening' && chatWatch.job?.preview_phase && <span className="muted">Preparing listening cues · {chatWatch.job.preview_phase}</span>}
        <button className="btn ghost danger" onClick={() => void stopGeneration()} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop response'}</button>
      </div>}
      {!working && <div className="composer">
        {lastIsUser ? (
          <div className="gen-note"><span className="muted">No response yet.</span>
            <button className="btn ghost" onClick={() => submitJob(() => continueJob(activePid!, slug, delivery))}>Generate response</button>
            <button className="btn ghost" onClick={() => submitJob(() => finishJob(activePid!, slug, delivery))}>We're done — draft notes</button>
          </div>
        ) : (<>
          <div className="composer-row"><textarea className="composer-input" placeholder="Type your reply…" value={reply}
            onChange={(event) => { setReply(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`; }}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              const text = reply.trim(); if (!text) return; setTurns((previous) => [...previous, { role: 'user', text }]); setReply(''); void submitJob(() => replyJob(activePid!, { slug, text, ...delivery }));
            } }} rows={1} />
            <button className="btn primary" onClick={() => { const text = reply.trim(); if (!text) return; setTurns((previous) => [...previous, { role: 'user', text }]); setReply(''); void submitJob(() => replyJob(activePid!, { slug, text, ...delivery })); }} disabled={!reply.trim()}>Send</button></div>
          <div className="composer-actions"><button className="btn ghost" onClick={() => submitJob(() => finishJob(activePid!, slug, delivery))}>We're done — draft notes</button></div>
        </>)}
      </div>}
    </div>
  );
}

function SessionControls({ readingMode, onReadingMode, deliveryMode, onDeliveryMode, model, onModel, favorites, compact = false }: {
  readingMode: ReadingMode; onReadingMode: (mode: ReadingMode) => void; deliveryMode: 'reading' | 'listening';
  onDeliveryMode: (mode: 'reading' | 'listening') => void; model: string; onModel: (model: string) => void;
  favorites: FavoriteModel[]; compact?: boolean;
}) {
  return <div className={`session-controls ${compact ? 'compact' : ''}`}>
    <label><span>Reading mode</span><select value={readingMode} onChange={(event) => void onReadingMode(event.target.value as ReadingMode)}>
      <option value="balanced">Balanced</option><option value="background">Background-heavy</option>
      <option value="technical">Technical</option><option value="detailed">Detailed</option>
    </select></label>
    <label><span>Response</span><select value={deliveryMode} onChange={(event) => onDeliveryMode(event.target.value as 'reading' | 'listening')}>
      <option value="reading">Reading</option><option value="listening">Listening</option>
    </select></label>
    <label><span>Model (next response)</span><input list="favorite-models" value={model} onChange={(event) => onModel(event.target.value)} placeholder="Default model" /></label>
    <datalist id="favorite-models">{favorites.map((favorite) => <option key={favorite.id} value={favorite.id}>{favorite.label}</option>)}</datalist>
  </div>;
}

function RelatedPanel({ related, onNavigate, onClose }: { related: RelatedWork[]; onNavigate: (hash: string) => void; onClose: () => void }) {
  return <aside className="related-panel"><div className="related-head"><h3>Related works</h3><button className="icon-btn" onClick={onClose} aria-label="Close related works">✕</button></div>
    {related.length === 0 ? <p className="muted">No significant related works are available yet.</p> : related.map((work) => <article key={work.id}>
      <strong>{work.title}</strong><p>{work.reason}</p><span className="muted">{work.direction === 'builds_on' ? 'Builds on this paper' : 'Built on by this paper'}{work.year ? ` · ${work.year}` : ''}</span>
      {work.slug ? <button className="btn ghost" onClick={() => onNavigate(`paper/${encodeURIComponent(work.slug!)}`)}>Open paper</button>
        : work.url && /^https?:/i.test(work.url) ? <a className="btn ghost" href={work.url} target="_blank" rel="noopener noreferrer">Open source</a> : null}
    </article>)}</aside>;
}

function TurnBubble({ turn, index, turns, canRetry = true, onRetry, onListen, onNavigate, currentModel }: { turn: SessionTurn; index: number; turns: SessionTurn[]; canRetry?: boolean; onRetry: (idx: number, model?: string) => void; onListen: (idx: number, text: string) => void; onNavigate: (hash: string) => void; currentModel: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  if (turn.role === 'user') return <div className="turn"><div className="turn-who">You</div><div className="bubble user"><div className="turn-text">{turn.text}</div></div></div>;
  const assistantIndex = turns.slice(0, index + 1).filter((entry) => entry.role === 'assistant').length - 1;
  const signal = turn.state_signal === 'ready_to_draft_notes' ? <span className="turn-signal">ready to draft notes</span> : null;
  return <div className="turn"><div className="turn-who"><span>Companion{signal}</span></div>
    <div className="bubble assistant"><RichMarkdown className="turn-text" text={turn.canonical || ''} onNavigate={onNavigate} /></div>
    <div className="turn-actions"><button className="btn ghost" onClick={() => onListen(assistantIndex, turn.canonical || '')}>Listen</button><button className="menu-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="More">⋯</button>
      {menuOpen && canRetry && <div className="turn-menu"><div className="turn-menu-item" onClick={() => { onRetry(assistantIndex); setMenuOpen(false); }}>Retry</div>
        <div className="turn-menu-item" onClick={() => { onRetry(assistantIndex, currentModel || undefined); setMenuOpen(false); }}>Retry with {currentModel || 'default model'}</div></div>}</div>
  </div>;
}

function StreamBubble({ text, onNavigate }: { text: string; onNavigate: (hash: string) => void }) {
  if (!text) return <div className="turn"><div className="turn-who">Companion</div><div className="bubble assistant"><div className="lc-loading"><span className="spinner" /> Thinking…</div></div></div>;
  return <div className="turn"><div className="turn-who">Companion</div><div className="bubble assistant"><RichMarkdown className="turn-text" text={text} onNavigate={onNavigate} /></div></div>;
}
