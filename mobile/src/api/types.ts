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

// ---------- reference graph (app/graph.py) ----------

/** One node in the reference graph: an in-project paper, or an external cited work. */
export interface GraphNode {
  id: string;                    // project paper: its slug. external: "ext:<dedupe key>"
  kind: 'project' | 'external';
  slug: string | null;           // set only for kind === 'project'; links to Discussion
  title: string;
  authors: string[];
  venue: string;
  year: number | null;
  arxiv_id: string | null;
  doi: string | null;
  url: string | null;
  group: string | null;          // project papers only (reading-list section)
  list_status: 'unread' | 'read' | null;
  cited_by_project_count: number;
  significant_cited_by_count: number;
  cites_count: number;
}

/** A recommended external node, with its score + human-readable reasons. */
export interface GraphRecommendation extends GraphNode {
  recommend_score: number;
  recommend_reasons: string[];
}

/** A directed citation edge: source (always a project paper) -> target (project or external). */
export interface GraphEdge {
  source: string;
  target: string;
  significant: boolean;
  reason: string;
  contexts: string[];
  confidence: number;
  raw_text: string;
}

export interface ReferenceGraph {
  built_at: string;
  model: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Cheap, no-LLM status check: which papers still need (re)extraction. */
export interface GraphStatus {
  has_graph: boolean;
  built_at: string | null;
  model: string | null;
  total_papers: number;
  retrievable_papers: number;
  stale_papers: string[];
  missing_text_papers: string[];
}

/** GET /api/projects/{pid}/graph */
export interface GraphResponse {
  graph: ReferenceGraph | null;
  recommendations: GraphRecommendation[];
  status: GraphStatus;
}

/** SSE events emitted by POST /api/projects/{pid}/graph/build (app/graph.py build_graph). */
export type GraphBuildEvent =
  | { type: 'start'; total: number; model: string }
  | { type: 'extracting'; slug: string; title: string }
  | { type: 'progress'; done: number; total: number; slug: string; status: 'done' | 'error';
      cached: boolean; error: string | null }
  | { type: 'done'; graph: ReferenceGraph; recommendations: GraphRecommendation[] }
  | { type: 'error'; detail: string };
