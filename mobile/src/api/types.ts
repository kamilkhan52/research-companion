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
  has_parallel_key: boolean;
  parallel_key_hint: string;
  has_firecrawl_key: boolean;
  firecrawl_key_hint: string;
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

/** SSE events emitted by the *_stream endpoints (app/main.py _turn_stream /
 *  _agentic_turn_stream). 'tool' events appear only on the agentic path (RC_AGENTIC). */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'error'; detail: string }
  | { type: 'done'; turn: Turn; state: SessionState };

/** A research tool the agent invoked mid-turn, surfaced for live "what it's doing" UI. */
export interface ToolActivity {
  name: string;
  detail: string;
}

/** One item in the ordered live stream of an agentic turn — a run of assistant text or a tool
 *  invocation — kept in arrival order so the UI can interleave them ("…thinking… → 🔎 search →
 *  …answer") the way agent UIs conventionally do. */
export type StreamItem =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string };

/** SSE events from POST /start_stream (paper retrieval with live steps: deterministic stages
 *  plus the PDF-hunt agent's tool calls). */
export type StartStreamEvent =
  | { type: 'step'; name: string; detail: string }
  | { type: 'needs_confirmation'; candidates: unknown[] }
  | { type: 'done'; retrieved: boolean }
  | { type: 'error'; detail: string };

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
  /** Global citation count (Semantic Scholar), when known; null/absent when not found. */
  citation_count?: number | null;
  // Server-precomputed layout position (temporal Y: recent toward the bottom). Present on
  // graphs built after layout was added; absent ones fall back to a client-side sim.
  x?: number;
  y?: number;
}

/** A recommended external node, with its score + human-readable reasons. */
export interface GraphRecommendation extends GraphNode {
  recommend_score: number;
  recommend_reasons: string[];
  /** Betweenness centrality (0-1, normalized to this graph's own max) — how much this node
   * sits on shortest paths connecting otherwise-distant parts of the citation network. */
  betweenness_centrality: number;
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
  /** Canvas bounds for the server-precomputed node positions, when present. */
  layout?: { width: number; height: number };
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

/** Per-paper status within an in-flight or finished build job. */
export interface GraphBuildPaperStatus {
  status: 'extracting' | 'cached' | 'done' | 'error';
  error: string | null;
}

/** A reference-graph build job (app/graph_jobs.py BuildJob). Runs server-side in a background
 * thread, independent of any request — the client polls for this rather than holding a
 * connection open, so it survives the app being backgrounded/reconnected/relaunched. */
export interface GraphBuildJob {
  status: 'running' | 'done' | 'error';
  total: number;
  done: number;
  current_slug: string | null;
  current_title: string | null;
  per_paper: Record<string, GraphBuildPaperStatus>;
  graph: ReferenceGraph | null;
  recommendations: GraphRecommendation[] | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** GET /api/projects/{pid}/graph */
export interface GraphResponse {
  graph: ReferenceGraph | null;
  recommendations: GraphRecommendation[];
  status: GraphStatus;
  /** Snapshot of the current/most-recent build job for this project, if any has ever run. */
  build: GraphBuildJob | null;
}

/** GET /api/projects/{pid}/graph/build/status */
export interface GraphBuildStatusResponse {
  build: GraphBuildJob | null;
}

/** POST /api/projects/{pid}/graph/build */
export interface GraphBuildStartResponse {
  build: GraphBuildJob;
}
