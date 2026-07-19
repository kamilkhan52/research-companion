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
  favorite: boolean;
  paper_count: number;
  read_count: number;
}

/** One cross-project activity entry (GET /api/recent-sessions). */
export interface RecentSession {
  project_id: string;
  project_name: string;
  slug: string;
  title: string;
  kind: 'paper' | 'review';
  state: SessionState;
  started_at: string | null;
  updated_at: string;
  arxiv_id?: string;
  source_url?: string;
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
  /** The entry's arxiv id when reading-list.md carries one ("" otherwise). */
  arxiv_id: string;
  /** Original PDF/source URL recorded when the paper was retrieved ("" otherwise). */
  source_url?: string;
  /** Publication year — explicit `<!-- year -->` comment or derived from the arXiv id. */
  year?: number | null;
  // The review pseudo-paper carries an extra kind field.
  kind?: string;
}

/** One figure from the paper's arXiv-HTML rendering (R.10). `asset` is the cached image's
 *  filename — build its URL with figureAssetUrl(); `number` is the paper's own "Figure N". */
export interface PaperFigure {
  id: string;
  number: number | null;
  caption: string;
  alt: string;
  src: string;
  asset: string;
  width?: number | null;
  height?: number | null;
}

/** GET .../papers/{slug}/figures — `none` means render exactly as before figures existed. */
export interface FigureManifest {
  status: 'done' | 'none';
  figures: PaperFigure[];
  source?: string | null;
  /** Doubles as the cache-busting version for asset URLs (changes on re-derivation). */
  fetched_ts?: number | null;
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
      assistant_index: number;
      delivery_mode: 'reading' | 'listening';
      chat_job_id: string | null;
      audio_job_id: string | null;
      audio_error: string | null;
      /** The model that generated this turn, set only when it differed from the settings
       *  default at generation time (e.g. a cross-model retry) — render a subtle badge. */
      model?: string | null;
      /** What the agent did before answering (tool calls + intermediate commentary) — the
       *  collapsed, expandable trail on a finished agentic message (R6.8). */
      agent_trail?: AgentTrailItem[] | null;
      /** Retry-fork selector state (U.14): total branches / 1-based live branch at this fork
       *  point; null when the turn was never retried. */
      branch_count?: number | null;
      branch_active?: number | null;
    };

/** GET /api/projects/{pid}/state */
export interface ProjectState {
  project: { id: string; name: string } & Partial<Project>;
  has_key: boolean;
  model: string | null;
  narration_model: string | null;
  preview_model: string | null;
  speech_provider: string | null;
  has_openai_key: boolean;
  papers: Paper[];
}

/** How the analyst pitches its explanations for this session (polish plan H.3).
 *  'balanced' is the default; the others layer a register-tuning block onto the system
 *  prompt for every subsequent turn. */
export type ReadingMode = 'balanced' | 'background' | 'technical' | 'detailed';

/** Snapshot of a background paper-retrieval job (POST/GET /retrieval/jobs). With
 *  auto_analyze, a successful retrieval chains into the first analysis turn and the spawned
 *  chat job's id appears as analysis_job_id (R7.8). */
export interface RetrievalJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  error: string | null;
  slug: string;
  phase: 'resolving' | 'hunting' | 'confirmation' | 'done';
  detail: string;
  candidates: unknown[];
  retrieved: boolean;
  analysis_job_id: string | null;
  analysis_error: string | null;
}

export const READING_MODE_LABELS: Record<ReadingMode, string> = {
  balanced: 'Balanced',
  background: 'Background-heavy',
  technical: 'Technical',
  detailed: 'Detailed',
};

/** GET /api/projects/{pid}/session/{slug} */
export interface Session {
  paper: Paper;
  state: SessionState;
  reading_mode: ReadingMode;
  transcript: TranscriptEntry[];
  accepted_drafts: { kind: 'reply' | 'revision'; text: string }[];
}

/** GET /api/projects/{pid}/review/{slug} — the proposed commit for the notes-drafted review. */
export interface Review {
  slug: string;
  title: string;
  summary: string;
  notes_block: string;
  synthesis_current: string;
  synthesis_proposed: string;
  /** Echoed back with an explicit-payload approve; a branch switch/regeneration changes it and
   *  the stale approval is refused (409). */
  proposal_revision: string | null;
}

/** GET /api/projects/{pid}/opening_draft/{slug} */
export interface OpeningDraft {
  prompt: string;
  templates?: Record<ReadingMode, string>;
  model: string | null;
  title: string;
}

