// Typed wrappers for each backend route. Project-scoped routes take the project id and build
// the /api/projects/{pid}/... path. Keep these 1:1 with app/main.py.

import { apiDelete, apiGet, apiPatch, apiPost, authHeaders, apiUrl } from './client';
import type {
  AudioJob,
  AuthConfig,
  AuthorBoardResponse,
  AuthorProfileJob,
  ChatJob,
  DiscoveryJob,
  DiscoveryResponse,
  FavoriteModel,
  GraphBuildStartResponse,
  GraphBuildStatusResponse,
  GraphResponse,
  NotesDoc,
  NotesJob,
  RelatedWork,
  ModelOption,
  OpeningDraft,
  Paper,
  Review,
  PromptStatus,
  Project,
  ProjectState,
  LabsResearchJob,
  ReadingMode,
  RecentSession,
  RetrievalJob,
  PreviewJob,
  Session,
  SessionState,
  Settings,
  TranscriptEntry,
  UsageSummary,
} from './types';

// ---------- global ----------

export const getAuthConfig = () => apiGet<AuthConfig>('/api/auth/config');
export const getHealth = () => apiGet<{ ok: boolean; title: string; dev: boolean }>('/api/health');
export const getSettings = () => apiGet<Settings>('/api/settings');
export const saveSettings = (body: Partial<Settings> & Record<string, unknown>) =>
  apiPost<Settings>('/api/settings', body);
export const getModels = () => apiGet<{ models: ModelOption[] }>('/api/models');
export const getFavoriteModels = () => apiGet<{ models: FavoriteModel[] }>('/api/favorite_models');
export const getPrompts = (project?: string | null) =>
  apiGet<{ prompts: PromptStatus[] }>(
    project ? `/api/prompts?project=${encodeURIComponent(project)}` : '/api/prompts',
  );
/** Override a workflow prompt (global superuser surface; the mobile UI gates this to RC_DEV). */
export const savePrompt = (key: string, value: string) =>
  apiPost<{ key: string; value: string; is_overridden: boolean }>('/api/prompts', { key, value });
/** Drop a prompt's override, reverting to the bundled/file default. */
export const resetPrompt = (key: string) =>
  apiPost<{ key: string; value: string; is_overridden: boolean }>('/api/prompts/reset', { key });

/** Synthesize a passage to mp3; returns a relative URL under /api/audio. */
export const speak = (text: string) => apiPost<{ url: string }>('/api/speak', { text });
/** Stage-2 narration: adapt canonical text into a spoken transcript (cached server-side). */
export const narrate = (text: string) =>
  apiPost<{ narration: string; cached: boolean }>('/api/narrate', { text });
/** Start (or join) a background narrate→synthesize job for one message; returns immediately
 *  with the job snapshot ('done' instantly when fully cached). Poll getAudioJob until settled.
 *  `project` is the initiating project — audio is app-global (shared cache), but the narration
 *  LLM spend is billed to that project's usage ledger (unattributed if omitted). */
export const startAudioJob = (text: string, project?: string | null) =>
  apiPost<{ job: AudioJob }>('/api/audio/jobs', project ? { text, project } : { text });
/** Poll a preparation job's live progress. Cheap; safe to call every second. */
export const getAudioJob = (id: string) =>
  apiGet<{ job: AudioJob }>(`/api/audio/jobs/${encodeURIComponent(id)}`);
/** Cancel an in-flight preparation server-side: the job flips to 'cancelled' immediately and
 *  the worker stops spending on narration/TTS at its next checkpoint. No-op when finished. */
export const cancelAudioJob = (id: string) =>
  apiPost<{ job: AudioJob }>(`/api/audio/jobs/${encodeURIComponent(id)}/cancel`, {});

// ---------- projects (management) ----------

export const listProjects = () => apiGet<{ projects: Project[] }>('/api/projects');
export const getRecentSessions = (limit = 20) =>
  apiGet<{ sessions: RecentSession[] }>(`/api/recent-sessions?limit=${limit}`);
export const createProject = (name: string, method?: string) =>
  apiPost<{ project: Project }>('/api/projects', { name, method });
export const updateProjectMeta = (pid: string, patch: { name?: string; favorite?: boolean }) =>
  apiPatch<{ project: { id: string; name: string; favorite?: boolean } }>(
    `/api/projects/${encodeURIComponent(pid)}/meta`, patch);
