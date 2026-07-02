// Typed wrappers for each backend route. Project-scoped routes take the project id and build
// the /api/projects/{pid}/... path. Keep these 1:1 with app/main.py.

import { apiGet, apiPost, authHeaders, apiUrl } from './client';
import type {
  AuthConfig,
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
  Turn,
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

// Non-streaming turn endpoints (the *_stream variants live in stream usage in screens).
export const reply = (pid: string, slug: string, text: string) =>
  apiPost<{ state: string | null; turn: Turn }>(`${P(pid)}/reply`, { slug, text });
export const finish = (pid: string, slug: string) =>
  apiPost<{ state: string | null; turn: Turn }>(`${P(pid)}/finish`, { slug });
export const requestChanges = (pid: string, slug: string, text: string) =>
  apiPost<{ state: string | null; turn: Turn }>(`${P(pid)}/request_changes`, { slug, text });
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
