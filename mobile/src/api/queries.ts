// TanStack Query hooks over the typed endpoints. Query keys are namespaced by project id so
// switching projects swaps caches cleanly. Mutations invalidate the relevant queries.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import * as api from './endpoints';
import { hasBaseUrl } from './config';

export const keys = {
  projects: ['projects'] as const,
  projectState: (pid: string) => ['project', pid, 'state'] as const,
  session: (pid: string, slug: string) => ['project', pid, 'session', slug] as const,
  opening: (pid: string, slug: string) => ['project', pid, 'opening', slug] as const,
  settings: ['settings'] as const,
  favoriteModels: ['favoriteModels'] as const,
};

export function useProjects() {
  return useQuery({
    queryKey: keys.projects,
    queryFn: async () => (await api.listProjects()).projects,
    enabled: hasBaseUrl(),
  });
}

export function useProjectState(pid: string | null) {
  return useQuery({
    queryKey: pid ? keys.projectState(pid) : ['project', 'none', 'state'],
    queryFn: () => api.getProjectState(pid as string),
    enabled: !!pid && hasBaseUrl(),
  });
}

export function useSession(pid: string | null, slug: string | null) {
  return useQuery({
    queryKey: pid && slug ? keys.session(pid, slug) : ['project', 'none', 'session'],
    queryFn: () => api.getSession(pid as string, slug as string),
    enabled: !!pid && !!slug && hasBaseUrl(),
  });
}

export function useOpeningDraft(pid: string | null, slug: string | null) {
  return useQuery({
    queryKey: pid && slug ? keys.opening(pid, slug) : ['project', 'none', 'opening'],
    queryFn: () => api.getOpeningDraft(pid as string, slug as string),
    enabled: !!pid && !!slug && hasBaseUrl(),
  });
}

export function useSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: api.getSettings,
    enabled: hasBaseUrl(),
  });
}

export function useFavoriteModels() {
  return useQuery({
    queryKey: keys.favoriteModels,
    queryFn: async () => (await api.getFavoriteModels()).models,
    enabled: hasBaseUrl(),
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