/** Soft delete — the server moves the project into a recoverable .trash dir. */
export const deleteProject = (pid: string) =>
  apiDelete<{ ok: boolean }>(`/api/projects/${encodeURIComponent(pid)}`);

// ---------- background retrieval + auto-analysis (R7.8) ----------

/** Start (or join) connection-independent retrieval. With auto_analyze the server chains the
 *  first analysis turn onto a successful fetch — the whole flow survives the app closing. */
export const startRetrievalJob = (
  pid: string,
  slug: string,
  opts: {
    arxiv_id?: string;
    pdf_url?: string;
    auto_analyze?: boolean;
    mode?: ReadingMode;
    delivery_mode?: 'reading' | 'listening';
  } = {},
) => apiPost<{ job: RetrievalJob }>(`/api/projects/${encodeURIComponent(pid)}/retrieval/jobs`, { slug, ...opts });
export const getRetrievalJob = (pid: string, id: string) =>
  apiGet<{ job: RetrievalJob }>(`/api/projects/${encodeURIComponent(pid)}/retrieval/jobs/${encodeURIComponent(id)}`);

// ---------- per-project ----------

const P = (pid: string) => `/api/projects/${encodeURIComponent(pid)}`;

export const getProjectState = (pid: string) => apiGet<ProjectState>(`${P(pid)}/state`);
/** This project's accumulated LLM token/cost usage (lifetime total + per-model/per-operation). */
export const getUsage = (pid: string) => apiGet<UsageSummary>(`${P(pid)}/usage`);
export const getSession = (pid: string, slug: string) =>
  apiGet<Session>(`${P(pid)}/session/${encodeURIComponent(slug)}`);
export const getOpeningDraft = (pid: string, slug: string) =>
  apiGet<OpeningDraft>(`${P(pid)}/opening_draft/${encodeURIComponent(slug)}`);

/** Retrieve + cache a paper's full text (no turn). Returns {ok,retrieved} or a confirm step. */
export const startPaper = (pid: string, slug: string, opts?: { arxiv_id?: string; pdf_url?: string }) =>
  apiPost<{ ok?: boolean; retrieved?: boolean; needs_confirmation?: boolean; candidates?: unknown[] }>(
    `${P(pid)}/start`,
    { slug, ...opts },
  );

// NOTE: every LLM turn must go through turnJobPaths below — a blocking POST holds the
// request open for the whole generation and the tunnel kills it at ~100s (524). Only quick
// non-generating actions (approve/reopen/addPaper) may use plain apiPost.
export const reopen = (pid: string, slug: string) =>
  apiPost<{ state: string | null; transcript: unknown[] }>(`${P(pid)}/reopen`, { slug });
/** Committed -> InDiscussion: bring the composer back; nothing recorded is touched. */
export const continueDiscussion = (pid: string, slug: string) =>
  apiPost<{ state: string | null }>(`${P(pid)}/continue_discussion`, { slug });
/** Switch the session's reading mode — applies to every subsequent turn. */
export const setSessionMode = (pid: string, slug: string, mode: ReadingMode) =>
  apiPost<{ mode: ReadingMode }>(`${P(pid)}/session_mode`, { slug, mode });
export const approve = (pid: string, slug: string, body?: Record<string, unknown>) =>
  apiPost<{ result: unknown; paper: unknown }>(`${P(pid)}/approve`, { slug, ...body });
/** The proposed commit awaiting review in the notes-drafted state (notes block + synthesis). */
export const getReview = (pid: string, slug: string) =>
  apiGet<Review>(`${P(pid)}/review/${encodeURIComponent(slug)}`);
/** Add a new *unread* entry to the reading list — e.g. accepting a graph recommendation.
 *  Pass the abstract when the caller has one: it is what an unread paper contributes to a
 *  discussion's context until someone reads it. */
export const addPaper = (
  pid: string,
  title: string,
  group?: string,
  arxiv_id?: string,
  abstract?: string,
  year?: number | null,
) =>
  apiPost<{ paper: Paper }>(`${P(pid)}/papers`, {
    title,
    group,
    arxiv_id,
    abstract,
    // Dates non-arXiv papers (U.17); the backend ignores it when the arXiv id already does.
    year: year ?? undefined,
  });
