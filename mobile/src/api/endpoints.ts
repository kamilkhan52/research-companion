// Typed wrappers for each backend route. Project-scoped routes take the project id and build
// the /api/projects/{pid}/... path. Keep these 1:1 with app/main.py.

import { noting, scopedJob } from './planInvalidation';
import {
  apiDelete,
  apiForm,
  apiGet,
  apiPatch,
  apiPost,
  apiUrl,
  authenticatedMediaSource,
} from './client';
import type {
  AudioJob,
  AccountDeletion,
  AuthConfig,
  AuthorBoardResponse,
  AuthorProfileJob,
  ChatJob,
  ContentReportRequest,
  DiscoveryJob,
  DiscoveryResponse,
  HiddenRecommendation,
  DiscussionThreadSummary,
  FavoriteModel,
  FigureManifest,
  GraphBuildStartResponse,
  GraphBuildStatusResponse,
  GraphResponse,
  NotesDoc,
  Plan,
  NotesJob,
  RelatedWork,
  ModelOption,
  OpeningDraft,
  Paper,
  PaperMatchResponse,
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
export const getAccountDeletion = () =>
  apiGet<{ deletion: AccountDeletion | null }>('/api/account/deletion');
export const startAccountDeletion = () =>
  apiPost<{ deletion: AccountDeletion }>('/api/account/deletion', { confirmation: 'DELETE' });
export const reportContent = (body: ContentReportRequest) =>
  apiPost<{ report: { id: string; created_at: string } }>('/api/reports/content', body);
export const getHealth = () => apiGet<{ ok: boolean; title: string; dev: boolean }>('/api/health');
/** The account's plan and where it stands this period. One call, because a client that had to
 *  combine two responses would eventually render a mismatched pair. */
export const getPlan = () => apiGet<Plan>('/api/plan');
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

/** Start (or join) a background narrate→synthesize job for one message; returns immediately
 *  with the job snapshot ('done' instantly when fully cached). Poll getAudioJob until settled.
 *  `project` is the initiating project — audio is app-global (shared cache), but the narration
 *  LLM spend is billed to that project's usage ledger (unattributed if omitted). */
export const startAudioJob = (text: string, project?: string | null) =>
  apiPost<{ job: AudioJob }>('/api/audio/jobs', project ? { text, project } : { text }).then(noting((r) => r.job));
/** Poll a preparation job's live progress. Cheap; safe to call every second. */
export const getAudioJob = (id: string) =>
  apiGet<{ job: AudioJob }>(`/api/audio/jobs/${encodeURIComponent(id)}`).then(noting((r) => r.job));
/** Cancel an in-flight preparation server-side: the job flips to 'cancelled' immediately and
 *  the worker stops spending on narration/TTS at its next checkpoint. No-op when finished. */
export const cancelAudioJob = (id: string) =>
  apiPost<{ job: AudioJob }>(`/api/audio/jobs/${encodeURIComponent(id)}/cancel`, {}).then(noting((r) => r.job));

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
export interface RelocationNotesJobs {
  destination: NotesJob | null;
  source_cleanup: NotesJob | null;
  destination_error: string | null;
  source_cleanup_error: string | null;
}
export interface RelocationResult {
  new_pid: string;
  name: string;
  moved: number;
  removed: boolean;
  /** Absent when a newer mobile bundle is temporarily connected to the pre-R8.3 backend. */
  notes_jobs?: RelocationNotesJobs;
}
/** Split selected papers (and the work done on them) into a new project (R8.1). Deterministic
 *  server-side move/copy — a plain confirmed POST, not a job. */
export const splitProject = (
  pid: string,
  body: {
    name: string;
    slugs: string[];
    remove_from_source: boolean;
    goals?: string;
    draft_destination_notes: boolean;
    cleanup_source_notes: boolean;
  },
) => apiPost<RelocationResult>(
  `/api/projects/${encodeURIComponent(pid)}/split`, body,
).then(noting((r) => [r.notes_jobs?.destination, r.notes_jobs?.source_cleanup]));

/** Move (or copy) selected papers into an EXISTING project (R9.13). Same result shape as
 *  splitProject — `new_pid` is the destination, so the caller switches to it the same way. */
export const moveProject = (
  pid: string,
  body: {
    dest_pid: string;
    slugs: string[];
    remove_from_source: boolean;
    draft_destination_notes: boolean;
    cleanup_source_notes: boolean;
  },
) => apiPost<RelocationResult>(
  `/api/projects/${encodeURIComponent(pid)}/move`, body,
).then(noting((r) => [r.notes_jobs?.destination, r.notes_jobs?.source_cleanup]));

// ---------- background retrieval + auto-analysis (R7.8) ----------

/** Start (or join) connection-independent retrieval. With auto_analyze the server chains the
 *  paper summary turn onto a successful fetch — the whole flow survives the app closing. */
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
) => apiPost<{ job: RetrievalJob }>(`/api/projects/${encodeURIComponent(pid)}/retrieval/jobs`, { slug, ...opts }).then(noting((r) => r.job));
export const getRetrievalJob = (pid: string, id: string) =>
  apiGet<{ job: RetrievalJob }>(`/api/projects/${encodeURIComponent(pid)}/retrieval/jobs/${encodeURIComponent(id)}`).then(noting((r) => r.job));
