// TanStack Query hooks over the typed endpoints. Query keys are namespaced by project id so
// switching projects swaps caches cleanly. Mutations invalidate the relevant queries.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';

import * as api from './endpoints';
import { getBaseUrl, subscribeBaseUrl } from './config';
import { ApiError } from './client';
import type { Project } from './types';
import {
  requestExistingPaperReuse,
  type AddPaperOutcome,
} from '@/components/ExistingPaperOffer';
import { offerPaperSummary } from '@/components/PaperSummaryOffer';
import { showToast } from '@/ui/Toast';

/** Reactive base URL — re-renders consumers when it changes (e.g. saved in Settings). */
export function useBaseUrl(): string {
  return useSyncExternalStore(subscribeBaseUrl, getBaseUrl, getBaseUrl);
}

export const keys = {
  health: ['health'] as const,
  projects: ['projects'] as const,
  recentSessions: ['recentSessions'] as const,
  projectState: (pid: string) => ['project', pid, 'state'] as const,
  /** Every session in a project. Reading-list membership and status changes affect the
   *  `project_links` counts served with EVERY paper, not only the one that changed. */
  sessionsIn: (pid: string) => ['project', pid, 'session'] as const,
  session: (pid: string, slug: string, threadId = 'main') =>
    threadId === 'main'
      ? ['project', pid, 'session', slug] as const
      : ['project', pid, 'session', slug, threadId] as const,
  opening: (pid: string, slug: string, threadId = 'main') =>
    threadId === 'main'
      ? ['project', pid, 'opening', slug] as const
      : ['project', pid, 'opening', slug, threadId] as const,
  review: (pid: string, slug: string, threadId = 'main') =>
    threadId === 'main'
      ? ['project', pid, 'review', slug] as const
      : ['project', pid, 'review', slug, threadId] as const,
  settings: ['settings'] as const,
  plan: ['plan'] as const,
  favoriteModels: ['favoriteModels'] as const,
  prompts: (pid: string | null) => ['prompts', pid ?? 'default'] as const,
  graph: (pid: string) => ['project', pid, 'graph'] as const,
  neighbourhood: (pid: string) => ['project', pid, 'neighbourhood'] as const,
  paperGraph: (pid: string, slug: string) => ['project', pid, 'paperGraph', slug] as const,
  graphAuthors: (pid: string) => ['project', pid, 'graphAuthors'] as const,
  related: (pid: string, slug: string) => ['project', pid, 'related', slug] as const,
  discovery: (pid: string) => ['project', pid, 'discovery'] as const,
  notes: (pid: string, target: string) => ['project', pid, 'notes', target] as const,
  usage: (pid: string) => ['project', pid, 'usage'] as const,
  paperCover: (pid: string, slug: string) => ['project', pid, 'cover', slug] as const,
  paperFigures: (pid: string, slug: string) => ['project', pid, 'figures', slug] as const,
};

/** Whether the backend runs in developer mode (RC_DEV). Gates operator-only affordances —
 *  force-rebuild-from-scratch, in-app prompt editing — off the unauthenticated health probe.
 *  Cached long: it only changes on a server restart. */
export function useDevMode(): boolean {
  const hasUrl = !!useBaseUrl();
  const health = useQuery({
    queryKey: keys.health,
    queryFn: api.getHealth,
    enabled: hasUrl,
    staleTime: 5 * 60_000,
  });
  return health.data?.dev ?? false;
}

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

/** The paper's arXiv-HTML figure manifest (R.10). A `none` status (no HTML rendering, or not
 *  derived yet) is the common, non-error case — the discussion just renders without cards.
 *  Manifests can land AFTER a turn was written (enrichment backfill), so this refetches on a
 *  slow cadence while still `none` to pick up a late-arriving manifest, then settles. */
export function usePaperFigures(pid: string | null, slug: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && slug ? keys.paperFigures(pid, slug) : ['project', 'none', 'figures'],
    queryFn: () => api.getPaperFigures(pid as string, slug as string),
    enabled: hasUrl && !!pid && !!slug,
    refetchInterval: (query) => (query.state.data?.status === 'done' ? false : 30_000),
    staleTime: 30_000,
  });
}

