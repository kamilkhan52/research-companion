import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client';
import type { FavoriteModel, ModelOption, Paper, Project, ProjectState, ReadingMode, RecentSession } from '@/api/types';
import type { GraphResponse, GraphBuildJob } from '@/api/graph-types';
import type { Session, OpeningDraft, ReviewResponse } from '@/api/session-types';

export function listProjects(): Promise<{ projects: Project[] }> {
  return apiGet('/api/projects');
}

export function getProjectState(pid: string): Promise<ProjectState> {
  return apiGet(`/api/projects/${encodeURIComponent(pid)}/state`);
}

export function createProject(name: string): Promise<{ project: Project }> {
  return apiPost('/api/projects', { name });
}

export function getRecentSessions(limit = 20) {
  return apiGet<{ sessions: RecentSession[] }>(`/api/recent-sessions?limit=${limit}`);
}

export function getModels() { return apiGet<{ models: ModelOption[] }>('/api/models'); }
export function getFavoriteModels() { return apiGet<{ models: FavoriteModel[] }>('/api/favorite_models'); }

export function getGraph(pid: string): Promise<GraphResponse> {
  return apiGet(`/api/projects/${encodeURIComponent(pid)}/graph`);
}

export function buildGraph(
  pid: string,
  force = false,
  retrievalSources: Record<string, string> = {},
): Promise<{ build: GraphBuildJob }> {
  return apiPost(`/api/projects/${encodeURIComponent(pid)}/graph/build`, {
    force,
    retrieval_sources: retrievalSources,
  });
}

export function getGraphBuildStatus(pid: string): Promise<{ build: GraphBuildJob }> {
  return apiGet(`/api/projects/${encodeURIComponent(pid)}/graph/build/status`);
}

function P(pid: string) { return `/api/projects/${encodeURIComponent(pid)}`; }

export function getSession(pid: string, slug: string): Promise<Session> {
  return apiGet(`${P(pid)}/session/${encodeURIComponent(slug)}`);
}

export function getOpeningDraft(pid: string, slug: string): Promise<OpeningDraft> {
  return apiGet(`${P(pid)}/opening_draft/${encodeURIComponent(slug)}`);
}

export function reopen(pid: string, slug: string): Promise<{ state: string; transcript: unknown[] }> {
  return apiPost(`${P(pid)}/reopen`, { slug });
}

export function continueDiscussion(pid: string, slug: string) {
  return apiPost<{ state: string | null }>(`${P(pid)}/continue_discussion`, { slug });
}

export function setSessionMode(pid: string, slug: string, mode: ReadingMode) {
  return apiPost<{ mode: ReadingMode }>(`${P(pid)}/session_mode`, { slug, mode });
}

export function approve(pid: string, slug: string, body?: Record<string, unknown>) {
  return apiPost<{ result: unknown }>(`${P(pid)}/approve`, { slug, ...body });
}

export function getReview(pid: string, slug: string): Promise<ReviewResponse> {
  return apiGet(`${P(pid)}/review/${encodeURIComponent(slug)}`);
}

// Job-based turn endpoints — long/LLM operations run server-side, client polls.
// See CLAUDE.md invariant 1: never use connection-tied SSE for minutes-long operations.

interface DeliveryOptions { delivery_mode?: 'reading' | 'listening'; model?: string | null; }

export function startJob(pid: string, body: { slug: string; prompt?: string; mode?: ReadingMode } & DeliveryOptions) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/chat/start_job`, body);
}

export function replyJob(pid: string, body: { slug: string; text: string } & DeliveryOptions) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/reply_job`, body);
}

export function continueJob(pid: string, slug: string, options: DeliveryOptions = {}) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/continue_job`, { slug, ...options });
}

export function retryJob(pid: string, body: { slug: string; assistant_index: number } & DeliveryOptions) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/retry_job`, body);
}

export function finishJob(pid: string, slug: string, options: DeliveryOptions = {}) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/finish_job`, { slug, ...options });
}

export function requestChangesJob(pid: string, body: { slug: string; text: string } & DeliveryOptions) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/request_changes_job`, body);
}