/** GET /api/settings */
export interface Settings {
  has_key: boolean;
  key_hint: string;
  model: string | null;
  narration_model: string | null;
  preview_model: string | null;
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
  has_semantic_scholar_key: boolean;
  semantic_scholar_key_hint: string;
  /** Which prior per-paper Notes go into each paper turn's context. */
  prior_notes_scope: 'related' | 'all';
}

/** One effective workflow prompt and its live filesystem validation status (GET /api/prompts). */
export interface PromptStatus {
  key: string;
  label: string;
  description: string;
  storage: 'file' | 'override';
  scope: 'global' | 'project';
  relative_path: string;
  value: string;
  placeholders: string[];
  required_literals: string[];
  is_overridden: boolean;
  managed: boolean;
  source: 'vault' | 'project' | 'last_valid' | 'legacy_override' | 'bundled_default';
  effective_source: string;
  path: string | null;
  valid: boolean;
  error: string | null;
  modified_at: string | null;
  effective_hash: string;
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
  | { kind: 'tool'; name: string; detail: string }
  /** Pre-tool commentary the model streamed before calling a tool ("Let me search…") —
   *  demoted server-side at each segment boundary; part of the activity trail, never the
   *  answer (R6.8). */
  | { kind: 'thought'; text: string };

/** A finished turn's persisted activity trail (tool calls + thoughts, no answer text). */
export type AgentTrailItem = Exclude<StreamItem, { kind: 'text' }>;

/** Snapshot of a server-side chat turn job (app/chat_jobs.py). The turn runs in a backend
 *  thread and is recorded to the session the moment it completes, regardless of what any
 *  client does; we poll this snapshot for live progress and can reattach after navigating
 *  away, backgrounding, or a dropped connection. */
export interface ChatJob {
  id: string;
  slug: string;
  status: 'running' | 'done' | 'error';
  items: StreamItem[];
  turn: Turn | null;
  state: SessionState | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  delivery_mode: 'reading' | 'listening';
  audio_job_id: string | null;
  audio_error: string | null;
  assistant_index: number | null;
  preview_job_ids: string[];
  preview_coordinator_id: string | null;
  preview_complete: boolean;
  preview_phase: string | null;
  preview_progress: Record<string, unknown>;
  timings: Record<string, string>;
  /** True once a best-effort stop was requested; the job still settles as 'done'. */
  cancelled: boolean;
}

/** One short, grounded listening cue generated independently from a live chat turn. */
export interface PreviewJob {
  id: string;
  chat_job_id: string;
  ordinal: number;
  status: 'running' | 'done' | 'error';
  stage: 'generating' | 'synthesizing';
  sentence_ids: string[];
  source_sentence_ids: string[];
  cue: string | null;
  url: string | null;
  model: string | null;
  suppressed: boolean;
  timings: Record<string, string>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** A committed notes document (GET /notes/{target}): one paper's Notes block, or the
 *  cross-paper working notes when target === 'working'. markdown is '' when none exist yet. */
export interface NotesDoc {
  target: string;
  title: string;
  markdown: string;
}

/** Snapshot of a server-side notes-edit job (app/notes_jobs.py): the notes-editor agent
 *  revising a document from a natural-language instruction. `result` is a PROPOSAL — the
 *  client previews it and applies it via saveNotes; nothing is written until then. */
export interface NotesJob {
  id: string;
  target: string;
  instruction: string;
  kind: 'edit' | 'split_destination' | 'split_source_cleanup';
  summary: string;
  base_revision: string;
  /** Present for a paper-by-paper relocation integration queue. */
  relocation_index: number | null;
  relocation_total: number | null;
  relocation_title: string | null;
  status: 'running' | 'done' | 'error' | 'cancelled';
  items: StreamItem[];
  result: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** One entry in a paper's 'Related works' menu (GET /related/{slug}): a significant related
 *  work from the reference graph, with why it matters. */
export interface RelatedWork {
  id: string;
  kind: 'project' | 'external';
  slug: string | null;
  title: string;
  year: number | null;
  venue: string;
  arxiv_id: string | null;
  url: string | null;
  list_status: 'unread' | 'read' | null;
  citation_count: number | null;
  direction: 'builds_on' | 'built_on_by';
  reason: string;
}

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
  /** Evidence sources used to create or enrich this node. Absent on older cached graphs. */
  provenance?: Array<'reading_list' | 'full_text' | 'semantic_scholar'>;
  // Server-precomputed layout position (X = publication time, older→left; Y = citation
  // impact, more-cited→top; see app/graph_layout.py). Present on
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
  provenance?: Array<'full_text' | 'semantic_scholar'>;
  full_text_verified?: boolean;
  provider_evidence?: {
    semantic_scholar?: {
      paper_id: string | null;
      contexts: string[];
      intents: string[];
      is_influential: boolean;
    };
  };
}

export interface ReferenceGraph {
  built_at: string;
  revision: string;
  model: string;
  stage: 'skeleton' | 'enriched';
  completeness: GraphCompleteness;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Canvas bounds + layout algorithm marker for the server-precomputed positions. Clients
   *  show the axis legends only for algo 'semantic-v2' (X = time, Y = citation impact) —
   *  older persisted layouts carry different meaning until the next rebuild. */
  layout?: { width: number; height: number; algo?: string };
}

export interface GraphCompleteness {
  total_papers: number;
  metadata_papers: number;
  ready_papers: number;
  analyzed_papers: number;
  metadata_only_edges: number;
  full_text_edges: number;
}

/** Cheap, no-LLM status check: which papers still need (re)extraction. */
export interface GraphStatus {
  has_graph: boolean;
  built_at: string | null;
  model: string | null;
  graph_revision: string | null;
  graph_stage: 'skeleton' | 'enriched' | null;
  graph_completeness: GraphCompleteness | null;
  graph_needs_enrichment: boolean;
  total_papers: number;
  retrievable_papers: number;
  stale_papers: string[];
  /** Project nodes still in the stored graph whose papers left the reading list (also
   *  included in stale_papers so the rebuild affordance lights up). */
  removed_papers: string[];
  missing_text_papers: string[];
  semantic_scholar_enabled: boolean;
  semantic_scholar_papers: number;
  semantic_scholar_stale_papers: string[];
  retrieval_candidates: Record<string, GraphRetrievalCandidate[]>;
  retrieval_errors: Record<string, string>;
}

export interface GraphRetrievalCandidate {
  arxiv_id: string;
  title: string;
  score: number;
  pdf_url?: string;
}

/** Per-paper status within an in-flight or finished build job. */
export interface GraphBuildPaperStatus {
  status:
    | 'metadata' | 'metadata_cached' | 'retrieving' | 'retrieval_cached'
    | 'needs_confirmation' | 'extracting' | 'cached' | 'done' | 'not_found' | 'error';
  error: string | null;
}

/** A reference-graph build job (app/graph_jobs.py BuildJob). Runs server-side in a background
 * thread, independent of any request — the client polls for this rather than holding a
 * connection open, so it survives the app being backgrounded/reconnected/relaunched. */
export interface GraphBuildJob {
  status: 'running' | 'done' | 'error';
  phase: 'preparing' | 'metadata' | 'skeleton_ready' | 'retrieval' | 'extraction' | 'complete';
  total: number;
  ready: number;
  done: number;
  current_slug: string | null;
  current_title: string | null;
  per_paper: Record<string, GraphBuildPaperStatus>;
  retrieval_candidates: Record<string, GraphRetrievalCandidate[]>;
  graph_stage: 'skeleton' | 'enriched' | null;
  graph_completeness: GraphCompleteness | null;
  graph_revision: string | null;
  graph_updated_at: string | null;
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

/** One paper on an author's card sheet (U.9). Project papers open their Discussion; external
 *  ones get the U.5-aware Add button. */
export interface AuthorPaper {
  id: string;
  slug: string | null;
  title: string | null;
  kind: 'project' | 'external';
  year: number | null;
  /** External papers carry identifiers so they open the same menu as chat references
   *  (R7.6). Absent on project papers. */
  arxiv_id?: string | null;
  doi?: string | null;
  url?: string | null;
}

/** One author on the ranked board (GET …/graph/authors). Affiliation is "" when unknown
 *  (the UI omits the line rather than showing "Unknown"). */
export interface BoardAuthor {
  name: string;
  affiliation: string;
  in_project_count: number;
  significant_count: number;
  external_count: number;
  active_years: [number, number] | null;
  activity: number;
  papers: AuthorPaper[];
  /** Cached one-paragraph LLM profile, merged at read time; null until generated (R7.6). */
  profile?: string | null;
}

/** Snapshot of POST/GET /graph/authors/profile/job(s) — one-paragraph profile generation. */
export interface AuthorProfileJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  error: string | null;
  author: string;
  profile: string;
  cached: boolean;
}

/** One researched lab card (R7.7): an evidenced group with its board members. */
export interface LabCard {
  lab_name: string;
  institution: string;
  url: string;
  focus: string;
  members: string[];
  in_project_count: number;
  significant_count: number;
}

/** The lab-centric grouping merged into the authors response (R7.7). */
export interface LabsBoard {
  labs: LabCard[];
  covered_authors: string[];
  researched: boolean;
  researched_at: string | null;
}

/** Snapshot of the agentic lab-research pass over the top authors. */
export interface LabsResearchJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  error: string | null;
  total: number;
  done: number;
  current: string;
  found: number;
  skipped_cached: number;
}

/** GET /api/projects/{pid}/graph/authors */
export interface AuthorBoardResponse {
  authors: BoardAuthor[];
  /** Hidden-by-default explainer copy: what the activity score blends, and what "significant"
   *  means (factors, not the formula). */
  explainers: { activity: string; significant: string };
  built_at: string | null;
  labs: LabsBoard;
  labs_job: LabsResearchJob | null;
}

/** POST /api/projects/{pid}/graph/build */
export interface GraphBuildStartResponse {
  build: GraphBuildJob;
}

// ---------- discovery (app/discovery.py — goals -> suggested readings) ----------

/** One ranked candidate paper from a discovery run. */
export interface PaperSuggestion {
  candidate_id: string;
  arxiv_id: string | null;
  doi?: string | null;
  paper_id?: string | null;
  title: string;
  abstract: string;
  authors: string[];
  affiliations: string[];
  year: number | null;
  category: string;
  venue?: string;
  url: string;
  pdf_url: string;
  citation_count: number | null;
  influential_citation_count?: number | null;
  sources: ('arxiv' | 'semantic_scholar')[];
  /** LLM-scored fit to the project goals, 0-10. */
  relevance: number;
  /** LLM-scored strength of available scholarly evidence, 0-4. */
  credibility: number;
  /** Relevance-dominant blend with capped credibility and global-impact terms. */
  score: number;
  reasons: string[];
}

export interface DiscoveryQuery {
  query: string;
  search_terms?: string;
  phase: string; // 'broad' | 'narrow'
  rationale: string;
}

/** The persisted result of a discovery run (.state/discovery.json). `suggestions` is the
 * FULL ranked list — the UI leads with `top_n` and offers the rest behind "show more". */
export interface DiscoveryResult {
  goals: string;
  focus: string;
  model: string;
  queries: DiscoveryQuery[];
  candidate_count: number;
  source_counts?: { arxiv: number; semantic_scholar: number };
  top_n: number;
  suggestions: PaperSuggestion[];
  generated_at: string;
}

/** A discovery job (app/discovery_jobs.py DiscoveryJob). Runs server-side in a background
 * thread — two LLM calls plus paced multi-source enrichment take minutes — and the client polls,
 * same pattern as GraphBuildJob. */
export interface DiscoveryJob {
  status: 'running' | 'done' | 'error';
  phase: 'queries' | 'searching' | 'citations' | 'evidence' | 'scoring' | 'done';
  goals: string;
  focus: string;
  queries: DiscoveryQuery[];
  searched: number;
  total_queries: number;
  found: number;
  result: DiscoveryResult | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** GET /api/projects/{pid}/discover */
export interface DiscoveryResponse {
  job: DiscoveryJob | null;
  result: DiscoveryResult | null;
  /** The project's saved goals (project.json), for prefilling the field. */
  goals: string;
}

/** An audio preparation job (app/audio_jobs.py AudioJob): narrate → synthesize, running
 * server-side in a background thread. The client polls — same pattern as GraphBuildJob —
 * so a tunnel timeout or the app backgrounding can't kill a preparation in flight. */
export interface AudioJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  stage: 'narrating' | 'synthesizing';
  segments_done: number;
  segments_total: number;
  narration: string | null;
  url: string | null;
  segments: Array<{ index: number; text: string; url: string }>;
  timings: Record<string, string>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** One aggregate bucket in the usage ledger (app/usage.py). Cost is stored exactly as integer
 * nano-USD; `cost_usd` is the derived dollars figure for display. */
export interface UsageBucket {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_nanousd: number;
  cost_usd: number;
}

/** A project's LLM usage/cost aggregate (app/usage.py summary()): lifetime total plus per-model
 * and per-operation breakdowns. `estimated` is true when some billed streams dropped before
 * their final usage chunk (pending_count) or were evicted past the cap (dropped_pending), so the
 * total is a lower bound until reconciliation. */
export interface UsageSummary {
  total: UsageBucket;
  by_model: Record<string, UsageBucket>;
  by_operation: Record<string, UsageBucket>;
  pending_count: number;
  dropped_pending: number;
  estimated: boolean;
  first_at: string | null;
  updated_at: string | null;
}