export function useProjectState(pid: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid ? keys.projectState(pid) : ['project', 'none', 'state'],
    queryFn: () => api.getProjectState(pid as string),
    enabled: !!pid && hasUrl,
    // Full-text retrieval launches affiliation extraction independently so it never delays
    // reading. Poll only while one of those short metadata passes is still outstanding.
    refetchInterval: (query) =>
      query.state.data?.papers.some((paper) => paper.affiliation_status === 'pending')
        ? 3_000
        : false,
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

export function useSession(pid: string | null, slug: string | null, threadId = 'main') {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && slug ? keys.session(pid, slug, threadId) : ['project', 'none', 'session'],
    queryFn: () => api.getSession(pid as string, slug as string, threadId),
    enabled: !!pid && !!slug && hasUrl,
    // A short freshness window so a resume that was prefetched from the Library (index.tsx)
    // renders straight from cache without an immediate refetch flash (R.7). Mutations still
    // invalidate this key explicitly, so committed turns refresh regardless.
    staleTime: 15_000,
    refetchInterval: (query) =>
      query.state.data?.paper.affiliation_status === 'pending' ? 3_000 : false,
  });
}

/** The proposed commit for a notes-drafted paper (notes block + synthesis + revision token).
 *  `enabled` defers the fetch until the review surface is actually opened. Always refetched
 *  (staleTime 0) so the revision token guards a stale approve. */
export function useReview(
  pid: string | null,
  slug: string | null,
  enabled = true,
  threadId = 'main',
) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && slug ? keys.review(pid, slug, threadId) : ['project', 'none', 'review'],
    queryFn: () => api.getReview(pid as string, slug as string, threadId),
    enabled: !!pid && !!slug && hasUrl && enabled,
    staleTime: 0,
  });
}

/** DR-140 — the project papers the latest response cited without their having been read here.
 *  Keyed UNDER the session key so every turn settle (which invalidates the session) refreshes
 *  the offer too; `enabled` lets the screen skip the fetch while a turn streams. */
export function useReaderCandidates(
  pid: string | null,
  slug: string | null,
  threadId = 'main',
  enabled = true,
) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && slug
      ? [...keys.session(pid, slug, threadId), 'reader-candidates'] as const
      : ['project', 'none', 'reader-candidates'] as const,
    queryFn: () => api.getReaderCandidates(pid as string, slug as string, threadId),
    enabled: !!pid && !!slug && hasUrl && enabled,
    staleTime: 15_000,
  });
}

export function useOpeningDraft(pid: string | null, slug: string | null, threadId = 'main') {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && slug ? keys.opening(pid, slug, threadId) : ['project', 'none', 'opening'],
    queryFn: () => api.getOpeningDraft(pid as string, slug as string, threadId),
    enabled: !!pid && !!slug && hasUrl,
    // staleTime 0 (the shared client defaults to 30s) so a prefetched draft still
    // background-refetches on mount and its displayed prompt stays current. The prefetch
    // (index.tsx) still gives the no-spinner resume: cached data renders while that refetch
    // runs silently. The first turn no longer submits opening.data.model as an override (see
    // ComposeFirst.start), so a cached draft can never pin a superseded model.
    staleTime: 0,
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

/** The account's plan and month-to-date standing.
 *
 *  Not polled. Holds move on a timescale of seconds, but the detail screen deliberately does not
 *  animate them — the reader is explicitly told not to treat the number as a countdown, so a poll
 *  would burn battery re-rendering something that is not meant to tick.
 *
 *  Three refresh paths, and `refetchOnWindowFocus` is NOT one of them: React Native fires no
 *  window focus events without a `focusManager` bridge, and Expo Router screen focus is a
 *  different thing entirely. The screen refetches through `useFocusEffect`, the reader can pull
 *  to refresh, and — DR-036 — any job snapshot observed anywhere in the client whose status
 *  changed invalidates this key via `planInvalidation.notePlanAffectingJob`, wired once at the
 *  endpoint layer rather than per call site (the per-call-site attempt in #336 missed paths
 *  twice). */
export function usePlan() {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: keys.plan,
    queryFn: api.getPlan,
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

/** Save a prompt override (dev-only surface). Refreshes the prompt listing on success so the
 *  panel reflects the new active source/hash, and any cached opening drafts (which bake in
 *  prompt text) so a reopened paper picks up the edit. */
export function useSavePrompt(pid: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api.savePrompt(key, value),
    onSuccess: () => {
      showToast('Prompt saved');
      qc.invalidateQueries({ queryKey: keys.prompts(pid) });
      qc.invalidateQueries({ predicate: (q) => q.queryKey[2] === 'opening' });
    },
  });
}

