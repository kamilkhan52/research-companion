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

export function streamPost(pid: string, path: string, body: unknown): Promise<Response> {
  const t = localStorage.getItem('rc_token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (t) headers['Authorization'] = `Bearer ${t}`;
  return fetch(`${P(pid)}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}