export const getLatestRetrievalJob = (pid: string, slug: string) =>
  apiGet<{ job: RetrievalJob | null }>(
    `/api/projects/${encodeURIComponent(pid)}/retrieval/jobs/latest/${encodeURIComponent(slug)}`,
  ).then(noting((r) => r.job));

// ---------- per-project ----------

const P = (pid: string) => `/api/projects/${encodeURIComponent(pid)}`;

export const getProjectState = (pid: string) => apiGet<ProjectState>(`${P(pid)}/state`);
/** This project's accumulated LLM token/cost usage (lifetime total + per-model/per-operation). */
export const getUsage = (pid: string) => apiGet<UsageSummary>(`${P(pid)}/usage`);
export const getSession = (pid: string, slug: string, threadId = 'main') =>
  apiGet<Session>(
    `${P(pid)}/session/${encodeURIComponent(slug)}?thread_id=${encodeURIComponent(threadId)}`,
  );
export const getOpeningDraft = (pid: string, slug: string, threadId = 'main') =>
  apiGet<OpeningDraft>(
    `${P(pid)}/opening_draft/${encodeURIComponent(slug)}?thread_id=${encodeURIComponent(threadId)}`,
  );
export const createDiscussionThread = (pid: string, slug: string, title?: string) =>
  apiPost<{ thread: DiscussionThreadSummary; threads: DiscussionThreadSummary[] }>(
    `${P(pid)}/session/${encodeURIComponent(slug)}/threads`,
    title ? { title } : {},
  );

// NOTE: every LLM turn must go through turnJobPaths below — a blocking POST holds the
// request open for the whole generation and the tunnel kills it at ~100s (524). Only quick
// non-generating actions (approve/reopen/addPaper) may use plain apiPost.
export const reopen = (pid: string, slug: string, threadId = 'main') =>
  apiPost<{ state: string | null; transcript: unknown[] }>(
    `${P(pid)}/reopen`,
    { slug, thread_id: threadId },
  );
/** Committed -> InDiscussion: bring the composer back; nothing recorded is touched. */
export const continueDiscussion = (pid: string, slug: string, threadId = 'main') =>
  apiPost<{ state: string | null }>(
    `${P(pid)}/continue_discussion`,
    { slug, thread_id: threadId },
  );
/** Switch the session's reading mode — applies to every subsequent turn. */
export const setSessionMode = (pid: string, slug: string, mode: ReadingMode, threadId = 'main') =>
  apiPost<{ mode: ReadingMode }>(
    `${P(pid)}/session_mode`,
    { slug, mode, thread_id: threadId },
  );
export const approve = (pid: string, slug: string, body?: Record<string, unknown>) =>
  apiPost<{ result: unknown; paper: unknown }>(`${P(pid)}/approve`, { slug, ...body });
/** The proposed commit awaiting review in the notes-drafted state (notes block + synthesis). */
export const getReview = (pid: string, slug: string, threadId = 'main') =>
  apiGet<Review>(
    `${P(pid)}/review/${encodeURIComponent(slug)}?thread_id=${encodeURIComponent(threadId)}`,
  );
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
/** App-wide duplicate-awareness preflight. Read-only despite POST: the candidate can include
 *  a long title/source URL, and no project record changes until the user chooses Copy/Move. */