export interface TextItem { kind: 'text'; text: string; }
export interface ToolItem { kind: 'tool'; name: string; detail: string; }
export interface ChatJob {
  id: string;
  status: 'running' | 'done' | 'error';
  turn: { role: string; canonical?: string; text?: string; state_signal?: string; proposed_commit?: unknown } | null;
  items: (TextItem | ToolItem)[];
  error: string | null;
  cancelled?: boolean;
  delivery_mode?: 'reading' | 'listening';
  assistant_index?: number | null;
  audio_job_id?: string | null;
  audio_error?: string | null;
  preview_job_ids?: string[];
  preview_complete?: boolean;
  preview_phase?: string | null;
  preview_progress?: Record<string, unknown>;
}

export function getChatJob(pid: string, jobId: string): Promise<{ job: ChatJob }> {
  return apiGet(`${P(pid)}/chat/jobs/${encodeURIComponent(jobId)}`);
}

export function getActiveChatJob(pid: string, slug: string): Promise<{ job: ChatJob | null }> {
  return apiGet(`${P(pid)}/chat/jobs/active/${encodeURIComponent(slug)}`);
}

export function cancelChatJob(pid: string, jobId: string) {
  return apiPost<{ job: ChatJob }>(`${P(pid)}/chat/jobs/${encodeURIComponent(jobId)}/cancel`, {});
}

// Paper retrieval (pre-discussion) is a background job for the same reason chat turns are:
// arXiv pacing, PDF downloads/extraction, and the fallback hunt can outlive a tunnel request.
export interface RetrievalJob {
  id: string;
  slug: string;
  status: 'running' | 'done' | 'error';
  phase: 'resolving' | 'hunting' | 'confirmation' | 'done';
  detail: string;
  items: { kind: 'tool'; name: string; detail: string }[];
  candidates: { arxiv_id: string; title: string; score: number }[];
  retrieved: boolean;
  /** The title the source reports, once resolved. Differs from the reading-list entry when the
   *  paper was added by identifier alone, which is what the title offer exists to settle. */
  matched_title?: string | null;
  error: string | null;
}

export function startRetrievalJob(pid: string, slug: string, opts?: { arxiv_id?: string; pdf_url?: string }) {
  return apiPost<{ job: RetrievalJob }>(`${P(pid)}/retrieval/jobs`, { slug, ...opts });
}

export function getRetrievalJob(pid: string, jobId: string) {
  return apiGet<{ job: RetrievalJob }>(`${P(pid)}/retrieval/jobs/${encodeURIComponent(jobId)}`);
}

export function getLatestRetrievalJob(pid: string, slug: string) {
  return apiGet<{ job: RetrievalJob | null }>(`${P(pid)}/retrieval/jobs/latest/${encodeURIComponent(slug)}`);
}

// Discovery persists completed suggestions in the project; the job is only live progress.
export interface DiscoverySuggestion {
  title: string;
  authors: string[];
  year: number | null;
  arxiv_id: string;
  relevance_score: number;
  citation_count: number | null;
  abstract: string;
}

export interface DiscoveryJob {
  status: 'running' | 'done' | 'error';
  phase: string;
  error: string | null;
}

export interface DiscoveryResult {
  goals: string;
  suggestions: DiscoverySuggestion[];
}

export function getDiscovery(pid: string) {
  return apiGet<{ job: DiscoveryJob | null; result: DiscoveryResult | null; goals: string }>(`${P(pid)}/discover`);
}

export function startDiscovery(pid: string, goals: string) {
  return apiPost<{ job: DiscoveryJob }>(`${P(pid)}/discover`, { goals });
}

export function addPaper(pid: string, title: string, arxivId?: string, abstract?: string, year?: number | null) {
  // year dates non-arXiv papers (U.17); the backend ignores it when the arXiv id already does.
  return apiPost<{ paper: Paper }>(`${P(pid)}/papers`, { title, arxiv_id: arxivId || undefined, abstract: abstract || undefined, year: year ?? undefined });
}

