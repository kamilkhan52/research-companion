import { useState, useMemo, useEffect } from 'react';
import { createProject, getRecentSessions, removePaper } from '@/api/endpoints';
import type { Paper, RecentSession } from '@/api/types';
import { useLibrary } from '@/hooks/useLibrary';
import { AddPaperSheet } from '@/components/AddPaper';
import { paperHash } from '@/routes';
import './Library.css';

interface Props {
  onNavigate: (hash: string) => void;
}

const STATE_LABELS: Record<string, string> = {
  unread: 'Unread',
  retrieving: 'Retrieving',
  in_discussion: 'Discussing',
  notes_drafted: 'Notes drafted',
  committed: 'Read',
};

const STATE_COLORS: Record<string, string> = {
  unread: 'muted',
  retrieving: 'amber',
  in_discussion: 'cyan',
  notes_drafted: 'violet',
  committed: 'green',
};

type StatusFilter = 'all' | 'toread' | 'inprogress' | 'done';
// Names the state, not an instruction (DR-005). Keep in step with the mobile Library and with
// `paperStatus` below; the keys are persisted, so only labels change.
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'toread', label: 'Unread' },
  { key: 'inprogress', label: 'Discussing' }, { key: 'done', label: 'Read' },
];

function paperStatus(p: Paper): string {
  if (p.list_status === 'read' || p.session_state === 'committed') return 'committed';
  return p.session_state || 'unread';
}

function bucket(p: Paper): Exclude<StatusFilter, 'all'> {
  const state = paperStatus(p);
  if (state === 'committed') return 'done';
  if (state === 'in_discussion' || state === 'notes_drafted') return 'inprogress';
  return 'toread';
}