export const findPaperMatches = (
  pid: string,
  candidate: { title: string; arxiv_id?: string; source_url?: string },
) =>
  apiPost<PaperMatchResponse>(`${P(pid)}/paper-matches`, candidate);
/** Remove a paper from the reading list. Notes are kept server-side (with a removal marker);
 *  the backend git-commits this change — the caller must have shown a confirm first. */
export const removePaper = (pid: string, slug: string) =>
  apiDelete<{ removed: string; notes_kept: boolean }>(
    `${P(pid)}/papers/${encodeURIComponent(slug)}`,
  );
export const updatePaper = (
  pid: string,
  slug: string,
  title?: string,
  titleConfirmed = false,
) =>
  apiPatch<{ paper: Paper }>(`${P(pid)}/papers/${encodeURIComponent(slug)}`, {
    ...(title === undefined ? {} : { title }),
    ...(titleConfirmed ? { title_confirmed: true } : {}),
  });

export interface NativeUploadFile {
  uri: string;
  name: string;
  mimeType?: string | null;
}

export const uploadPaper = (pid: string, slug: string, file: NativeUploadFile) => {
  const body = new FormData();
  body.append('slug', slug);
  body.append('file', {
    uri: file.uri,
    name: file.name,
    type: file.mimeType || 'application/pdf',
  } as unknown as Blob);
  return apiForm<{ job: RetrievalJob }>(`${P(pid)}/upload_paper`, body).then(noting((r) => r.job));
};

/** Remove several papers in ONE atomic commit (the multi-select Delete). All-or-nothing, so a
 *  disconnect can't half-apply a confirmed batch; unknown slugs are skipped (idempotent). */
export const removePapersBatch = (pid: string, slugs: string[]) =>
  apiPost<{ removed: string[] }>(`${P(pid)}/papers/remove-batch`, { slugs });

// Job-based turn endpoints (used with useStreamingTurn). The POST starts (or joins) a
// server-side background job that records the turn even if this client disappears; progress
// arrives via cheap polls instead of one long-lived connection the tunnel can kill.
/** Switch the live conversation to another retry branch at a fork point (quick action, no
 *  LLM). Returns the refreshed state + transcript. 409 while a turn is generating. */