/** Remove a paper from the reading list. Notes are kept server-side (with a removal marker);
 *  the backend git-commits this change — the caller must have shown a confirm first. */
export const removePaper = (pid: string, slug: string) =>
  apiDelete<{ removed: string; notes_kept: boolean }>(
    `${P(pid)}/papers/${encodeURIComponent(slug)}`,
  );

// Stream endpoint paths (used with streamPost from stream.ts).
export const streamPaths = (pid: string) => ({
  chatStart: `${P(pid)}/chat/start_stream`,
  paperStart: `${P(pid)}/start_stream`,
  reply: `${P(pid)}/reply_stream`,
  continue: `${P(pid)}/continue_stream`,
  retry: `${P(pid)}/retry_stream`,
  edit: `${P(pid)}/edit_stream`,
  finish: `${P(pid)}/finish_stream`,
});

// Job-based turn endpoints (used with useStreamingTurn). The POST starts (or joins) a
// server-side background job that records the turn even if this client disappears; progress
// arrives via cheap polls instead of one long-lived connection the tunnel can kill.
/** Switch the live conversation to another retry branch at a fork point (quick action, no
 *  LLM). Returns the refreshed state + transcript. 409 while a turn is generating. */
export const switchBranch = (pid: string, slug: string, assistantIndex: number, branch: number) =>
  apiPost<{ state: SessionState; transcript: TranscriptEntry[] }>(`${P(pid)}/branch_switch`, {
    slug,
    assistant_index: assistantIndex,
    branch,
  });

export const turnJobPaths = (pid: string) => ({
  chatStart: `${P(pid)}/chat/start_job`,
  reply: `${P(pid)}/reply_job`,
  continue: `${P(pid)}/continue_job`,
  retry: `${P(pid)}/retry_job`,
  edit: `${P(pid)}/edit_job`,
  finish: `${P(pid)}/finish_job`,
  requestChanges: `${P(pid)}/request_changes_job`,
});
/** Poll a turn job's live snapshot (interleaved text/tool items). Cheap; safe every ~1s. */
export const getChatJob = (pid: string, id: string) =>
  apiGet<{ job: ChatJob }>(`${P(pid)}/chat/jobs/${encodeURIComponent(id)}`);
/** The turn job currently generating for a session, if any — for reattaching on screen entry. */
export const getActiveChatJob = (pid: string, slug: string) =>
  apiGet<{ job: ChatJob | null }>(`${P(pid)}/chat/jobs/active/${encodeURIComponent(slug)}`);
/** Best-effort stop for a running turn: the partial response is recorded marked as stopped
 * and the job settles through its normal done path (keep polling; it finishes early). */
export const cancelChatJob = (pid: string, id: string) =>
  apiPost<{ job: ChatJob }>(`${P(pid)}/chat/jobs/${encodeURIComponent(id)}/cancel`, {});
/** Poll one independently generated grounded listening cue. */
export const getPreviewJob = (pid: string, id: string) =>
  apiGet<{ job: PreviewJob }>(`${P(pid)}/preview/jobs/${encodeURIComponent(id)}`);

// ---------- committed notes (view / edit / agent-assisted edit) ----------
// target = a paper slug, or 'working' for the cross-paper working notes.

export const getNotes = (pid: string, target: string) =>
  apiGet<NotesDoc>(`${P(pid)}/notes/${encodeURIComponent(target)}`);
/** Persist a human-approved document (manual edit or applied agent proposal); git-commits. */
export const saveNotes = (pid: string, target: string, markdown: string, summary?: string) =>
  apiPost<{ ok: boolean; rev: string; target: string }>(
    `${P(pid)}/notes/${encodeURIComponent(target)}`,
    { markdown, summary },
  );
/** Start (or join) a background agent revision from a natural-language instruction. The
 *  result is a proposal — preview it, then apply via saveNotes. Poll getNotesJob. */
export const startNotesAgent = (pid: string, target: string, instruction: string) =>
  apiPost<{ job: NotesJob }>(`${P(pid)}/notes/${encodeURIComponent(target)}/agent_job`, {
    instruction,
  });
export const getNotesJob = (pid: string, id: string) =>
  apiGet<{ job: NotesJob }>(`${P(pid)}/notes/jobs/${encodeURIComponent(id)}`);
