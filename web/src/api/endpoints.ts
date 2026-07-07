import { apiGet, apiPost } from '@/api/client';
import type { Project, ProjectState } from '@/api/types';
import type { GraphResponse, GraphBuildJob } from '@/api/graph-types';

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
