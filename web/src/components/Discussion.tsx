import { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';
import { getSession, getOpeningDraft, streamPost, getReview, approve, reopen } from '@/api/endpoints';
import { useActivePid } from '@/hooks/useLibrary';
import type { SessionTurn, StreamEvent, OpeningDraft, ReviewResponse } from '@/api/session-types';
import './Discussion.css';

interface Props {
  slug: string;
  onNavigate: (hash: string) => void;
}

type View = 'compose' | 'chat' | 'review';

// Configure marked for safe rendering
marked.setOptions({ breaks: true });

export function Discussion({ slug, onNavigate }: Props) {
  const [activePid] = useActivePid();
  const [view, setView] = useState<View>('compose');
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [paperTitle, setPaperTitle] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  // Opening draft state
  const [draft, setDraft] = useState<OpeningDraft | null>(null);
  const [model, setModel] = useState('');

  // Notes review state
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [notesBlock, setNotesBlock] = useState('');
  const [synthesis, setSynthesis] = useState('');

  const chatRef = useRef<HTMLDivElement>(null);

  const scrollDown = useCallback(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, []);

  // Load session
  useEffect(() => {
    if (!activePid) return;
    getSession(activePid, slug)
      .then((s) => {
        setPaperTitle(s.paper.title);
        const t = s.transcript.map((t: SessionTurn) => ({ ...t, narration: '' }));
        setTurns(t);
        setModel(s.model || '');

        if (s.state === 'notes_drafted') {
          loadReview();
        } else if (t.length > 0) {
          setView('chat');
        } else {
          loadDraft();
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [activePid, slug]);

  function loadDraft() {
    if (!activePid) return;
    getOpeningDraft(activePid, slug)
      .then((d) => {
        setDraft(d);
        setModel(d.model);
        setView('compose');
      })
      .catch(() => setView('chat'));
  }

  function loadReview() {
    if (!activePid) return;
    getReview(activePid, slug)
      .then((r) => {
        setReview(r);
        setNotesBlock(r.notes_block || '');
        setSynthesis(r.synthesis_proposed || '');
        setView('review');
      })
      .catch(() => {});
  }

  async function startChat() {
    if (!activePid || !draft) return;
    const prompt = draft.prompt;
    setView('chat');
    setStreaming(true);
    setStreamText('');
    await streamTurn('/chat/start_stream', { slug, prompt, model });
  }

  async function sendReply() {
    if (!reply.trim() || !activePid) return;
    const text = reply.trim();
    setTurns((t) => [...t, { role: 'user', text }]);
    setReply('');
    setStreaming(true);
    setStreamText('');
    await streamTurn('/reply_stream', { slug, text });
  }

  async function continueTurn() {
    if (!activePid) return;
    setStreaming(true);
    setStreamText('');
    await streamTurn('/continue_stream', { slug });
  }

  async function retryTurn(assistantIndex: number, retryModel?: string) {
    if (!activePid) return;
    setStreaming(true);
    setStreamText('');
    await streamTurn('/retry_stream', { slug, assistant_index: assistantIndex, model: retryModel || null });
  }

  async function finishPaper() {
    if (!activePid) return;
    setStreaming(true);
    setStreamText('');
    await streamTurn('/finish_stream', { slug });
  }

  async function streamTurn(path: string, body: unknown) {
    if (!activePid) return;
    try {
      const resp = await streamPost(activePid, path, body);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: `HTTP ${resp.status}` }));
        setError(err.detail || `HTTP ${resp.status}`);
        setStreaming(false);
        return;
      }
      if (!resp.body) { setStreaming(false); return; }

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let done = false;

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += dec.decode(value, { stream: true });

        const lines = buf.split('\n\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          const m = line.match(/^data:\s*({[\s\S]*})$/);
          if (!m) continue;
          let ev: StreamEvent;
          try { ev = JSON.parse(m[1]); } catch { continue; }
          if (ev.type === 'delta') {
            setStreamText((s) => s + ev.text);
            scrollDown();
          } else if (ev.type === 'done') {
            setTurns((t) => [...t, ev.turn]);
            setStreamText('');
            done = true;
            if (ev.turn.proposed_commit) loadReview();
          } else if (ev.type === 'error') {
            setError(ev.detail);
            done = true;
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setStreaming(false);
  }

  async function handleApprove() {
    if (!activePid) return;
    try {
      await approve(activePid, slug, { notes_block: notesBlock, synthesis });
      onNavigate('library');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRequestChanges() {
    const text = prompt('What should change?');
    if (!text || !activePid) return;
    setView('chat');
    setStreaming(true);
    setStreamText('');
    await streamTurn('/request_changes_stream', { slug, text });
  }

  async function handleBackToDiscussion() {
    if (!activePid) return;
    try {
      await reopen(activePid, slug);
      getSession(activePid, slug).then((s) => {
        setTurns(s.transcript.map((t: SessionTurn) => ({ ...t, narration: '' })));
        setView('chat');
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
            <button className="btn ghost" onClick={handleBackToDiscussion}>Back to discussion</button>
          </div>
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
            <button className="btn primary" onClick={startChat}>Generate first response</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="discussion">
      <div className="chat-scroll" ref={chatRef}>
        {turns.length === 0 && !streaming ? (
          <div className="lc-empty"><p className="muted">No turns yet.</p></div>
        ) : (
          turns.map((t, i) => <TurnBubble key={i} turn={t} index={i} turns={turns} onRetry={retryTurn} />)
        )}
        {streaming && <StreamBubble text={streamText} />}
        {!streaming && turns.length > 0 && turns[turns.length - 1]?.role === 'user' && (
          <div className="gen-note">
            <span className="muted">This reply didn't get a response.</span>
            <button className="btn ghost" onClick={continueTurn}>Generate response</button>
          </div>
        )}
      </div>

      {!streaming && (
        <div className="composer">
          <div className="composer-row">
            <textarea
              className="composer-input"
              placeholder="Type your reply…"
              value={reply}
              onChange={(e) => {
                setReply(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply();
              }}
              rows={1}
            />
            <button className="btn primary" onClick={sendReply} disabled={!reply.trim()}>Send</button>
          </div>
          <div className="composer-actions">
            <button className="btn ghost" onClick={finishPaper}>We're done — draft notes</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TurnBubble({ turn, index, turns, onRetry }: {
  turn: SessionTurn;
  index: number;
  turns: SessionTurn[];
  onRetry: (idx: number, model?: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isUser = turn.role === 'user';
  const aidx = turns.slice(0, index + 1).filter((t) => t.role === 'assistant').length - 1;

  if (isUser) {
    return (
      <div className="turn">
        <div className="turn-who">You</div>
        <div className="bubble user">
          <div className="turn-text">{turn.text}</div>
        </div>
      </div>
    );
  }

  const signal = turn.state_signal === 'ready_to_draft_notes'
    ? <span className="turn-signal">ready to draft notes</span>
    : null;

  return (
    <div className="turn">
      <div className="turn-who">
        <span>Companion{signal}</span>
      </div>
      <div className="bubble assistant">
        <div className="turn-text" dangerouslySetInnerHTML={{ __html: marked.parse(turn.canonical || '') as string }} />
      </div>
      <div className="turn-actions">
        <button className="menu-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="More actions">⋯</button>
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
  if (!text) {
    return (
      <div className="turn">
        <div className="turn-who">Companion</div>
        <div className="bubble assistant"><div className="lc-loading"><span className="spinner" /> Thinking…</div></div>
      </div>
    );
  }
  return (
    <div className="turn">
      <div className="turn-who">Companion</div>
      <div className="bubble assistant">
        <div className="turn-text" dangerouslySetInnerHTML={{ __html: marked.parse(text) as string }} />
      </div>
    </div>
  );
}