export const switchBranch = (
  pid: string,
  slug: string,
  assistantIndex: number,
  branch: number,
  threadId = 'main',
) =>
  apiPost<{ state: SessionState; transcript: TranscriptEntry[] }>(`${P(pid)}/branch_switch`, {
    slug,
    assistant_index: assistantIndex,
    branch,
    thread_id: threadId,
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
  apiGet<{ job: ChatJob }>(`${P(pid)}/chat/jobs/${encodeURIComponent(id)}`).then(noting((r) => r.job));
/** The turn job currently generating for a session, if any — for reattaching on screen entry. */
export const getActiveChatJob = (pid: string, slug: string, threadId = 'main') =>
  apiGet<{ job: ChatJob | null }>(
    `${P(pid)}/chat/jobs/active/${encodeURIComponent(slug)}?thread_id=${encodeURIComponent(threadId)}`,
  ).then(noting((r) => r.job));
/** Best-effort stop for a running turn: the partial response is recorded marked as stopped
 * and the job settles through its normal done path (keep polling; it finishes early). */
export const cancelChatJob = (pid: string, id: string) =>
  apiPost<{ job: ChatJob }>(`${P(pid)}/chat/jobs/${encodeURIComponent(id)}/cancel`, {}).then(noting((r) => r.job));
/** Poll one independently generated grounded listening cue. */
export const getPreviewJob = (pid: string, id: string) =>
  apiGet<{ job: PreviewJob }>(`${P(pid)}/preview/jobs/${encodeURIComponent(id)}`).then(noting((r) => r.job));
/** Tell later cue generations that the audio layer accepted this cue for playback. */
export const markPreviewPlayed = (pid: string, id: string) =>
  apiPost<{ job: PreviewJob }>(
    `${P(pid)}/preview/jobs/${encodeURIComponent(id)}/played`,
    {},
  ).then(noting((r) => r.job));

// ---------- committed notes (view / edit / agent-assisted edit) ----------
// target = a paper slug, or 'working' for the cross-paper working notes.

export const getNotes = (pid: string, target: string) =>
  apiGet<NotesDoc>(`${P(pid)}/notes/${encodeURIComponent(target)}`);
/** Persist a human-approved document (manual edit or applied agent proposal); git-commits. */
export const saveNotes = (
  pid: string,
  target: string,
  markdown: string,
  opts: { summary?: string; base_revision?: string; job_id?: string } = {},
) =>
  apiPost<{
    ok: boolean;
    rev: string;
    target: string;
    next_job: NotesJob | null;
    next_error: string | null;
  }>(
    `${P(pid)}/notes/${encodeURIComponent(target)}`,
    { markdown, ...opts },
  ).then(noting((r) => r.next_job));
/** Start (or join) a background agent revision from a natural-language instruction. The
 *  result is a proposal — preview it, then apply via saveNotes. Poll getNotesJob. */
export const startNotesAgent = (pid: string, target: string, instruction: string) =>
  apiPost<{ job: NotesJob }>(`${P(pid)}/notes/${encodeURIComponent(target)}/agent_job`, {
    instruction,
  }).then(noting((r) => r.job));
/** Start (or join) a notes proposal from the discussion so far (DR-043) — any time, not only
 *  at paper finish. The notes screen resumes the job and hosts the review. */
export const startNotesDiscussionUpdate = (pid: string, target: string, threadId?: string) =>
  apiPost<{ job: NotesJob }>(`${P(pid)}/notes/${encodeURIComponent(target)}/discussion_update_job`, {
    thread_id: threadId === 'main' ? undefined : threadId,
  }).then(noting((r) => r.job));
export const getNotesJob = (pid: string, id: string) =>
  apiGet<{ job: NotesJob }>(`${P(pid)}/notes/jobs/${encodeURIComponent(id)}`).then(noting((r) => r.job));
/** The notes-edit job currently running for a target, if any — for reattaching on entry. */
export const getActiveNotesJob = (pid: string, target: string) =>
  apiGet<{ job: NotesJob | null }>(`${P(pid)}/notes/jobs/active/${encodeURIComponent(target)}`).then(noting((r) => r.job));
/** Latest retained proposal for re-entry, including a job that completed while away. */
export const getLatestNotesJob = (pid: string, target: string) =>
  apiGet<{ job: NotesJob | null }>(`${P(pid)}/notes/jobs/latest/${encodeURIComponent(target)}`).then(noting((r) => r.job));
export const discardNotesJob = (pid: string, id: string) =>
  apiPost<{ ok: boolean; next_job: NotesJob | null; next_error: string | null }>(
    `${P(pid)}/notes/jobs/${encodeURIComponent(id)}/discard`,
    {},
  ).then(noting((r) => r.next_job));

// ---------- discovery (goals -> suggested readings) ----------

/** Start (or join) a background discovery run for the project's goals. Returns immediately
 *  with the job snapshot; the run keeps going regardless of the client. Poll getDiscovery. */
export const startDiscovery = (pid: string, goals: string) =>
  apiPost<{ job: DiscoveryJob }>(`${P(pid)}/discover`, { goals }).then(noting((r) => scopedJob(`discovery:${pid}`, r.job)));
/** Live job snapshot + the last persisted result + saved goals. Cheap; safe every ~1.5s. */
export const getDiscovery = (pid: string) =>
  apiGet<DiscoveryResponse>(`${P(pid)}/discover`).then(noting((r) => scopedJob(`discovery:${pid}`, r.job)));
/** Cooperatively stop the current run. The last completed result is preserved server-side;
 *  the returned cancelled snapshot retains any live finds already gathered. */
export const cancelDiscovery = (pid: string) =>
  apiPost<{ job: DiscoveryJob }>(`${P(pid)}/discover/cancel`, {}).then(noting((r) => scopedJob(`discovery:${pid}`, r.job)));
/** Hide one recommended paper from every recommendation surface (R12.3). Send the rendered
 *  suggestion; the server derives all its identities (arXiv/DOI/S2/title). */
export const hideSuggestion = (pid: string, candidate: object) =>
  apiPost<{ hidden: HiddenRecommendation }>(`${P(pid)}/discover/hide`, { candidate });
/** Undo a hide by any of its identity keys. */
export const unhideSuggestion = (pid: string, keys: string[]) =>
  apiPost<{ removed: boolean }>(`${P(pid)}/discover/unhide`, { keys });

// ---------- reference graph ----------

export const getGraph = (pid: string) =>
  apiGet<GraphResponse>(`${P(pid)}/graph`).then(noting((r) => scopedJob(`graph-build:${pid}`, r.build)));
export const getGraphAuthors = (pid: string) =>
  apiGet<AuthorBoardResponse>(`${P(pid)}/graph/authors`).then(noting((r) => r.labs_job));
/** Start (or join) the agentic lab pass over the project's top authors (R7.7). */
export const startLabsResearch = (pid: string) =>
  apiPost<{ job: LabsResearchJob }>(`${P(pid)}/graph/labs/research`, {}).then(noting((r) => r.job));
export const getLabsResearchJob = (pid: string, id: string) =>
  apiGet<{ job: LabsResearchJob }>(`${P(pid)}/graph/labs/research/jobs/${encodeURIComponent(id)}`).then(noting((r) => r.job));
/** Start (or join) one board author's profile generation (LLM ⇒ background job; cached). */
export const startAuthorProfile = (pid: string, name: string) =>
  apiPost<{ job: AuthorProfileJob }>(`${P(pid)}/graph/authors/profile/job`, { name }).then(noting((r) => r.job));
export const getAuthorProfileJob = (pid: string, id: string) =>
  apiGet<{ job: AuthorProfileJob }>(`${P(pid)}/graph/authors/profile/jobs/${encodeURIComponent(id)}`).then(noting((r) => r.job));
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
}).then(noting((r) => scopedJob(`graph-build:${pid}`, r.build)));
/** Poll for the current/most-recent build job's progress. Cheap; safe to call every ~1.5s. */
export const getGraphBuildStatus = (pid: string) =>
  apiGet<GraphBuildStatusResponse>(`${P(pid)}/graph/build/status`).then(noting((r) => scopedJob(`graph-build:${pid}`, r.build)));