export function Library({ onNavigate }: Props) {
  const { projects, activePid, setActivePid, state, loading, error, refetch } = useLibrary();
  const [newName, setNewName] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [recent, setRecent] = useState<RecentSession[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !activePid || !state) return;
    void getRecentSessions()
      .then(({ sessions }) => setRecent(Array.isArray(sessions) ? sessions : []))
      .catch(() => setRecent([]));
  }, [activePid, loading, state]);
  const papers = state?.papers ?? [];
  const counts = useMemo(() => {
    const result = { all: papers.length, toread: 0, inprogress: 0, done: 0 };
    papers.forEach((paper) => { result[bucket(paper)] += 1; });
    return result;
  }, [papers]);
  const visiblePapers = filter === 'all' ? papers : papers.filter((paper) => bucket(paper) === filter);
  const continueSession = recent.find((session) => session.kind === 'paper' && session.state !== 'committed');

  async function confirmRemove(paper: Paper) {
    if (!activePid || !window.confirm(`Remove “${paper.title}” from this project? Its notes will be kept and marked as removed.`)) return;
    setRemoving(paper.slug); setActionError(null);
    try { await removePaper(activePid, paper.slug); refetch();
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally { setRemoving(null); }
  }

  if (loading) {
    return (
      <div className="lc-loading">
        <span className="spinner" /> Loading library…
      </div>
    );
  }

  if (error) {
    return (
      <div className="library">
        {projects.length > 0 && (
          <ProjectBar
            projects={projects}
            activePid={activePid || ''}
            onSelect={setActivePid}
            onNew={() => setShowNew(true)}
          />
        )}
        <div className="lc-empty">
          <p className="muted">{error}</p>
          <button className="btn ghost" onClick={refetch}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="lc-empty">
        <h3>No projects yet</h3>
        <p className="muted">Create a research project to get started.</p>
        <button className="btn primary" onClick={() => setShowNew(true)}>
          + New project
        </button>
        {showNew && (
          <NewProjectForm
            name={newName}
            onChange={setNewName}
            onCreate={async () => {
              if (!newName.trim()) return;
              try {
                const r = await createProject(newName.trim());
                setActivePid(r.project.id);
                setNewName('');
                setShowNew(false);
                refetch();
              } catch { /* handled inline */ }
            }}
            onCancel={() => { setShowNew(false); setNewName(''); }}
          />
        )}
      </div>
    );
  }

  if (!activePid) {
    return null;
  }

  return (
    <div className="library">
      <ProjectBar
        projects={projects}
        activePid={activePid}
        onSelect={setActivePid}
        onNew={() => setShowNew(true)}
        onAdd={() => setShowAdd(true)}
      />

      {showAdd && (
        <AddPaperSheet
          pid={activePid}
          // Refetch on every close, not only on the hand-off: an add that landed after the
          // reader dismissed the sheet is still on the reading list and has to show up.
          onClose={() => { setShowAdd(false); refetch(); }}
          onAdded={(slug, source) => {
            setShowAdd(false);
            refetch();
            onNavigate(paperHash(slug, source));
          }}
          onExplore={() => { setShowAdd(false); onNavigate('discover'); }}
        />
      )}

      {showNew && (
        <NewProjectForm
          name={newName}
          onChange={setNewName}
          onCreate={async () => {
            if (!newName.trim()) return;
            try {
              const r = await createProject(newName.trim());
              setActivePid(r.project.id);
              setNewName('');
              setShowNew(false);
              refetch();
            } catch (e) {
              /* handled inline */
            }
          }}
          onCancel={() => { setShowNew(false); setNewName(''); }}
        />
      )}

      {continueSession && <button className="continue-card" onClick={() => {
        setActivePid(continueSession.project_id);
        onNavigate(`paper/${encodeURIComponent(continueSession.slug)}`);
      }}><span className="continue-label">Continue reading</span><strong>{continueSession.title}</strong>
        <span className="muted">{continueSession.project_name} · {new Date(continueSession.updated_at).toLocaleString()}</span></button>}

      {state && state.project.paper_count ? <section className="progress-card">
        <div><strong>Project progress</strong><span className="muted">{state.project.read_count ?? 0} of {state.project.paper_count} complete</span></div>
        <progress value={state.project.read_count ?? 0} max={state.project.paper_count} />
      </section> : null}

      {papers.length > 0 && <div className="library-filters" aria-label="Paper status filters">
        {FILTERS.map((item) => <button key={item.key} className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>{item.label} {counts[item.key]}</button>)}
      </div>}
      {actionError && <p className="build-progress-error">{actionError}</p>}

      {!state ? null : papers.length === 0 ? (
        <div className="lc-empty">
          <h3>Start this project</h3>
          <p className="muted">
            Add a paper you already have in mind, or describe your research goals and let
            Discover find foundational readings.
          </p>
          <div className="btn-row lc-empty-actions">
            <button className="btn primary" onClick={() => setShowAdd(true)}>
              Add a paper
            </button>
            <button className="btn ghost" onClick={() => onNavigate('discover')}>
              Explore with Discover
            </button>
          </div>
        </div>
      ) : visiblePapers.length === 0 ? <p className="lc-empty muted">No papers match this filter.</p> : <div className="paper-list">
        {visiblePapers.map((paper) => <article key={paper.slug} className="paper-card">
          <button className="paper-open" onClick={() => onNavigate(`paper/${encodeURIComponent(paper.slug)}`)}>
            <div className="paper-card-body"><div className="paper-card-meta"><StatusBadge paper={paper} />{paper.year ? <span className="muted paper-year">{paper.year}</span> : null}</div><div className="paper-card-title">{paper.title}</div></div>
            <span className="paper-action">{bucket(paper) === 'done' ? 'Open' : bucket(paper) === 'toread' ? 'Read' : 'Resume'} ›</span>
          </button>
          <button className="paper-remove" aria-label={`Remove ${paper.title}`} disabled={removing === paper.slug} onClick={() => void confirmRemove(paper)}>Remove</button>
        </article>)}
      </div>}
    </div>
  );
}

function ProjectBar({
  projects,
  activePid,
  onSelect,
  onNew,
  onAdd,
}: {
  projects: { id: string; name: string; paper_count: number; read_count: number }[];
  activePid: string;
  onSelect: (pid: string) => void;
  onNew: () => void;
  /** Absent while the library is in its error state, where there may be no project to add to. */
  onAdd?: () => void;
}) {
  return (
    <div className="project-bar">
      <select
        className="project-select"
        value={activePid}
        onChange={(e) => onSelect(e.target.value)}
        aria-label="Active project"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.read_count}/{p.paper_count})
          </option>
        ))}
      </select>
      {onAdd && (
        <button className="icon-btn add-paper-btn" onClick={onAdd} aria-label="Add a paper" title="Add a paper">
          +
        </button>
      )}
      <button className="btn ghost" onClick={onNew} aria-label="New project">
        New project
      </button>

    </div>
  );
}

function StatusBadge({ paper }: { paper: Paper }) {
  const st = paperStatus(paper);
  const label = STATE_LABELS[st] || st;
  const color = STATE_COLORS[st] || 'muted';
  return <span className={`badge badge-${color}`}>{label}</span>;
}

function NewProjectForm({
  name,
  onChange,
  onCreate,
  onCancel,
}: {
  name: string;
  onChange: (v: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="new-project-form">
      <input
        className="new-project-input"
        type="text"
        placeholder="Project name…"
        value={name}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onCreate(); }}
        autoFocus
      />
      <div className="new-project-actions">
        <button className="btn primary" onClick={onCreate}>
          Create
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
