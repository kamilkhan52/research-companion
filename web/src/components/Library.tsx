import { useState, useMemo } from 'react';
import { createProject } from '@/api/endpoints';
import type { Paper } from '@/api/types';
import { useLibrary } from '@/hooks/useLibrary';
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

function paperStatus(p: Paper): string {
  if (p.list_status === 'read' || p.session_state === 'committed') return 'committed';
  return p.session_state || 'unread';
}

export function Library({ onNavigate }: Props) {
  const { projects, activePid, setActivePid, state, loading, error, refetch } = useLibrary();
  const [newName, setNewName] = useState('');
  const [showNew, setShowNew] = useState(false);

  const grouped = useMemo(() => {
    if (!state?.papers) return [];
    const map = new Map<string, Paper[]>();
    for (const p of state.papers) {
      const g = p.group || 'Ungrouped';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(p);
    }
    return Array.from(map, ([group, papers]) => ({ group, papers }));
  }, [state]);

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
            onNavigate={onNavigate}
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
        onNavigate={onNavigate}
      />

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

      {!state ? null : grouped.length === 0 ? (
        <div className="lc-empty">
          <h3>Start this project</h3>
          <p className="muted">
            Describe your research goals to discover foundational readings from arXiv.
          </p>
          <button className="btn primary" onClick={() => onNavigate('discover')}>
            Find papers
          </button>
        </div>
      ) : (
        <div className="paper-list">
          {grouped.map(({ group, papers }) => (
            <div key={group} className="paper-group">
              <div className="group-header">{group.toUpperCase()}</div>
              {papers.map((p) => (
                <div
                  key={p.slug}
                  className="paper-card"
                  onClick={() => onNavigate(`paper/${encodeURIComponent(p.slug)}`)}
                >
                  <div className="paper-card-body">
                    <div className="paper-card-title">{p.title}</div>
                    <div className="paper-card-slug muted">{p.slug}</div>
                  </div>
                  <StatusBadge paper={p} />
                  <span className="paper-card-chevron">›</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectBar({
  projects,
  activePid,
  onSelect,
  onNew,
  onNavigate,
}: {
  projects: { id: string; name: string; paper_count: number; read_count: number }[];
  activePid: string;
  onSelect: (pid: string) => void;
  onNew: () => void;
  onNavigate: (hash: string) => void;
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
      <button className="btn ghost" onClick={onNew} aria-label="New project">
        + New
      </button>

      <div className="project-nav">
        <button className="nav-btn" onClick={() => onNavigate('discover')} aria-label="Discover">
          <span className="nav-icon">⌕</span>
          <span className="nav-label">Discover</span>
        </button>
        <button className="nav-btn" onClick={() => onNavigate('notes/working')} aria-label="Notes">
          <span className="nav-icon">✎</span>
          <span className="nav-label">Notes</span>
        </button>
        <button className="nav-btn" onClick={() => onNavigate('graph')} aria-label="Graph">
          <span className="nav-icon">✦</span>
          <span className="nav-label">Graph</span>
        </button>
      </div>
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