/** Reset a prompt to its bundled/file default (dev-only surface). */
export function useResetPrompt(pid: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key }: { key: string }) => api.resetPrompt(key),
    onSuccess: () => {
      showToast('Prompt reset to default');
      qc.invalidateQueries({ queryKey: keys.prompts(pid) });
      qc.invalidateQueries({ predicate: (q) => q.queryKey[2] === 'opening' });
    },
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

export function useUpdateProjectMeta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pid, patch }: { pid: string; patch: { name?: string; favorite?: boolean } }) =>
      api.updateProjectMeta(pid, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.projects });
      // Project names ride along on cross-project surfaces (Continue card).
      qc.invalidateQueries({ queryKey: keys.recentSessions });
    },
  });
}

export function useSplitProject(pid: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      slugs: string[];
      remove_from_source: boolean;
      goals?: string;
      draft_destination_notes: boolean;
      cleanup_source_notes: boolean;
    }) =>
      api.splitProject(pid as string, body),
    onSuccess: (_res, { remove_from_source }) => {
      qc.invalidateQueries({ queryKey: keys.projects });
      qc.invalidateQueries({ queryKey: keys.recentSessions });
      if (pid && remove_from_source) {
        // The source lost papers (and possibly graph nodes/authors).
        qc.invalidateQueries({ queryKey: keys.projectState(pid) });
        // …which also changes the citation counts on the papers left behind.
        qc.invalidateQueries({ queryKey: keys.sessionsIn(pid) });
        qc.invalidateQueries({ queryKey: keys.graph(pid) });
        qc.invalidateQueries({ queryKey: keys.graphAuthors(pid) });
      }
    },
  });
}

export function useMoveProject(pid: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      dest_pid: string;
      slugs: string[];
      remove_from_source: boolean;
      draft_destination_notes: boolean;
      cleanup_source_notes: boolean;
    }) =>
      api.moveProject(pid as string, body),
    onSuccess: (_res, { dest_pid, remove_from_source }) => {
      qc.invalidateQueries({ queryKey: keys.projects });
      qc.invalidateQueries({ queryKey: keys.recentSessions });
      // The destination gained papers (and graph nodes/authors).
      qc.invalidateQueries({ queryKey: keys.projectState(dest_pid) });
      qc.invalidateQueries({ queryKey: keys.graph(dest_pid) });
      qc.invalidateQueries({ queryKey: keys.graphAuthors(dest_pid) });
      if (pid && remove_from_source) {
        // The source lost papers (and possibly graph nodes/authors).
        qc.invalidateQueries({ queryKey: keys.projectState(pid) });
        qc.invalidateQueries({ queryKey: keys.graph(pid) });
        qc.invalidateQueries({ queryKey: keys.graphAuthors(pid) });
      }
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pid }: { pid: string }) => api.deleteProject(pid),
    onSuccess: (_res, { pid }) => {
      // Drop the row from the cache synchronously BEFORE invalidating: the switcher decides
      // the replacement selection from this cache, and the Library auto-select effect must
      // never see (and re-persist) the deleted pid while the refetch is in flight.
      qc.setQueryData<Project[]>(keys.projects, (old) => old?.filter((p) => p.id !== pid));
      qc.invalidateQueries({ queryKey: keys.projects });
      qc.invalidateQueries({ queryKey: keys.recentSessions });
    },
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    // A shared scope serializes these: TanStack runs mutations with the same scope id one at a
    // time, in the order they were fired. Settings are now committed one field per request, so
    // two rapid changes to the SAME preference would otherwise be two concurrent writes and the
    // server would keep whichever happened to land last.
    scope: { id: 'settings' },
    mutationFn: (body: Record<string, unknown>) => api.saveSettings(body),
    onSuccess: () => {
      showToast('Settings saved');
      qc.invalidateQueries({ queryKey: keys.settings });
    },
  });
}

export function useGraph(pid: string | null, enabled = true) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid ? keys.graph(pid) : ['project', 'none', 'graph'],
    queryFn: () => api.getGraph(pid as string),
    enabled: !!pid && hasUrl && enabled,
  });
}

/** The per-paper reference graph (ego view): this paper, what it references, what cites it.
 *  Polls while a build runs so the view fills in once the graph finishes. */
export function usePaperGraph(pid: string | null, slug: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid && slug ? keys.paperGraph(pid, slug) : ['project', 'none', 'paperGraph'],
    queryFn: () => api.getPaperGraph(pid as string, slug as string),
    enabled: !!pid && !!slug && hasUrl,
    refetchInterval: (query) =>
      query.state.data?.build && query.state.data.build.status === 'running' ? 2000 : false,
  });
}

