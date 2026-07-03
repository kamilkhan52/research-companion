// Typed wrappers for each backend route. Project-scoped routes take the project id and build
// the /api/projects/{pid}/... path. Keep these 1:1 with app/main.py.

import { apiGet, apiPost, authHeaders, apiUrl } from './client';
import type {
  AudioJob,
  AuthConfig,
  ChatJob,
  FavoriteModel,
  GraphBuildStartResponse,
  GraphBuildStatusResponse,
  GraphResponse,
  RelatedWork,
  ModelOption,
  OpeningDraft,
  Paper,
  Project,
  ProjectState,
  Session,
  Settings,
} from './types';

// ---------- global ----------

export const getAuthConfig = () => apiGet<AuthConfig>('/api/auth/config');
export const getSettings = () => apiGet<Settings>('/api/settings');
export const saveSettings = (body: Partial<Settings> & Record<string, unknown>) =>
  apiPost<Settings>('/api/settings', body);
export const getModels = () => apiGet<{ models: ModelOption[] }>('/api/models');
export const getFavoriteModels = () => apiGet<{ models: FavoriteModel[] }>('/api/favorite_models');

/** Synthesize a passage to mp3; returns a relative URL under /api/audio. */
export const speak = (text: string) => apiPost<{ url: string }>('/api/speak', { text });
/** Stage-2 narration: adapt canonical text into a spoken transcript (cached server-side). */
export const narrate = (text: string) =>
  apiPost<{ narration: string; cached: boolean }>('/api/narrate', { text });
/** Start (or join) a background narrate→synthesize job for one message; returns immediately
 *  with the job snapshot ('done' instantly when fully cached). Poll getAudioJob until settled. */
export const startAudioJob = (text: string) =>
  apiPost<{ job: AudioJob }>('/api/audio/jobs', { text });
/** Poll a preparation job's live progress. Cheap; safe to call every second. */
export const getAudioJob = (id: string) =>
  apiGet<{ job: AudioJob }>(`/api/audio/jobs/${encodeURIComponent(id)}`);

// ---------- projects (management) ----------

export const listProjects = () => apiGet<{ projects: Project[] }>('/api/projects');
export const createProject = (name: string, method?: string) =>
  apiPost<{ project: Project }>('/api/projects', { name, method });

// ---------- per-project ----------

const P = (pid: string) => `/api/projects/${encodeURIComponent(pid)}`;

export const getProjectState = (pid: string) => apiGet<ProjectState>(`${P(pid)}/state`);
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
export const approve = (pid: string, slug: string, body?: Record<string, unknown>) =>
  apiPost<{ result: unknown; paper: unknown }>(`${P(pid)}/approve`, { slug, ...body });
/** Add a new *unread* entry to the reading list — e.g. accepting a graph recommendation. */
export const addPaper = (pid: string, title: string, group?: string, arxiv_id?: string) =>
  apiPost<{ paper: Paper }>(`${P(pid)}/papers`, { title, group, arxiv_id });

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

// ---------- reference graph ----------

export const getGraph = (pid: string) => apiGet<GraphResponse>(`${P(pid)}/graph`);
export const getRelated = (pid: string, slug: string) =>
  apiGet<{ related: RelatedWork[] }>(`${P(pid)}/related/${encodeURIComponent(slug)}`);
/** Start (or join) a server-side background build. Returns immediately with the job snapshot;
 *  the build keeps running regardless of what the client does. Poll getGraphBuildStatus. */
export const startGraphBuild = (pid: string, force = false) =>
  apiPost<GraphBuildStartResponse>(`${P(pid)}/graph/build`, { force });
/** Poll for the current/most-recent build job's progress. Cheap; safe to call every ~1.5s. */
export const getGraphBuildStatus = (pid: string) =>
  apiGet<GraphBuildStatusResponse>(`${P(pid)}/graph/build/status`);

/** Absolute URL for a media path (relative like "/api/audio/<hash>.mp3"), with ?token for
 *  the audio player which can't send an Authorization header. */
export function mediaUrl(relativePath: string): string {
  const url = apiUrl(relativePath);
  const auth = authHeaders();
  const token = auth.Authorization?.replace(/^Bearer\s+/i, '');
  return token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url;
}
