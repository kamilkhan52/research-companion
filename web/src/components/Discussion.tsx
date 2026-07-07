import { useState, useEffect, useRef, useCallback } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { getSession, getOpeningDraft, getReview, approve, reopen, startJob, replyJob, continueJob, retryJob, finishJob, requestChangesJob, getChatJob, getActiveChatJob, startPaper } from '@/api/endpoints';
import type { ChatJob } from '@/api/endpoints';
import type { SessionTurn, OpeningDraft, ReviewResponse } from '@/api/session-types';
import { useActivePid } from '@/hooks/useLibrary';
import './Discussion.css';

interface Props {
  slug: string;
  onNavigate: (hash: string) => void;
}

type View = 'compose' | 'chat' | 'review' | 'start';

marked.setOptions({ breaks: true });

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['h1','h2','h3','h4','p','br','strong','em','code','pre','blockquote','ul','ol','li','a','span','table','thead','tbody','tr','th','td'], ALLOWED_ATTR: ['href','target','rel','class'] });
}

function useJobPoll(pid: string | null) {
  const [job, setJob] = useState<ChatJob | null>(null);
  const [streamText, setStreamText] = useState('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPoll = useCallback(async (jobId: string) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setStreamText('');

    intervalRef.current = setInterval(async () => {
      if (!pid) return;
      try {
        const r = await getChatJob(pid, jobId);
        if (r.job.status === 'running') {
          setJob(r.job);
          setStreamText(r.job.items.filter((i): i is { kind: 'text'; text: string } => i.kind === 'text').map((i) => i.text).join(''));
        } else {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          setJob(r.job);
          setStreamText('');
        }
      } catch {}
    }, 1000);
  }, [pid]);

  useEffect(() => () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, []);

  return { job, streamText, startPoll };
}

