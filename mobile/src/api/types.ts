// Domain types — mirror the backend dataclasses in app/models.py and the dict shapes
// returned by app/main.py. The backend returns plain dicts (no response_model), so these
// are hand-maintained against the Python source rather than generated.

/** Paper lifecycle state (app/models.py). null = no session yet. */
export type SessionState =
  | 'unread'
  | 'retrieving'
  | 'in_discussion'
  | 'notes_drafted'
  | 'committed'
  | null;

/** A project in the registry (GET /api/projects). */
export interface Project {
  id: string;
  name: string;
  created_at: string | null;
  paper_count: number;
  read_count: number;
}

/** A paper (Paper.to_dict()). */
export interface Paper {
  slug: string;
  title: string;
  group: string;
  list_status: 'unread' | 'read';
  cites: string[];
  retrieved: boolean;
  has_notes: boolean;
  session_state: SessionState;
  // The review pseudo-paper carries an extra kind field.
  kind?: string;
}

/** What the agent proposes at completion, pending human approval. */
export interface ProposedCommit {
  summary: string;
  notes_block: string;
  synthesis: string;
}

/** One UI-facing transcript entry (sessions.transcript()). */
export type TranscriptEntry =
  | { role: 'user'; text: string }
  | {
      role: 'assistant';
      canonical: string;
      narration: string;
      state_signal: string;
      proposed_commit: ProposedCommit | null;
    };

/** GET /api/projects/{pid}/state */
export interface ProjectState {
  project: { id: string; name: string } & Partial<Project>;
  has_key: boolean;
  model: string | null;
  narration_model: string | null;
  speech_provider: string | null;
  has_openai_key: boolean;
  papers: Paper[];
}

/** GET /api/projects/{pid}/session/{slug} */
export interface Session {
  paper: Paper;
  state: SessionState;
  transcript: TranscriptEntry[];
}

/** GET /api/projects/{pid}/opening_draft/{slug} */
export interface OpeningDraft {
  prompt: string;
  model: string | null;
  title: string;
}

/** GET /api/settings */
export interface Settings {
  has_key: boolean;
  key_hint: string;
  model: string | null;
  narration_model: string | null;
  has_openai_key: boolean;
  openai_key_hint: string;
  speech_provider: string | null;
  tts_model: string | null;
  tts_voice: string | null;
  voices: string[];
}

/** GET /api/auth/config */
export interface AuthConfig {
  mode: 'supabase' | 'token' | 'open';
  supabase_url?: string;
  supabase_anon_key?: string;
}

export interface ModelOption {
  id: string;
  name: string;
}

export interface FavoriteModel {
  label: string;
  id: string;
}

/** A parsed assistant turn (Turn.to_dict()), returned by streaming 'done' + sync endpoints. */
export interface Turn {
  role: 'user' | 'assistant';
  canonical: string;
  narration: string;
  state_signal: string;
  proposed_commit: ProposedCommit | null;
  ts: string;
}

/** SSE events emitted by the *_stream endpoints (app/main.py _turn_stream). */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'error'; detail: string }
  | { type: 'done'; turn: Turn; state: SessionState };
