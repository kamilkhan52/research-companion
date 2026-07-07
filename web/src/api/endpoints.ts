import { apiGet, apiPost } from '@/api/client';
import type { Project, ProjectState } from '@/api/types';
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

export function getGraph(pid: string): Promise<GraphResponse> {
  return apiGet(`/api/projects/${encodeURIComponent(pid)}/graph`);
}

export function buildGraph(pid: string): Promise<{ build: GraphBuildJob }> {
  return apiPost(`/api/projects/${encodeURIComponent(pid)}/graph/build`, {});
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

export function approve(pid: string, slug: string, body?: Record<string, unknown>) {
  return apiPost<{ result: unknown }>(`${P(pid)}/approve`, { slug, ...body });
}

export function getReview(pid: string, slug: string): Promise<ReviewResponse> {
  return apiGet(`${P(pid)}/review/${encodeURIComponent(slug)}`);
}

// Job-based turn endpoints — long/LLM operations run server-side, client polls.
// See CLAUDE.md invariant 1: never use connection-tied SSE for minutes-long operations.

export function startJob(pid: string, body: { slug: string; prompt?: string; model?: string }) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/chat/start_job`, body);
}

export function replyJob(pid: string, body: { slug: string; text: string }) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/reply_job`, body);
}

export function continueJob(pid: string, slug: string) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/continue_job`, { slug });
}

export function retryJob(pid: string, body: { slug: string; assistant_index: number; model?: string | null }) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/retry_job`, body);
}

export function finishJob(pid: string, slug: string) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/finish_job`, { slug });
}

export function requestChangesJob(pid: string, body: { slug: string; text: string }) {
  return apiPost<{ job: { id: string } }>(`${P(pid)}/request_changes_job`, body);
}

export interface TextItem { type: 'text'; text: string; }
export interface ChatJob {
  id: string;
  status: 'running' | 'done' | 'error';
  turn: { role: string; canonical?: string; text?: string; state_signal?: string; proposed_commit?: unknown } | null;
  items: TextItem[];
  error: string | null;
}

export function getChatJob(pid: string, jobId: string): Promise<{ job: ChatJob }> {
  return apiGet(`${P(pid)}/chat/jobs/${encodeURIComponent(jobId)}`);
}

export function getActiveChatJob(pid: string, slug: string): Promise<{ job: ChatJob | null }> {
  return apiGet(`${P(pid)}/chat/jobs/active/${encodeURIComponent(slug)}`);
}

// Paper retrieval (pre-discussion)
export function startPaper(pid: string, slug: string, opts?: { arxiv_id?: string; pdf_url?: string }) {
  return apiPost<{ ok?: boolean; retrieved?: boolean; needs_confirmation?: boolean; candidates?: { arxiv_id: string; title: string; score: number }[] }>(
    `${P(pid)}/start`, { slug, ...opts },
  );
}