export function Discussion({ slug, onNavigate }: Props) {
  const [activePid] = useActivePid();
  const [view, setView] = useState<View>('compose');
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [paperTitle, setPaperTitle] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  const [draft, setDraft] = useState<OpeningDraft | null>(null);
  const [model, setModel] = useState('');

  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [notesBlock, setNotesBlock] = useState('');
  const [synthesis, setSynthesis] = useState('');

  const { job, streamText, startPoll } = useJobPoll(activePid);
  const [candidates, setCandidates] = useState<{ arxiv_id: string; title: string; score: number }[]>([]);
  const [arxivId, setArxivId] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');

  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [turns, streamText]);

  useEffect(() => {
    if (!activePid) return;
    getSession(activePid, slug)
      .then((s) => {
        setPaperTitle(s.paper.title);
        setTurns((s.transcript || []).map((t: SessionTurn) => ({ ...t, narration: '' })));
        setModel(s.model || '');
        if (s.state === 'notes_drafted') loadReview();
        else if ((s.transcript || []).length > 0) setView('chat');
        else if (!s.paper.retrieved) setView('start');
        else loadDraft();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [activePid, slug]);

  // Recover in-progress job
  useEffect(() => {
    if (!activePid || view !== 'chat') return;
    getActiveChatJob(activePid, slug)
      .then((r) => { if (r.job && r.job.status === 'running') { setWorking(true); startPoll(r.job.id); } })
      .catch(() => {});
  }, [activePid, slug, view]);

  function loadDraft() {
    if (!activePid) return;
    getOpeningDraft(activePid, slug).then((d) => { setDraft(d); setModel(d.model); setView('compose'); }).catch(() => setView('chat'));
  }

  function loadReview() {
    if (!activePid) return;
    getReview(activePid, slug).then((r) => { setReview(r); setNotesBlock(r.notes_block || ''); setSynthesis(r.synthesis_proposed || ''); setView('review'); }).catch(() => {});
  }

  async function handleStartPaper() {
    if (!activePid) return;
    setWorking(true);
    setError(null);
    try {
      const r = await startPaper(activePid, slug, { arxiv_id: arxivId || undefined, pdf_url: pdfUrl || undefined });
      if (r.needs_confirmation && r.candidates) { setCandidates(r.candidates); setWorking(false); }
      else { loadDraft(); setWorking(false); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setWorking(false); }
  }

  async function handleCandidatePick(aid: string) {
    if (!activePid) return;
    setWorking(true);
    try {
      await startPaper(activePid, slug, { arxiv_id: aid });
      loadDraft();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setWorking(false);
  }

  async function submitJob(fn: () => Promise<{ job: { id: string } }>) {
    if (!activePid) return;
    setError(null);
    setWorking(true);
    try {
      const r = await fn();
      startPoll(r.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWorking(false);
    }
  }

  // When job completes, record the turn
  useEffect(() => {
    if (!job || job.status !== 'done' || !job.turn) return;
    setWorking(false);
    const turn = job.turn as SessionTurn;
    setTurns((t) => [...t, turn]);
    if (turn.proposed_commit) loadReview();
  }, [job]);

  // When job errors
  useEffect(() => {
    if (!job || job.status !== 'error') return;
    setWorking(false);
    setError(job.error || 'Turn failed');
  }, [job]);

  async function handleApprove() {
    if (!activePid) return;
    try { await approve(activePid, slug, { notes_block: notesBlock, synthesis }); onNavigate('library'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function handleRequestChanges() {
    const text = prompt('What should change?');
    if (!text || !activePid) return;
    setView('chat');
    await submitJob(() => requestChangesJob(activePid!, { slug, text }));
  }

  async function handleReopen() {
    if (!activePid) return;
    try {
      await reopen(activePid, slug);
      getSession(activePid, slug).then((s) => {
        setTurns((s.transcript || []).map((t: SessionTurn) => ({ ...t, narration: '' })));
        setView('chat');
      });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  if (error) {
    return (
      <div className="discussion">
        <div className="lc-empty">
          <p className="muted">{error}</p>
          <button className="btn ghost" onClick={() => setError(null)}>Dismiss</button>
        </div>
      </div>
    );
  }

  if (view === 'review' && review) {
    return (
      <div className="discussion">
        <div className="review-panel">
          <h3>{paperTitle ? 'Review — ' + paperTitle : 'Approve notes'}</h3>
          <p className="muted">{review.summary}</p>
          {notesBlock !== undefined && (
            <div className="review-sec">
              <div className="review-label muted">Notes block</div>
              <textarea className="review-textarea" value={notesBlock} onChange={(e) => setNotesBlock(e.target.value)} />
            </div>
          )}
          <div className="review-sec">
            <div className="review-label muted">Working notes (rewritten)</div>
            <textarea className="review-textarea" value={synthesis} onChange={(e) => setSynthesis(e.target.value)} />
          </div>
          <div className="btn-row">
            <button className="btn primary" onClick={handleApprove}>Approve & commit</button>
            <button className="btn ghost" onClick={handleRequestChanges}>Request changes</button>
            <button className="btn ghost" onClick={handleReopen}>Back to discussion</button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'start') {
    return (
      <div className="discussion">
        <div className="compose-panel">
          <h3>{paperTitle || 'Start reading'}</h3>
          <p className="muted">Fetch the paper from arXiv before starting the discussion.</p>
          <label className="field">
            <span>arXiv ID (e.g. 2309.06180)</span>
            <input className="discovery-input" value={arxivId} onChange={(e) => setArxivId(e.target.value)} placeholder="2309.06180" />
          </label>
          <label className="field">
            <span>or PDF URL</span>
            <input className="discovery-input" value={pdfUrl} onChange={(e) => setPdfUrl(e.target.value)} placeholder="https://…/paper.pdf" />
          </label>
          {error && <p className="build-progress-error">{error}</p>}
          <button className="btn primary" onClick={handleStartPaper} disabled={working}>
            {working ? 'Fetching…' : 'Fetch paper'}
          </button>
          {candidates.length > 0 && (
            <div className="candidate-list">
              <p className="muted">Multiple matches found. Pick the right one:</p>
              {candidates.map((c) => (
                <button key={c.arxiv_id} className="btn ghost" onClick={() => handleCandidatePick(c.arxiv_id)} style={{ width: '100%', textAlign: 'left' }}>
                  {c.title} — arXiv:{c.arxiv_id}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (view === 'compose' && draft) {
    return (
      <div className="discussion">
        <div className="compose-panel">
          <h3>{draft.title ? 'Start — ' + draft.title : 'Start reading'}</h3>
          <p className="muted">Edit the opening prompt and pick a model for the first response.</p>
          <textarea className="compose-textarea" value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
          <div className="btn-row">
            <button className="btn primary" onClick={() => { setView('chat'); submitJob(() => startJob(activePid!, { slug, prompt: draft.prompt, model })); }} disabled={working}>
              Generate first response
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="discussion">
      <div className="chat-scroll" ref={chatRef}>
        {turns.length === 0 && !working ? (
          <div className="lc-empty"><p className="muted">No turns yet.</p></div>
        ) : (
          turns.map((t, i) => <TurnBubble key={i} turn={t} index={i} turns={turns} onRetry={(idx, m) => submitJob(() => retryJob(activePid!, { slug, assistant_index: idx, model: m || null }))} />)
        )}
        {working && <StreamBubble text={streamText} />}
      </div>
      {!working && (
        <div className="composer">
          {turns.length > 0 && turns[turns.length - 1]?.role === 'user' && (
            <div className="gen-note">
              <span className="muted">No response yet.</span>
              <button className="btn ghost" onClick={() => submitJob(() => continueJob(activePid!, slug))}>Generate response</button>
            </div>
          )}
          <div className="composer-row">
            <textarea className="composer-input" placeholder="Type your reply…" value={reply} onChange={(e) => { setReply(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px'; }} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { const t = reply.trim(); if (t) { setTurns((prev) => [...prev, { role: 'user', text: t }]); setReply(''); submitJob(() => replyJob(activePid!, { slug, text: t })); } } }} rows={1} />
            <button className="btn primary" onClick={() => { const t = reply.trim(); if (!t) return; setTurns((prev) => [...prev, { role: 'user', text: t }]); setReply(''); submitJob(() => replyJob(activePid!, { slug, text: t })); }} disabled={!reply.trim()}>Send</button>
          </div>
          <div className="composer-actions">
            <button className="btn ghost" onClick={() => submitJob(() => finishJob(activePid!, slug))}>We're done — draft notes</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TurnBubble({ turn, index, turns, onRetry }: { turn: SessionTurn; index: number; turns: SessionTurn[]; onRetry: (idx: number, model?: string) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  if (turn.role === 'user') {
    return <div className="turn"><div className="turn-who">You</div><div className="bubble user"><div className="turn-text">{turn.text}</div></div></div>;
  }
  const aidx = turns.slice(0, index + 1).filter((t) => t.role === 'assistant').length - 1;
  const signal = turn.state_signal === 'ready_to_draft_notes' ? <span className="turn-signal">ready to draft notes</span> : null;
  return (
    <div className="turn">
      <div className="turn-who"><span>Companion{signal}</span></div>
      <div className="bubble assistant"><div className="turn-text" dangerouslySetInnerHTML={{ __html: sanitize(marked.parse(turn.canonical || '') as string) }} /></div>
      <div className="turn-actions">
        <button className="menu-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="More">⋯</button>
        {menuOpen && (
          <div className="turn-menu">
            <div className="turn-menu-item" onClick={() => { onRetry(aidx); setMenuOpen(false); }}>Retry</div>
            <div className="turn-menu-item" onClick={() => { onRetry(aidx, ''); setMenuOpen(false); }}>Retry with current model</div>
          </div>
        )}
      </div>
    </div>
  );
}

function StreamBubble({ text }: { text: string }) {
  if (!text) return <div className="turn"><div className="turn-who">Companion</div><div className="bubble assistant"><div className="lc-loading"><span className="spinner" /> Thinking…</div></div></div>;
  return <div className="turn"><div className="turn-who">Companion</div><div className="bubble assistant"><div className="turn-text" dangerouslySetInnerHTML={{ __html: sanitize(marked.parse(text) as string) }} /></div></div>;
}