/** DR-052 PR 4: the shared corpus-neighbourhood freshness both the Map and Discover tabs show,
 *  so the merge beneath them (they maintain one substrate) becomes visible. Cheap read-only
 *  endpoint; a build or a Discover run invalidates it via keys.neighbourhood. */
export function useNeighbourhood(pid: string | null) {
  const hasUrl = !!useBaseUrl();
  return useQuery({
    queryKey: pid ? keys.neighbourhood(pid) : ['project', 'none', 'neighbourhood'],
    queryFn: () => api.getNeighbourhood(pid as string),
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

/** A committed notes document — one paper's Paper Notes block, or 'working' for the Project Notes. */
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
    mutationFn: async ({
      title,
      group,
      arxivId,
      abstract,
      year,
      pdfUrl,
      autoAnalyze,
    }: {
      title: string;
      group?: string;
      arxivId?: string;
      abstract?: string;
      year?: number | null;
      /** Direct PDF link when the caller has one (URL adds) — not sent to the add itself,
       *  but carried into the initial-analysis offer so retrieval fetches that exact source. */
      pdfUrl?: string;
      /** The known-paper entry point navigates straight to the running discussion and starts
       *  there, so it must not also open the optional analysis-offer sheet. */
      autoAnalyze?: boolean;
    }): Promise<AddPaperOutcome> => {
      const preflight = async () => {
        try {
          return await api.findPaperMatches(pid, {
            title,
            arxiv_id: arxivId,
            source_url: pdfUrl,
          });
        } catch (e) {
          // Rolling mobile/backend deploys: an older server has no preflight route. Preserve
          // ordinary adds there; its existing in-project duplicate guard still applies.
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        }
      };
      const chooseExisting = async (
        match: NonNullable<Awaited<ReturnType<typeof preflight>>>,
      ) => requestExistingPaperReuse({
        targetPid: match.target_project.id,
        targetName: match.target_project.name,
        candidateTitle: title,
        canUpdateNotes: match.can_update_notes,
        matches: match.matches,
      });

      const match = await preflight();
      if (match?.matches.length) return chooseExisting(match);

      try {
        const { paper } = await api.addPaper(pid, title, group, arxivId, abstract, year);
        return { action: 'added', paper };
      } catch (e) {
        // The backend repeats the check at mutation time. If another project gained the paper
        // after our first scan, refresh once and still present the safe Copy/Move chooser.
        if (e instanceof ApiError && e.status === 409) {
          const raced = await preflight();
          if (raced?.matches.length) return chooseExisting(raced);
        }
        throw e;
      }
    },
    onSuccess: (res, { arxivId, pdfUrl, autoAnalyze }) => {
      if (!res.paper) return;
      qc.invalidateQueries({ queryKey: keys.projectState(pid) });
      qc.invalidateQueries({ queryKey: keys.sessionsIn(pid) });  // membership → citation counts
      qc.invalidateQueries({ queryKey: keys.graph(pid) });
      qc.invalidateQueries({ queryKey: keys.graphAuthors(pid) });  // membership → board changes
      if (res.action !== 'added' || autoAnalyze) return;
      // Instead of a bare "added" toast, offer to kick the paper summary off in the
      // background (R7.8). The offer sheet has its own "Not now".
      offerPaperSummary({
        pid,
        slug: res.paper.slug,
        title: res.paper.title,
        arxivId: arxivId || res.paper.arxiv_id || undefined,
        pdfUrl,
      });
    },
  });
}

function invalidateAfterRemoval(qc: ReturnType<typeof useQueryClient>, pid: string | null) {
  if (!pid) return;
  qc.invalidateQueries({ queryKey: keys.projectState(pid) });
  // Removing a paper changes the citation counts shown on OTHER papers' reading-mode screens.
  qc.invalidateQueries({ queryKey: keys.sessionsIn(pid) });
  qc.invalidateQueries({ queryKey: keys.graph(pid) });
  qc.invalidateQueries({ queryKey: keys.graphAuthors(pid) });
  qc.invalidateQueries({ queryKey: keys.projects });
  qc.invalidateQueries({ queryKey: keys.recentSessions });
}

export function useRemovePaper(pid: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.removePaper(pid as string, slug),
    onSuccess: () => invalidateAfterRemoval(qc, pid),
  });
}

/** Atomic batch removal for the multi-select Delete (R9.13): one request, one commit. */
export function useRemovePapers(pid: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slugs: string[]) => api.removePapersBatch(pid as string, slugs),
    onSuccess: () => invalidateAfterRemoval(qc, pid),
  });
}
