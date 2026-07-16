// TanStack Query hooks over the typed endpoints. Query keys are namespaced by project id so
// switching projects swaps caches cleanly. Mutations invalidate the relevant queries.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';

import * as api from './endpoints';
import { getBaseUrl, subscribeBaseUrl } from './config';
import { showToast } from '@/ui/Toast';

/** Reactive base URL — re-renders consumers when it changes (e.g. saved in Settings). */
export function useBaseUrl(): string {
  return useSyncExternalStore(subscribeBaseUrl, getBaseUrl, getBaseUrl);
}

export const keys = {
  projects: ['projects'] as const,
  recentSessions: ['recentSessions'] as const,
  projectState: (pid: string) => ['project', pid, 'state'] as const,
  session: (pid: string, slug: string) => ['project', pid, 'session', slug] as const,
  opening: (pid: string, slug: string) => ['project', pid, 'opening', slug] as const,
  settings: ['settings'] as const,
  favoriteModels: ['favoriteModels'] as const,
  prompts: (pid: string | null) => ['prompts', pid ?? 'default'] as const,
  graph: (pid: string) => ['project', pid, 'graph'] as const,
  graphAuthors: (pid: string) => ['project', pid, 'graphAuthors'] as const,
  related: (pid: string, slug: string) => ['project', pid, 'related', slug] as const,
  discovery: (pid: string) => ['project', pid, 'discovery'] as const,
  notes: (pid: string, target: string) => ['project', pid, 'notes', target] as const,
  usage: (pid: string) => ['project', pid, 'usage'] as const,
  paperCover: (pid: string, slug: string) => ['project', pid, 'cover', slug] as const,
};

export function useProjects() {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: keys.projects,
    queryFn: async () => (await api.listProjects()).projects,
    enabled: hasUrl,
  });
}

export function useRecentSessions() {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: keys.recentSessions,
    queryFn: async () => (await api.getRecentSessions()).sessions,
    enabled: hasUrl,
  });
}

/** A paper's first-page cover status. Polls only while the backend is rendering (`pending`);
 *  once terminal (`ready`/`unavailable`) it settles and, being cached server-side, resolves
 *  instantly on later mounts. */
export function usePaperCover(pid: string | null, slug: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && slug ? keys.paperCover(pid, slug) : ['project', 'none', 'cover'],
    queryFn: async () => (await api.getPaperCover(pid as string, slug as string)).status,
    enabled: hasUrl && !!pid && !!slug,
    refetchInterval: (query) => (query.state.data === 'pending' ? 1500 : false),
    staleTime: 60_000,
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

export function useUsage(pid: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid ? keys.usage(pid) : ['project', 'none', 'usage'],
    queryFn: () => api.getUsage(pid as string),
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

export function usePrompts(pid: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: keys.prompts(pid),
    queryFn: async () => (await api.getPrompts(pid)).prompts,
    enabled: hasUrl,
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
    onSuccess: () => {
      showToast('Settings saved');
      qc.invalidateQueries({ queryKey: keys.settings });
    },
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

/** The ranked in-project author board (U.9). Membership is overlaid server-side so a paper
 *  added since the last build already counts; author/affiliation coverage grows per build. */
export function useGraphAuthors(pid: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid ? keys.graphAuthors(pid) : ['project', 'none', 'graphAuthors'],
    queryFn: () => api.getGraphAuthors(pid as string),
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

/** The project's discovery state: live job (if any), last persisted result, saved goals. */
export function useDiscovery(pid: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid ? keys.discovery(pid) : ['project', 'none', 'discovery'],
    queryFn: () => api.getDiscovery(pid as string),
    enabled: !!pid && hasUrl,
  });
}

/** A committed notes document — one paper's Notes block, or 'working' for the working notes. */
export function useNotes(pid: string | null, target: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && target ? keys.notes(pid, target) : ['project', 'none', 'notes'],
    queryFn: () => api.getNotes(pid as string, target as string),
    enabled: !!pid && !!target && hasUrl,
  });
}

/** Strip an arXiv version suffix and normalize case so 2303.08774v2 matches 2303.08774. */
export function normalizeArxivId(id: string | null | undefined): string | null {
  const trimmed = (id ?? '').trim().toLowerCase().replace(/v\d+$/, '');
  return trimmed || null;
}

const normalizeTitle = (title: string | null | undefined): string | null => {
  const t = (title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return t || null;
};

/** Live "is this paper already in the project?" test for every recommendation/add surface
 *  (Discover, Map recommendations, external graph nodes). Recommendation lists are snapshots
 *  from whenever their job ran; membership must instead follow the CURRENT reading list —
 *  useAddPaper invalidates project state on success, so additions are reflected here
 *  immediately and persist across list refreshes. Matches by arXiv id when both sides have
 *  one, else by normalized exact title (consistent with the deterministic title-linkifier:
 *  a false "already added" is worse than a missed one, so no fuzzy matching). */
export function useProjectMembership(pid: string | null) {
  const state = useProjectState(pid);
  return useMemo(() => {
    const byArxiv = new Set<string>();
    const byTitle = new Set<string>();
    for (const p of state.data?.papers ?? []) {
      const a = normalizeArxivId(p.arxiv_id);
      if (a) byArxiv.add(a);
      const t = normalizeTitle(p.title);
      if (t) byTitle.add(t);
    }
    const isInProject = (candidate: { arxivId?: string | null; title?: string | null }) => {
      const a = normalizeArxivId(candidate.arxivId);
      if (a && byArxiv.has(a)) return true;
      const t = normalizeTitle(candidate.title);
      return !!t && byTitle.has(t);
    };
    return { isInProject, ready: state.data != null };
  }, [state.data]);
}

export function useAddPaper(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      title,
      group,
      arxivId,
      abstract,
      year,
    }: {
      title: string;
      group?: string;
      arxivId?: string;
      abstract?: string;
      year?: number | null;
    }) => api.addPaper(pid, title, group, arxivId, abstract, year),
    onSuccess: () => {
      showToast('Added to library');
      qc.invalidateQueries({ queryKey: keys.projectState(pid) });
      qc.invalidateQueries({ queryKey: keys.graph(pid) });
      qc.invalidateQueries({ queryKey: keys.graphAuthors(pid) });  // membership → board changes
    },
  });
}

export function useRemovePaper(pid: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.removePaper(pid as string, slug),
    onSuccess: () => {
      if (!pid) return;
      qc.invalidateQueries({ queryKey: keys.projectState(pid) });
      qc.invalidateQueries({ queryKey: keys.graph(pid) });
      qc.invalidateQueries({ queryKey: keys.graphAuthors(pid) });
      qc.invalidateQueries({ queryKey: keys.projects });
      qc.invalidateQueries({ queryKey: keys.recentSessions });
    },
  });
}