/** One reading-list location a candidate already occupies, as returned inside the add's
 *  `paper_exists_elsewhere` 409. Only the fields an add surface needs to name it are typed. */
export interface PaperLocation {
  slug: string;
  title: string;
  project_id: string;
  project_name: string;
  has_notes: boolean;
  has_discussion: boolean;
  retrieved: boolean;
}

/** The structured half of the cross-project duplicate refusal. */
export interface PaperExistsElsewhere {
  code: 'paper_exists_elsewhere';
  message: string;
  matches: PaperLocation[];
}

export function isPaperExistsElsewhere(detail: unknown): detail is PaperExistsElsewhere {
  return !!detail && typeof detail === 'object'
    && (detail as { code?: unknown }).code === 'paper_exists_elsewhere'
    && Array.isArray((detail as { matches?: unknown }).matches);
}

/** Apply a human-confirmed title decision. `title` renames; `titleConfirmed` records that a
 *  person has ruled, so the offer stops being made. The backend git-commits either way. */
export function updatePaper(pid: string, slug: string, title?: string, titleConfirmed = false) {
  return apiPatch<{ paper: Paper }>(`${P(pid)}/papers/${encodeURIComponent(slug)}`, {
    ...(title === undefined ? {} : { title }),
    ...(titleConfirmed ? { title_confirmed: true } : {}),
  });
}

export function removePaper(pid: string, slug: string) {
  return apiDelete<{ removed: string; notes_kept: boolean }>(`${P(pid)}/papers/${encodeURIComponent(slug)}`);
}

export interface RelatedWork {
  id: string; kind: 'project' | 'external'; slug: string | null; title: string; year: number | null;
  venue: string; arxiv_id: string | null; url: string | null; direction: 'builds_on' | 'built_on_by'; reason: string;
}
export function getRelated(pid: string, slug: string) {
  return apiGet<{ related: RelatedWork[] }>(`${P(pid)}/related/${encodeURIComponent(slug)}`);
}

// Notes edits are explicit human commits. The agent job is deliberately proposal-only until
// saveNotes is called after review.
export interface NotesJob {
  id: string;
  status: 'running' | 'done' | 'error';
  result: string | null;
  error: string | null;
}

export interface NotesData {
  target: string;
  title: string;
  markdown: string;
}

export function getNotes(pid: string, target: string) {
  return apiGet<NotesData>(`${P(pid)}/notes/${encodeURIComponent(target)}`);
}

export function saveNotes(pid: string, target: string, markdown: string) {
  return apiPost(`${P(pid)}/notes/${encodeURIComponent(target)}`, { markdown });
}

export function startNotesAgentJob(pid: string, target: string, instruction: string) {
  return apiPost<{ job: NotesJob }>(`${P(pid)}/notes/${encodeURIComponent(target)}/agent_job`, { instruction });
}

export function getNotesJob(pid: string, jobId: string) {
  return apiGet<{ job: NotesJob }>(`${P(pid)}/notes/jobs/${encodeURIComponent(jobId)}`);
}

export function getLatestNotesJob(pid: string, target: string) {
  return apiGet<{ job: NotesJob | null }>(`${P(pid)}/notes/jobs/latest/${encodeURIComponent(target)}`);
}

export interface AudioJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  stage: 'narrating' | 'synthesizing';
  segments_done: number;
  segments_total: number;
  narration: string | null;
  url: string | null;
  error: string | null;
}

export function startAudioJob(text: string, project?: string | null) {
  return apiPost<{ job: AudioJob }>('/api/audio/jobs', project ? { text, project } : { text });
}

export function getAudioJob(jobId: string) {
  return apiGet<{ job: AudioJob }>(`/api/audio/jobs/${encodeURIComponent(jobId)}`);
}

/** Cancel an in-flight preparation server-side; the worker stops paid TTS at its next
 *  checkpoint. No-op when the job already finished. */
export function cancelAudioJob(jobId: string) {
  return apiPost<{ job: AudioJob }>(`/api/audio/jobs/${encodeURIComponent(jobId)}/cancel`, {});
}
