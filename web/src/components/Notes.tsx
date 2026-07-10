import { useCallback, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  getLatestNotesJob,
  getNotes,
  getNotesJob,
  saveNotes,
  startNotesAgentJob,
  type NotesData,
  type NotesJob,
} from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { useActivePid } from '@/hooks/useLibrary';
import './Notes.css';

interface Props { target: string; }
type Mode = 'view' | 'edit';

function markdown(markdownText: string): string {
  return DOMPurify.sanitize(marked.parse(markdownText) as string, {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  });
}

export function Notes({ target }: Props) {
  const [activePid] = useActivePid();
  const [data, setData] = useState<NotesData | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [editText, setEditText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentJob, setAgentJob] = useState<NotesJob | null>(null);
  const [proposalPreview, setProposalPreview] = useState<string | null>(null);
  const scopeRef = useRef({ pid: activePid, target });
  scopeRef.current = { pid: activePid, target };

  const current = useCallback((pid: string, expectedTarget: string) =>
    scopeRef.current.pid === pid && scopeRef.current.target === expectedTarget, []);

  const applyJob = useCallback((job: NotesJob | null) => {
    setAgentJob(job);
    if (!job) return;
    if (job.status === 'done' && job.result !== null) {
      setProposalPreview(job.result);
      setAgentOpen(false);
    }
    if (job.status === 'error') setError(job.error || 'Agent edit failed');
  }, []);

  useEffect(() => {
    const pid = activePid;
    const expectedTarget = target;
    let cancelled = false;
    setLoading(true);
    setData(null);
    setMode('view');
    setError(null);
    setAgentOpen(false);
    setAgentPrompt('');
    setAgentJob(null);
    setProposalPreview(null);
    if (!pid) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    void Promise.all([getNotes(pid, expectedTarget), getLatestNotesJob(pid, expectedTarget)])
      .then(([notes, latest]) => {
        if (cancelled || !current(pid, expectedTarget)) return;
        setData(notes);
        setEditText(notes.markdown || '');
        applyJob(latest.job);
      })
      .catch((caught) => {
        if (!cancelled && current(pid, expectedTarget)) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { if (!cancelled && current(pid, expectedTarget)) setLoading(false); });
    return () => { cancelled = true; };
  }, [activePid, applyJob, current, target]);

  // One in-flight poll at a time. Terminal jobs are fetched from the server before state is
  // updated, so a late "running" response cannot erase a proposal that is ready for review.
  useEffect(() => {
    const pid = activePid;
    const expectedTarget = target;
    if (!pid || agentJob?.status !== 'running') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const { job } = await getNotesJob(pid, agentJob.id);
        if (cancelled || !current(pid, expectedTarget)) return;
        applyJob(job);
        if (job.status !== 'running') return;
      } catch (caught) {
        if (cancelled || !current(pid, expectedTarget)) return;
        if (caught instanceof ApiError && caught.status === 404) {
          try {
            const { job } = await getLatestNotesJob(pid, expectedTarget);
            if (!cancelled && current(pid, expectedTarget)) applyJob(job);
            return;
          } catch { /* The next re-entry can retry the retained proposal lookup. */ }
        }
      }
      if (!cancelled) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [activePid, agentJob?.id, agentJob?.status, applyJob, current, target]);

  async function save() {
    if (!activePid || !data) return;
    setSaving(true);
    setError(null);
    try {
      await saveNotes(activePid, target, editText);
      if (current(activePid, target)) {
        setData({ ...data, markdown: editText });
        setMode('view');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function startAgent() {
    if (!activePid || !agentPrompt.trim()) return;
    setError(null);
    try {
      const { job } = await startNotesAgentJob(activePid, target, agentPrompt.trim());
      if (current(activePid, target)) {
        setAgentJob(job);
        setAgentPrompt('');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function applyProposal() {
    if (!activePid || proposalPreview === null || !data) return;
    setSaving(true);
    setError(null);
    try {
      // This is the human approval point: only this explicit action writes and commits a
      // generated proposal to the git-backed project record.
      await saveNotes(activePid, target, proposalPreview);
      if (current(activePid, target)) {
        setData({ ...data, markdown: proposalPreview });
        setEditText(proposalPreview);
        setProposalPreview(null);
        setAgentJob(null);
        setMode('view');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="lc-loading"><span className="spinner" /> Loading notes…</div>;
  if (!data) return <div className="lc-empty"><p className="muted">{error || 'Not found.'}</p></div>;

  return (
    <div className="notes">
      <div className="notes-head">
        <h3>{data.title || (target === 'working' ? 'Working notes' : target)}</h3>
        <div className="notes-actions">
          {mode === 'view' ? <>
            <button className="btn ghost" onClick={() => { setEditText(data.markdown || ''); setMode('edit'); }}>Edit</button>
            <button className="btn ghost" onClick={() => setAgentOpen((open) => !open)}>Agent</button>
          </> : <>
            <button className="btn primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button className="btn ghost" onClick={() => { setEditText(data.markdown || ''); setMode('view'); }}>Cancel</button>
          </>}
        </div>
      </div>

      {error && <p className="build-progress-error">{error}</p>}
      {agentOpen && <div className="agent-panel">
        <textarea className="discovery-goals" rows={3} value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)}
          placeholder="Instructions for the agent: e.g. reorganize by theme, add a summary section…" />
        <div className="notes-agent-actions">
          <button className="btn primary" onClick={() => void startAgent()} disabled={agentJob?.status === 'running' || !agentPrompt.trim()}>
            {agentJob?.status === 'running' ? 'Agent working…' : 'Ask agent to edit'}
          </button>
          <button className="btn ghost" onClick={() => setAgentOpen(false)}>Cancel</button>
        </div>
      </div>}

      {agentJob?.status === 'running' && <div className="lc-loading"><span className="spinner" /> Agent is editing…</div>}
      {proposalPreview !== null && <div className="agent-proposal">
        <h4>Agent proposal</h4>
        <div className="notes-body" style={{ marginBottom: 'var(--space-md)', maxHeight: 300, overflowY: 'auto' }}
          dangerouslySetInnerHTML={{ __html: markdown(proposalPreview) }} />
        <div className="notes-agent-actions">
          <button className="btn primary" onClick={() => void applyProposal()} disabled={saving}>Apply proposal</button>
          <button className="btn ghost" onClick={() => { setProposalPreview(null); setAgentJob(null); }}>Discard</button>
        </div>
      </div>}

      {mode === 'view'
        ? <div className="notes-body" dangerouslySetInnerHTML={{ __html: markdown(data.markdown || '') }} />
        : <textarea className="notes-editor" value={editText} onChange={(event) => setEditText(event.target.value)} />}
    </div>
  );
}