/** The notes-edit job currently running for a target, if any — for reattaching on entry. */
export const getActiveNotesJob = (pid: string, target: string) =>
  apiGet<{ job: NotesJob | null }>(`${P(pid)}/notes/jobs/active/${encodeURIComponent(target)}`);

// ---------- discovery (goals -> suggested readings) ----------

/** Start (or join) a background discovery run for the project's goals. Returns immediately
 *  with the job snapshot; the run keeps going regardless of the client. Poll getDiscovery. */
export const startDiscovery = (pid: string, goals: string) =>
  apiPost<{ job: DiscoveryJob }>(`${P(pid)}/discover`, { goals });
/** Live job snapshot + the last persisted result + saved goals. Cheap; safe every ~1.5s. */
export const getDiscovery = (pid: string) => apiGet<DiscoveryResponse>(`${P(pid)}/discover`);

// ---------- reference graph ----------

export const getGraph = (pid: string) => apiGet<GraphResponse>(`${P(pid)}/graph`);
export const getGraphAuthors = (pid: string) =>
  apiGet<AuthorBoardResponse>(`${P(pid)}/graph/authors`);
/** Start (or join) the agentic lab pass over the project's top authors (R7.7). */
export const startLabsResearch = (pid: string) =>
  apiPost<{ job: LabsResearchJob }>(`${P(pid)}/graph/labs/research`, {});
export const getLabsResearchJob = (pid: string, id: string) =>
  apiGet<{ job: LabsResearchJob }>(`${P(pid)}/graph/labs/research/jobs/${encodeURIComponent(id)}`);
/** Start (or join) one board author's profile generation (LLM ⇒ background job; cached). */
export const startAuthorProfile = (pid: string, name: string) =>
  apiPost<{ job: AuthorProfileJob }>(`${P(pid)}/graph/authors/profile/job`, { name });
export const getAuthorProfileJob = (pid: string, id: string) =>
  apiGet<{ job: AuthorProfileJob }>(`${P(pid)}/graph/authors/profile/jobs/${encodeURIComponent(id)}`);
export const getRelated = (pid: string, slug: string) =>
  apiGet<{ related: RelatedWork[] }>(`${P(pid)}/related/${encodeURIComponent(slug)}`);
/** Start (or join) a server-side background build. Returns immediately with the job snapshot;
 *  the build keeps running regardless of what the client does. Poll getGraphBuildStatus. */
export const startGraphBuild = (
  pid: string,
  force = false,
  retrievalSources: Record<string, string> = {},
) => apiPost<GraphBuildStartResponse>(`${P(pid)}/graph/build`, {
  force,
  retrieval_sources: retrievalSources,
});
/** Poll for the current/most-recent build job's progress. Cheap; safe to call every ~1.5s. */
export const getGraphBuildStatus = (pid: string) =>
  apiGet<GraphBuildStatusResponse>(`${P(pid)}/graph/build/status`);

/** Kick a one-shot, server-deduped pass that renders covers for every retrieved-but-coverless
 *  paper across all projects, so pre-existing papers don't render on-demand when first shown.
 *  Fire-and-forget; safe to call repeatedly (cheap stat scan once everything is covered). */
export const backfillCovers = () =>
  apiPost<{ status: string }>('/api/covers/backfill', {});

/** Render status for a paper's first-page cover image. `pending` -> poll again; `ready` ->
 *  load paperCoverImageUrl; `unavailable` -> no fetchable PDF (fall back to an icon). */
export const getPaperCover = (pid: string, slug: string) =>
  apiGet<{ status: 'ready' | 'pending' | 'unavailable' }>(
    `${P(pid)}/papers/${encodeURIComponent(slug)}/cover`,
  );

/** Absolute, ?token-authed URL for a paper's cached cover PNG (for <Image>). Only meaningful
 *  once getPaperCover reports `ready`; 404s before then. */
export const paperCoverImageUrl = (pid: string, slug: string): string =>
  mediaUrl(`${P(pid)}/papers/${encodeURIComponent(slug)}/cover.png`);

/** Absolute URL for a media path (relative like "/api/audio/<hash>.mp3"), with ?token for
 *  the audio player which can't send an Authorization header. */
export function mediaUrl(relativePath: string): string {
  const url = apiUrl(relativePath);
  const auth = authHeaders();
  const token = auth.Authorization?.replace(/^Bearer\s+/i, '');
  return token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url;
}
