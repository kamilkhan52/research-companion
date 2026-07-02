// TanStack Query hooks over the typed endpoints. Query keys are namespaced by project id so
// switching projects swaps caches cleanly. Mutations invalidate the relevant queries.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import * as api from './endpoints';
import { getBaseUrl, subscribeBaseUrl } from './config';

/** Reactive base URL — re-renders consumers when it changes (e.g. saved in Settings). */
export function useBaseUrl(): string {
  return useSyncExternalStore(subscribeBaseUrl, getBaseUrl, getBaseUrl);
}

export const keys = {
  projects: ['projects'] as const,
  projectState: (pid: string) => ['project', pid, 'state'] as const,
  session: (pid: string, slug: string) => ['project', pid, 'session', slug] as const,
  opening: (pid: string, slug: string) => ['project', pid, 'opening', slug] as const,
  settings: ['settings'] as const,
  favoriteModels: ['favoriteModels'] as const,
  graph: (pid: string) => ['project', pid, 'graph'] as const,
  related: (pid: string, slug: string) => ['project', pid, 'related', slug] as const,
};

export function useProjects() {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: keys.projects,
    queryFn: async () => (await api.listProjects()).projects,
    enabled: hasUrl,
  });
}

export function useProjectState(pid: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid ? keys.projectState(pid) : ['project', 'none', 'state'],
    queryFn: () => api.getProjectState(pid as string),
    enabled: !!pid && hasUrl,
  });
}

export function useSession(pid: string | null, slug: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && slug ? keys.session(pid, slug) : ['project', 'none', 'session'],
    queryFn: () => api.getSession(pid as string, slug as string),
    enabled: !!pid && !!slug && hasUrl,
  });
}

export function useOpeningDraft(pid: string | null, slug: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && slug ? keys.opening(pid, slug) : ['project', 'none', 'opening'],
    queryFn: () => api.getOpeningDraft(pid as string, slug as string),
    enabled: !!pid && !!slug && hasUrl,
  });
}

export function useSettings() {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: keys.settings,
    queryFn: api.getSettings,
    enabled: hasUrl,
  });
}

export function useFavoriteModels() {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: keys.favoriteModels,
    queryFn: async () => (await api.getFavoriteModels()).models,
    enabled: hasUrl,
    staleTime: 5 * 60_000,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, method }: { name: string; method?: string }) =>
      api.createProject(name, method),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.saveSettings(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.settings }),
  });
}

export function useGraph(pid: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid ? keys.graph(pid) : ['project', 'none', 'graph'],
    queryFn: () => api.getGraph(pid as string),
    enabled: !!pid && hasUrl,
  });
}

/** A paper's most significant related works (the session's 'Related works' menu). `enabled`
 *  lets the screen defer the fetch until the menu is opened. */
export function useRelatedWorks(pid: string | null, slug: string | null, enabled = true) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && slug ? keys.related(pid, slug) : ['project', 'none', 'related'],
    queryFn: async () => (await api.getRelated(pid as string, slug as string)).related,
    enabled: !!pid && !!slug && hasUrl && enabled,
  });
}

export function useAddPaper(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ title, group, arxivId }: { title: string; group?: string; arxivId?: string }) =>
      api.addPaper(pid, title, group, arxivId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.projectState(pid) });
      qc.invalidateQueries({ queryKey: keys.graph(pid) });
    },
  });
}
