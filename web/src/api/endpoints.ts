import { apiGet, apiPost } from '@/api/client';
import type { Project, ProjectState } from '@/api/types';

export function listProjects(): Promise<{ projects: Project[] }> {
  return apiGet('/api/projects');
}

export function getProjectState(pid: string): Promise<ProjectState> {
  return apiGet(`/api/projects/${encodeURIComponent(pid)}/state`);
}

export function createProject(name: string): Promise<{ project: Project }> {
  return apiPost('/api/projects', { name });
}