/** Kick a one-shot, server-deduped pass that renders covers for every retrieved-but-coverless
 *  paper across all projects, so pre-existing papers don't render on-demand when first shown.
 *  Fire-and-forget; safe to call repeatedly (cheap stat scan once everything is covered). */
export const backfillCovers = () =>
  apiPost<{ status: string }>('/api/covers/backfill', {});

/** Render status for a paper's first-page cover image. `pending` -> poll again; `ready` ->
 *  load paperCoverImageSource; `unavailable` -> no fetchable PDF (fall back to an icon). */
export const getPaperCover = (pid: string, slug: string) =>
  apiGet<{ status: 'ready' | 'pending' | 'unavailable' }>(
    `${P(pid)}/papers/${encodeURIComponent(slug)}/cover`,
  );

/** Header-authenticated image source for a paper's cached cover PNG. Only meaningful once
 *  getPaperCover reports `ready`; 404s before then. */
export const paperCoverImageSource = (pid: string, slug: string) =>
  authenticatedMediaSource(`${P(pid)}/papers/${encodeURIComponent(slug)}/cover.png`);

// ---------- paper figures (R.10) ----------

/** The paper's arXiv-HTML figure manifest. `status: 'none'` (no HTML rendering, or not
 *  derived yet) means render exactly as before figures existed — no cards. Cheap; derivation
 *  happens server-side in the retrieval warm / graph enrichment, this only reads the cache. */
export const getPaperFigures = (pid: string, slug: string) =>
  apiGet<FigureManifest>(`${P(pid)}/papers/${encodeURIComponent(slug)}/figures`);

/** Header-authenticated source for one cached figure image. `version` is the manifest's
 *  fetched_ts — appended only as a non-secret cache-busting query parameter. */
export const figureAssetSource = (
  pid: string,
  slug: string,
  asset: string,
  version?: number | null,
) => {
  const versionQuery = version ? `?v=${version}` : '';
  return authenticatedMediaSource(
    `${P(pid)}/papers/${encodeURIComponent(slug)}/figures/${encodeURIComponent(asset)}${versionQuery}`,
  );
};
