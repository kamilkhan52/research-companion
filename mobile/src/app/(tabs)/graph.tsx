// Reference Graph — a project-scoped screen showing how the project's papers cite each
// other and which external works they lean on, with a recommendation ranking for what to
// add next. Reachable from the Library's project bar. See app/graph.py for the pipeline.

import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { useDevMode, useGraph, useNeighbourhood, useProjectState } from '@/api/queries';
import type { GraphEdge, GraphNode, GraphRetrievalCandidate, GraphStatus } from '@/api/types';
import { BottomSheet } from '@/components/BottomSheet';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { NodeDetailSheet } from '@/components/graph/NodeDetailSheet';
import { ProgressSteps } from '@/components/ProgressSteps';
import { TabHeader } from '@/components/TopBar';
import { canStartGraphBuild } from '@/graph/buildAvailability';
import { nodeMatchesQuery, pageSignificant, significantNodes } from '@/graph/filter';
import { readableError } from '@/api/errorMessage';
import { useGraphBuild, type GraphBuildState } from '@/hooks/useGraphBuild';
import { useActiveProject } from '@/store/project';
import { useGraphSettings } from '@/store/graphSettings';
import { NeighbourhoodLine } from '@/components/NeighbourhoodLine';
import { AnimatedProgressBar, Button, Card, Icon, Screen, Text, ToneIcon, ToneSurface } from '@/ui';
import { Marquee } from '@/ui/Marquee';
import { useTheme, useThemedStyles, type DensityMode } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';
import { DiscoverContent } from './discover';

type FilterKind = 'all' | 'project' | 'external' | 'significant';

const FILTERS: { key: FilterKind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'project', label: 'In project' },
  { key: 'external', label: 'External' },
  { key: 'significant', label: 'Significant' },
];

// Pagination: a project's full reference graph can run into the hundreds of external nodes, so
// rather than render everything (or a fixed heuristic subset) we show a page at a time and let
// "Show more" grow it, capped well short of "the whole graph" to keep the canvas responsive.
export const GRAPH_PAGE_SIZE = 50;
const MAX_VISIBLE = 100;

/** Most load-bearing papers first, so pagination surfaces the ones worth seeing before the
 *  long tail: project papers, then by how significantly/broadly they're cited, then by overall
 *  citation count. */
function rankNode(a: GraphNode, b: GraphNode): number {
  if (a.kind !== b.kind) return a.kind === 'project' ? -1 : 1;
  if (b.significant_cited_by_count !== a.significant_cited_by_count) {
    return b.significant_cited_by_count - a.significant_cited_by_count;
  }
  if (b.cited_by_project_count !== a.cited_by_project_count) return b.cited_by_project_count - a.cited_by_project_count;
  return (b.citation_count ?? 0) - (a.citation_count ?? 0);
}

export default function GraphScreen() {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // `?focus=<slug>` (from the paper action sheet's "Show in Map") selects that node once
  // the graph is available; `t` is a per-tap nonce so re-focusing the same slug re-selects.
  const {
    focus,
    t: focusNonce,
    explore,
  } = useLocalSearchParams<{ focus?: string; t?: string; explore?: string }>();
  const { activePid } = useActiveProject();
  const graphQuery = useGraph(activePid);
  const projectState = useProjectState(activePid);
  const build = useGraphBuild(activePid);
  const neighbourhood = useNeighbourhood(activePid);
  const { allowAllFilter } = useGraphSettings();
  const devMode = useDevMode();
  const { height: windowHeight } = useWindowDimensions();
  const combinedScrollRef = useRef<ScrollView>(null);
  const discoverSectionY = useRef(0);
  // `explore` is a one-shot navigation intent, not a permanent scroll lock. Keep following the
  // section while the screen settles, then retire it as soon as the reader touches the surface.
  // The ref closes the gap before setParams removes the route param on the next render.
  const exploreLandingActive = useRef(Boolean(explore));

  // DR-052 step 4 — ONE search box (Kamil, 2026-09-13): it narrows the map while typing and
  // runs the paid Discover search on submit. `discoverSubmit` is the hand-off to the list
  // below the graph; the token makes each submit a distinct request even for the same text.
  const [query, setQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [discoverSubmit, setDiscoverSubmit] = useState<{ text: string; token: number } | null>(null);
  const [filter, setFilter] = useState<FilterKind>('significant');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(GRAPH_PAGE_SIZE);

  // A filter/search change (or switching to a different project's graph — this tab stays
  // mounted across the Library's project switch) starts a fresh page rather than keeping
  // whatever limit was reached browsing the previous set.
  useEffect(() => {
    setVisibleLimit(GRAPH_PAGE_SIZE);
  }, [filter, query, activePid]);

  const data = graphQuery.data;
  const graph = data?.graph ?? null;
  const status = data?.status ?? null;
  // DR-052 staged surface merge: the empty project is the one state where the Map has nothing
  // useful to filter or build. Put the real query-to-results experience here before the
  // Discover tab is removed in a later release. Requiring loaded project data avoids briefly
  // presenting a paid-search entry point while the paper list is still unknown.
  const isEmptyProject = projectState.data !== undefined
    && projectState.data.papers.length === 0;
  // Adding the first result invalidates projectState immediately. If the surface followed that
  // value forever, its own first Add would unmount the ranked list (and any live Stop/Skip
  // controls) in favour of "Build map". Latch the first-run surface for this focused visit;
  // leaving Map or switching projects clears it, so the next entry gets the normal graph state.
  const [discoverEntryPid, setDiscoverEntryPid] = useState<string | null>(null);
  const isFocused = useIsFocused();
  useEffect(() => {
    setDiscoverEntryPid((current) => {
      // Bottom tabs blur without unmounting. Clearing while blurred and re-arming on focus is
      // what makes "this visit" real even if the reader checks another tab during a long run.
      if (!isFocused) return null;
      if (isEmptyProject) return activePid;
      return current === activePid ? current : null;
    });
  }, [activePid, isEmptyProject, isFocused]);
  const showFirstRunDiscover = isEmptyProject
    || Boolean(activePid && discoverEntryPid === activePid);
  const showAllFilter = allowAllFilter || graph?.stage === 'skeleton';
  const filters = useMemo(
    () => (showAllFilter ? FILTERS : FILTERS.filter((f) => f.key !== 'all')),
    [showAllFilter],
  );

  // A metadata-only skeleton cannot have locally significant edges by design, so show its full
  // map instead of leaving the default Significant filter on an apparently empty canvas. Once
  // enrichment finishes, restore the normal Settings-controlled visibility of the All filter.
  // Correct only on the stage TRANSITION: re-asserting it every render clobbered an explicit
  // Significant tap while the full build was still running (R7.2) — a deliberate choice sticks,
  // and the empty-state hint below explains what Significant is waiting on.
  const prevStage = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const stage = graph?.stage ?? null;
    if (stage === prevStage.current) return;
    prevStage.current = stage;
    if (stage === 'skeleton' && filter === 'significant') setFilter('all');
    else if (stage !== 'skeleton' && filter === 'all' && !allowAllFilter) {
      setFilter('significant');
    }
  }, [filter, allowAllFilter, graph?.stage]);
  const hasSemanticScholarData = useMemo(
    () => graph?.edges.some((edge) => edge.provenance?.includes('semantic_scholar')) ?? false,
    [graph],
  );

  // Recover in-progress builds on (re)open: if loading the graph reveals a build still running
  // server-side (e.g. the app was minimized during it), re-attach to it so the progress UI
  // shows live status again instead of the "no graph yet" state. resume() is a no-op unless
  // the job is actually running, and is idempotent if we're already polling it.
  const resumeBuild = build.resume;
  useEffect(() => {
    resumeBuild(data?.build);
  }, [data?.build, resumeBuild]);

  useEffect(() => {
    if (!focus || !graph) return;
    const node = graph.nodes.find((n) => n.kind === 'project' && n.slug === focus);
    if (node) setSelectedNode(node);
  }, [focus, focusNonce, graph]);

  const nodesById = useMemo(() => {
    const m: Record<string, GraphNode> = {};
    graph?.nodes.forEach((n) => (m[n.id] = n));
    return m;
  }, [graph]);

  const searching = query.trim().length > 0;
  const filteredNodes = useMemo(() => {
    if (!graph) return [];
    let ns = graph.nodes;
    if (filter === 'project') ns = ns.filter((n) => n.kind === 'project');
    else if (filter === 'external') ns = ns.filter((n) => n.kind === 'external');
    // A search looks at every paper on the map. "Significant" is the default VIEW, not a
    // property the reader asked for: leaving it on would report "0 on the map" for a paper
    // that is there, merely without a significant citation yet.
    else if (filter === 'significant' && !searching) ns = significantNodes(ns, graph.edges);
    if (searching) ns = ns.filter((n) => nodeMatchesQuery(n, query));
    return [...ns].sort(rankNode);
  }, [graph, filter, query, searching]);

  // What actually gets rendered: the current filter/search's matches, paginated (not "render all
  // and dim" — that rendered 700+ views even for the 'significant' tab, the cause of the slow
  // tabs). Edges are kept only between visible nodes.
  const pagedNodes = useMemo(
    () => (filter === 'significant' && !searching
      ? pageSignificant(filteredNodes, graph?.edges ?? [], visibleLimit)
      : filteredNodes.slice(0, visibleLimit)),
    [filteredNodes, filter, graph, visibleLimit, searching],
  );

  const visibleGraph = useMemo(() => {
    // A node explicitly opened (via "Show in Map" or a Recommendations pick) must actually
    // render on the canvas even if it doesn't pass the current filter/page — e.g. a project
    // paper with no "significant" citations is invisible under the default filter, but the
    // detail sheet it opens implies "you're now looking at this one."
    const nodes =
      selectedNode && graph?.nodes.some((n) => n.id === selectedNode.id) && !pagedNodes.some((n) => n.id === selectedNode.id)
        ? [...pagedNodes, selectedNode]
        : pagedNodes;
    const keep = new Set(nodes.map((n) => n.id));
    return { nodes, edges: (graph?.edges ?? []).filter((e) => keep.has(e.source) && keep.has(e.target)) };
  }, [graph, pagedNodes, selectedNode]);

  // The stepper is only worth showing once there's more than a single page to move between.
  const showPager = filteredNodes.length > GRAPH_PAGE_SIZE;
  const canIncrease = visibleLimit < Math.min(MAX_VISIBLE, filteredNodes.length);
  const canDecrease = visibleLimit > GRAPH_PAGE_SIZE;
  const hitCap = visibleLimit >= MAX_VISIBLE && filteredNodes.length > pagedNodes.length;
  function increaseVisible() {
    setVisibleLimit((v) => Math.min(v + GRAPH_PAGE_SIZE, MAX_VISIBLE));
  }
  function decreaseVisible() {
    setVisibleLimit((v) => Math.max(v - GRAPH_PAGE_SIZE, GRAPH_PAGE_SIZE));
  }

  const staleCount = status?.stale_papers.length ?? 0;
  const retrievalErrors = status?.retrieval_errors ?? {};
  const retrievalErrorCount = Object.keys(retrievalErrors).length;
  const changedPaperCount = status?.stale_papers.filter((slug) => !retrievalErrors[slug]).length ?? 0;
  const needsEnrichment = Boolean(
    (status?.graph_needs_enrichment || graph?.stage === 'skeleton') && !build.building,
  );
  const needsBuildAttention = staleCount > 0 || needsEnrichment;
  const retrievalCandidates = build.progress?.retrievalCandidates
    ?? status?.retrieval_candidates
    ?? {};

  function openPaper(slug: string) {
    setSelectedNode(null);
    router.push(`/paper/${encodeURIComponent(slug)}`);
  }

  // A refresh that failed while something useful is already on screen — a built graph, or an
  // empty project mid-build. Non-blocking on purpose: the reader keeps what they have and the
  // next successful poll clears it by itself, which is exactly what was observed happening.
  const refreshFailed = graphQuery.isRefetchError ? (
    <ErrorBanner
      detail={readableError(graphQuery.error, 'Could not refresh the graph.')}
      onDismiss={() => graphQuery.refetch()}
    />
  ) : null;

  const scrollToDiscover = useCallback((animated: boolean) => {
    if (discoverSectionY.current <= 0) return;
    combinedScrollRef.current?.scrollTo({
      y: Math.max(0, discoverSectionY.current - space.sm),
      animated,
    });
  }, []);

  useEffect(() => {
    if (explore) exploreLandingActive.current = true;
  }, [explore]);

  const consumeExploreLanding = useCallback(() => {
    if (!exploreLandingActive.current) return;
    exploreLandingActive.current = false;
    router.setParams({ explore: undefined });
  }, [router]);

  // With a built map the search box IS the query editor, so an explore entry (an old
  // /discover link, Add paper's "Explore") opens the box instead of scrolling past the map.
  // Without a map there is no box, and the list's own editor below is still the landing.
  const hasSearchBox = Boolean(graph) && !showFirstRunDiscover;
  useEffect(() => {
    if (!explore || !exploreLandingActive.current) return;
    if (hasSearchBox) {
      setShowSearch(true);
      consumeExploreLanding();
      return;
    }
    if (discoverSectionY.current <= 0) return;
    const frame = requestAnimationFrame(() => {
      if (exploreLandingActive.current) scrollToDiscover(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [explore, hasSearchBox, consumeExploreLanding, scrollToDiscover]);

  const submitSearch = useCallback(() => {
    const text = query.trim();
    if (!text) return;
    Keyboard.dismiss();
    setDiscoverSubmit((prev) => ({ text, token: (prev?.token ?? 0) + 1 }));
    // The run's progress and results are below the map; take the reader to them.
    requestAnimationFrame(() => scrollToDiscover(true));
  }, [query, scrollToDiscover]);

  const editSearch = useCallback((text: string) => {
    setQuery(text);
    setShowSearch(true);
    combinedScrollRef.current?.scrollTo({ y: 0, animated: true });
  }, []);

  return (
    <Screen edges={['top']}>
      <TabHeader
        title="Map"
        subtitle={graph ? `${graph.nodes.length} papers · ${graph.edges.length} citations` : undefined}
        actions={showFirstRunDiscover ? [] : [
          {
            name: 'search',
            onPress: () => {
              consumeExploreLanding();
              // Closing the search also clears it — a hidden query would silently keep
              // culling the canvas.
              setShowSearch((v) => {
                if (v) setQuery('');
                return !v;
              });
            },
            accessibilityLabel: showSearch ? 'Hide search' : 'Search the map and explore papers',
          },
          {
            name: 'refresh-cw',
            badge: needsBuildAttention,
            onPress: () => {
              consumeExploreLanding();
              // Full rebuild-from-scratch re-fetches everything (metadata, extractions, author
              // affiliations) rather than only what changed. It's an operator power tool, so
              // dev-only (RC_DEV). Android's AlertDialog caps at 3 buttons, so when dev adds
              // "From scratch" to the attention dialog we drop the cheap "Just refresh".
              const scratchBtn = {
                text: 'From scratch',
                style: 'destructive' as const,
                onPress: () => build.run(true),
              };
              if (needsBuildAttention) {
                const reasons = [
                  needsEnrichment
                    ? 'The fast map is ready, but full-text enrichment did not finish.'
                    : '',
                  retrievalErrorCount > 0
                    ? `${retrievalErrorCount} paper source${retrievalErrorCount === 1 ? '' : 's'} could not be retrieved.`
                    : '',
                  changedPaperCount > 0
                    ? `${changedPaperCount} paper${changedPaperCount === 1 ? '' : 's'} changed since the last build.`
                    : '',
                ].filter(Boolean).join(' ');
                Alert.alert(
                  needsEnrichment ? 'Finish graph enrichment?' : 'Rebuild reference graph?',
                  // "Rebuild" sounds expensive but is incremental: unchanged papers stay
                  // cached; only new, changed, or failed ones are re-processed (U.19).
                  `${reasons} ${needsEnrichment ? 'Continue' : 'Rebuild'} to process the affected papers — unchanged ones stay cached, so this only costs what changed.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    ...(devMode
                      ? []
                      : [{ text: 'Just refresh', onPress: () => void graphQuery.refetch() }]),
                    { text: needsEnrichment ? 'Continue' : 'Rebuild', onPress: () => build.run(false) },
                    ...(devMode ? [scratchBtn] : []),
                  ],
                );
              } else if (devMode) {
                Alert.alert(
                  'Rebuild reference graph?',
                  'Everything is up to date. You can force a full rebuild from scratch — it '
                  + 're-fetches metadata, extractions, and author affiliations (affiliations '
                  + 'stay patchy; many arXiv papers list none).',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Just refresh', onPress: () => void graphQuery.refetch() },
                    scratchBtn,
                  ],
                );
              } else {
                void graphQuery.refetch();
              }
            },
            accessibilityLabel: needsBuildAttention
              ? 'Refresh graph (build action available)'
              : 'Refresh graph',
          },
          {
            name: 'users',
            onPress: () => {
              consumeExploreLanding();
              router.push('/authors');
            },
            accessibilityLabel: 'Authors & labs',
          },
          {
            name: 'compass',
            onPress: () => {
              consumeExploreLanding();
              scrollToDiscover(true);
            },
            accessibilityLabel: 'Explore papers below the map',
          },
        ]}
      />

      {!activePid ? (
        <Centered text="No active project selected." />
      ) : showFirstRunDiscover ? (
        // A zero-paper project has no graph to recover. Its first-paper on-ramp must not depend
        // on the unrelated graph read succeeding — a stale/offline graph cache cannot make a
        // fresh project's Discover entry disappear.
        <DiscoverContent editorRequest={explore} />
      ) : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <ScrollView
            ref={combinedScrollRef}
            testID="combined-map-scroll"
            contentContainerStyle={styles.combinedBody}
            keyboardShouldPersistTaps="handled"
            onTouchStart={consumeExploreLanding}
            onScrollBeginDrag={consumeExploreLanding}>
          <View style={!graph ? styles.mapStateRegion : undefined}>
      {graphQuery.isLoading ? (
        <Centered loading />
      ) : graphQuery.isLoadingError ? (
        // `isLoadingError`, not `isError`: this branch is only for a query that has NEVER
        // succeeded. React Query keeps `data` when a REFETCH fails and reports `isError` anyway,
        // and this branch used to run first — so one dropped DNS lookup replaced a fully built
        // graph with an error page, and the next successful poll silently restored it.
        //
        // `!graph` is not enough either: a project that is still building answers successfully
        // with `graph: null` plus live build status, so a failed refetch there would hide the
        // progress the reader is waiting on. A refresh failure is a banner, never a replacement.
        <Centered
          text={readableError(graphQuery.error, 'Could not load the graph.')}
          action={<Button title="Retry" variant="ghost" onPress={() => graphQuery.refetch()} />}
        />
      ) : !graph && projectState.isLoading ? (
        <Centered loading />
      ) : !graph ? (
        <>
          {refreshFailed}
          <EmptyBuildState
            status={status}
            build={build}
            projectId={activePid}
            hasPriorWork={(projectState.data?.papers ?? []).some((p) => p.has_notes)}
          />
        </>
      ) : (
        <>
          {needsEnrichment ? <SkeletonResume build={build} /> : null}

          <RetrievalConfirmations candidates={retrievalCandidates} build={build} />

          <RetrievalErrors errors={retrievalErrors} build={build} />

          <MapControlRail
            building={build.building}
            progress={build.progress}
            query={query}
            onQueryChange={setQuery}
            onSubmitQuery={submitSearch}
            matchCount={filteredNodes.length}
            showSearch={showSearch}
            filters={filters}
            filter={filter}
            onFilterChange={setFilter}
            visibleCount={visibleGraph.nodes.length}
          />

          {/* DR-052 PR 4: the SAME forward-citation freshness the Discover tab shows — the
              shared substrate beneath both tabs — but READ-ONLY here and only once a scan
              exists. The forward sweep is Discovery's (the Map build never writes citer
              records), so the Map shows the connection without offering to refresh a scan it
              doesn't run, and doesn't clutter a fresh map with a "not scanned yet" line. */}
          {neighbourhood.data?.ever_swept ? (
            <NeighbourhoodLine neighbourhood={neighbourhood.data} />
          ) : null}

          <View style={[styles.graphViewport, {
            height: Math.max(360, Math.min(520, windowHeight * 0.56)),
          }]}>
            {query.trim() && filteredNodes.length === 0 ? (
              <Centered text="Nothing on the map matches this search. Search explores papers beyond it." />
            ) : filter === 'significant' && filteredNodes.length === 0 && graph.stage === 'skeleton' ? (
              <Centered text="Significant citations appear once enrichment finishes — the fast map has metadata only." />
            ) : (
              <GraphCanvas
                nodes={visibleGraph.nodes}
                edges={visibleGraph.edges}
                selectedId={selectedNode?.id ?? null}
                highlightIds={null}
                onSelectNode={setSelectedNode}
                layoutAlgo={graph?.layout?.algo ?? null}
                overlay={showPager ? (
                  <GraphPagerOverlay
                    shown={pagedNodes.length}
                    total={filteredNodes.length}
                    canIncrease={canIncrease}
                    canDecrease={canDecrease}
                    hitCap={hitCap}
                    onIncrease={increaseVisible}
                    onDecrease={decreaseVisible}
                  />
                ) : null}
              />
            )}
          </View>

          {hasSemanticScholarData ? (
            <Pressable
              onPress={() => void Linking.openURL('https://www.semanticscholar.org/')}
              accessibilityRole="link"
              accessibilityLabel="Open Semantic Scholar"
              style={styles.attribution}>
              <Text variant="caption" color={t.muted}>
                Reference metadata provided by Semantic Scholar ↗
              </Text>
            </Pressable>
          ) : null}

          {build.error ? <ErrorBanner detail={build.error} onDismiss={build.clearError} /> : null}
          {refreshFailed}
        </>
      )}
          </View>
          <View
            testID="map-discover-section"
            onLayout={(event) => {
              discoverSectionY.current = event.nativeEvent.layout.y;
              if (exploreLandingActive.current && !hasSearchBox) {
                requestAnimationFrame(() => {
                  if (exploreLandingActive.current) scrollToDiscover(false);
                });
              }
            }}>
            <DiscoverContent
              embedded
              editorRequest={hasSearchBox ? undefined : explore}
              showNeighbourhood={false}
              sharedQuery={hasSearchBox
                ? { submit: discoverSubmit, onEdit: editSearch }
                : undefined}
            />
          </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      <NodeDetailSheet
        pid={activePid}
        node={selectedNode}
        edges={graph?.edges ?? []}
        nodesById={nodesById}
        onClose={() => setSelectedNode(null)}
        onOpenPaper={openPaper}
      />

    </Screen>
  );
}

export function EmptyBuildState({
  status,
  build,
  projectId,
  hasPriorWork,
}: {
  status: GraphStatus | null;
  build: GraphBuildState;
  projectId: string;
  hasPriorWork: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  if (build.building) {
    return (
      <View style={styles.emptyWrap}>
        <BuildProgressBanner progress={build.progress} large projectId={projectId} />
      </View>
    );
  }
  // DR-045: no map means say that and nothing else. The mechanics of how a build works
  // (Semantic Scholar, arXiv matching, full-text retrieval) belong to the build's own staged
  // progress, not to an empty screen.
  //
  // DR-046: a project with real reading history (at least one paper with notes) but no map is
  // most often an import — the derived graph lives only in `.state/`, which stays behind on the
  // source instance. An empty map here reads as data loss unless something says otherwise; the
  // one extra line stays factual rather than guessing "imported," since the same state is also
  // reachable by simply never having opened this tab before.
  return (
    <View style={styles.emptyWrap}>
      <Text variant="title" style={{ textAlign: 'center', marginBottom: space.lg }}>
        No map yet
      </Text>
      {hasPriorWork && !build.error ? (
        <Text variant="caption" color={t.muted} style={{ textAlign: 'center', marginBottom: space.md }}>
          This project already has papers with notes — nothing was lost, the map just hasn't
          been built here.
        </Text>
      ) : null}
      {build.error ? (
        <Text variant="caption" color={t.danger} style={{ textAlign: 'center', marginBottom: space.md }}>
          {build.error}
        </Text>
      ) : null}
      <RetrievalConfirmations
        candidates={build.progress?.retrievalCandidates ?? status?.retrieval_candidates ?? {}}
        build={build}
      />
      <Button
        title="Build map"
        onPress={() => build.run(false)}
        disabled={!canStartGraphBuild(status)}
      />
    </View>
  );
}

function RetrievalConfirmations({
  candidates,
  build,
}: {
  candidates: Record<string, GraphRetrievalCandidate[]>;
  build: GraphBuildState;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const entries = Object.entries(candidates).filter(([, options]) => options.length > 0);
  if (!entries.length || build.building) return null;
  return (
    <Card style={styles.confirmationCard}>
      <Text variant="heading">Confirm paper sources</Text>
      <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
        These matches were not confident enough to download automatically.
      </Text>
      {entries.map(([slug, options]) => (
        <View key={slug} style={{ marginTop: space.md, gap: space.xs }}>
          {options.slice(0, 3).map((candidate) => (
            <Button
              key={candidate.arxiv_id}
              title={`${candidate.title} · arXiv:${candidate.arxiv_id}`}
              variant="ghost"
              onPress={() => build.run(false, { [slug]: candidate.arxiv_id })}
            />
          ))}
        </View>
      ))}
    </Card>
  );
}

function SkeletonResume({ build }: { build: GraphBuildState }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={styles.confirmationCard}>
      <Text variant="heading">Fast map ready</Text>
      <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
        Continue to retrieve missing papers and verify citation evidence from full text.
      </Text>
      <Button
        title="Continue enrichment"
        variant="ghost"
        onPress={() => build.run(false)}
        style={{ marginTop: space.sm }}
      />
    </Card>
  );
}

// U.10: retrieval problems are worth knowing about, not worth a big red card squatting above
// the map. A small amber indicator opens the details sheet; Dismiss shrinks it to a ghost
// icon (still tappable later), and a NEW error set re-surfaces the full indicator.
export function RetrievalErrors({
  errors,
  build,
}: {
  errors: Record<string, string>;
  build: GraphBuildState;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const entries = Object.entries(errors);
  const errorsKey = entries.map(([slug]) => slug).sort().join('|');
  const [open, setOpen] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  if (!entries.length || build.building) return null;
  const dismissed = dismissedKey === errorsKey;
  return (
    <>
      <View style={styles.retrievalIndicatorRow}>
        <Pressable
          onPress={() => setOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`${entries.length} papers could not be retrieved — show details`}
          style={[styles.retrievalIndicator, dismissed && styles.retrievalIndicatorGhost]}
        >
          <Icon name="alert-circle" size={14} color={t.amber} />
          {!dismissed ? (
            <Text variant="caption" color={t.amber}>
              {entries.length} not retrieved
            </Text>
          ) : null}
        </Pressable>
      </View>
      <BottomSheet visible={open} onClose={() => setOpen(false)} scrollable>
        <Text variant="heading">Papers that could not be retrieved</Text>
        <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
          The map still works; these papers just have no full text yet.
        </Text>
        <View style={{ gap: space.sm, marginTop: space.md }}>
          {entries.map(([slug, detail]) => (
            <View key={slug}>
              <Text variant="heading" style={{ fontSize: 14 }}>{slug}</Text>
              <Text variant="caption" color={t.muted}>{detail}</Text>
            </View>
          ))}
        </View>
        <Button
          title="Retry missing papers"
          onPress={() => {
            setOpen(false);
            void build.run(false);
          }}
          style={{ marginTop: space.lg }}
        />
        <Button
          title="Dismiss"
          variant="ghost"
          onPress={() => {
            setDismissedKey(errorsKey);
            setOpen(false);
          }}
          style={{ marginTop: space.sm }}
        />
      </BottomSheet>
    </>
  );
}

// Build phases in pipeline order, discovery-style: the step row replaces the old single
// concatenated status line ("Fast map ready · enriching “very long title…”") that truncated on
// phones. Status, phase, and the paper being worked on each get their own line; the paper
// title auto-scrolls (Marquee) instead of clipping.
const BUILD_STEPS = [
  {
    key: 'metadata',
    label: 'Mapped',
    verb: 'Mapping references',
    hint: 'Mapped — the map is sketched from reference metadata first, so there is something to explore right away.',
  },
  {
    key: 'retrieval',
    label: 'Retrieved',
    verb: 'Retrieving',
    hint: 'Retrieved — missing papers get their full text fetched so citations can actually be verified.',
  },
  {
    key: 'extraction',
    label: 'Enriched',
    verb: 'Enriching',
    hint: 'Enriched — each paper is read in full to verify who really cites whom, and why it matters.',
  },
] as const;

const SKELETON_HINT =
  'Fast map ready — explore it now; enrichment keeps improving it in the background.';

// Hints auto-hide after a few beats (U.11: informative, never squatting). One shared timer —
// a new hint replaces the old one.
const HINT_MS = 6000;

// Hint state (the tap-to-explain step callouts, plus the one-time "skeleton ready" announcement)
// used to live inside the details view itself — but that view unmounts on every collapse (the
// full banner) or sheet dismiss (the control rail's build sheet), which reset the "announced
// once" guard and made the skeleton hint re-fire on every reopen. Opus review, PR #382. Each
// OWNER (the thing that actually stays mounted for the build's whole lifetime) holds this hook's
// state instead, so the guard survives its details view unmounting and remounting underneath it.
function useBuildHint(progress: GraphBuildState['progress']) {
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);
  const dismissHint = useCallback(() => setHint(null), []);
  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);
  const skeletonReady = progress?.graphStage === 'skeleton';
  const skeletonAnnounced = useRef(false);
  // `useGraphBuild.run()` resets `progress` to `phase: 'preparing'` at the start of every build —
  // the one moment that distinguishes "a genuinely new build" from "the same build's details view
  // remounted". Without this, `MapControlRail` staying mounted across separate rebuilds (unlike
  // the old per-render-conditional banner it replaced) would silently suppress the announcement
  // on a second rebuild within the same screen visit, since the guard would never reset.
  useEffect(() => {
    if (progress?.phase === 'preparing') skeletonAnnounced.current = false;
  }, [progress?.phase]);
  useEffect(() => {
    if (skeletonReady && !skeletonAnnounced.current) {
      skeletonAnnounced.current = true;
      showHint(SKELETON_HINT);
    }
  }, [skeletonReady, showHint]);
  return { hint, showHint, dismissHint };
}

// The build steps/hint/current-paper/progress-bar content, shared between the full banner (an
// EmptyBuildState card, still full-size — DR-069 didn't touch the no-map-yet path) and the
// compact control rail's build-details sheet (DR-069 — a sheet the reader explicitly opened is
// already "expanded", so it renders this directly with no collapse chrome of its own). Purely
// presentational: hint state belongs to whichever owner calls `useBuildHint` and stays mounted.
function BuildProgressDetails({
  progress, hint, onStepPress, onDismissHint,
}: {
  progress: GraphBuildState['progress'];
  hint: string | null;
  onStepPress: (text: string) => void;
  onDismissHint: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const pct = progress && progress.ready > 0 ? progress.done / progress.ready : 0;
  const phaseIndex = Math.max(0, BUILD_STEPS.findIndex((s) => s.key === progress?.phase));
  const verb = BUILD_STEPS[phaseIndex]?.verb ?? 'Working';

  if (!progress) return null;
  return (
    <>
      <ProgressSteps
        dotSize={22}
        steps={BUILD_STEPS.map((step, i) => ({
          key: step.key,
          label: step.label,
          state: i < phaseIndex ? 'done' : i === phaseIndex ? 'active' : 'pending',
          onPress: () => onStepPress(step.hint),
          accessibilityLabel: `What does ${step.label} mean?`,
        }))}
      />
      {hint ? (
        <Pressable onPress={onDismissHint} accessibilityLabel="Dismiss hint">
          <ToneSurface tone="mint" style={styles.buildHint}>
            <Text variant="caption" color={t.text}>{hint}</Text>
          </ToneSurface>
        </Pressable>
      ) : null}
      {progress.currentTitle ? (
        <ToneSurface tone="neutral" style={styles.currentPaper}>
          <Text variant="overline" color={t.muted}>{verb}</Text>
          <Marquee
            text={progress.currentTitle}
            textStyle={styles.currentPaperTitle}
            accessibilityLabel={`${verb} ${progress.currentTitle}`}
          />
        </ToneSurface>
      ) : null}
      <View style={styles.progressRow}>
        <AnimatedProgressBar value={pct} color={t.mint} height={6} />
        <Text variant="caption" color={t.muted}>{progress.done} analyzed</Text>
      </View>
    </>
  );
}

export function BuildProgressBanner({
  progress,
  large,
  projectId,
}: {
  progress: GraphBuildState['progress'];
  large?: boolean;
  projectId?: string | null;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState(true);
  const { hint, showHint, dismissHint } = useBuildHint(progress);

  useEffect(() => {
    setExpanded(true);
    if (!projectId) return;
    let current = true;
    AsyncStorage.getItem(`rc.graph.buildDetails.${projectId}`)
      .then((value) => {
        if (current && value === 'collapsed') setExpanded(false);
      })
      .catch(() => {});
    return () => { current = false; };
  }, [projectId]);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (projectId) {
      void AsyncStorage.setItem(
        `rc.graph.buildDetails.${projectId}`,
        next ? 'expanded' : 'collapsed',
      );
    }
  };

  return (
    <Card style={[styles.banner, large && styles.bannerLarge]}>
      <Pressable
        onPress={toggleExpanded}
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} map build details`}
        accessibilityState={{ expanded }}
        style={styles.buildHeader}
      >
        <ToneIcon name="share-2" tone="mint" compact />
        <View style={styles.buildHeading}>
          <Text variant="overline" color={t.mint}>MAP BUILD</Text>
          <View style={styles.buildTitleRow}>
            <Text variant="heading" style={styles.buildTitle} numberOfLines={1}>Building map…</Text>
            {progress ? (
              <Text variant="caption" color={t.muted} numberOfLines={1}>
                {progress.ready} of {progress.total} ready
              </Text>
            ) : null}
          </View>
        </View>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={t.muted} />
      </Pressable>
      {progress && expanded ? (
        <View style={{ marginTop: space.md }}>
          <BuildProgressDetails
            progress={progress}
            hint={hint}
            onStepPress={showHint}
            onDismissHint={dismissHint}
          />
        </View>
      ) : null}
    </Card>
  );
}

function ErrorBanner({ detail, onDismiss }: { detail: string; onDismiss: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={[styles.banner, { borderColor: t.danger }]}>
      <Text variant="body" color={t.danger}>
        {detail}
      </Text>
      <Button title="Dismiss" variant="ghost" onPress={onDismiss} style={{ marginTop: space.sm }} />
    </Card>
  );
}

// DR-069 — Kamil: "UI taking up too much of graph real estate still." The old MAP BUILD banner
// (full-size, expanded by default) and FILTER card (a 56-64px summary that itself expanded
// inline) stacked above the canvas ate roughly half the screen on a build-in-progress map with
// real content already below it. Once a usable map exists, both collapse into one 48px
// segmented rail; each segment opens a bottom sheet instead of expanding in place. Designed via
// a codex session against a live emulator capture — see `docs/device-review-assets/DR-069/`.
export const MAP_SEARCH_PLACEHOLDER = 'Search the map, or explore a topic';

export function MapControlRail({
  building,
  progress,
  query,
  onQueryChange,
  onSubmitQuery,
  matchCount,
  showSearch,
  filters,
  filter,
  onFilterChange,
  visibleCount,
}: {
  building: boolean;
  progress: GraphBuildState['progress'];
  query: string;
  onQueryChange: (v: string) => void;
  /** DR-052 step 4: submit runs the paid Discover search with the text in the box. */
  onSubmitQuery?: () => void;
  /** How many map papers match the text, shown beside the explicit Search button. */
  matchCount?: number;
  showSearch: boolean;
  filters: { key: FilterKind; label: string }[];
  filter: FilterKind;
  onFilterChange: (f: FilterKind) => void;
  visibleCount: number;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [buildSheetOpen, setBuildSheetOpen] = useState(false);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const chosen = filters.find((item) => item.key === filter) ?? filters[0];
  // A search looks across every paper on the map, so while one is typed the default
  // "Significant" view is not what is on screen and must not be what the pill claims.
  const active = query.trim() && filter === 'significant'
    ? { key: filter, label: 'All matches' }
    : chosen;
  const { hint, showHint, dismissHint } = useBuildHint(progress);

  // The build segment disappears the moment a build finishes (that's the whole point — it's
  // what makes the rail shrink back to just the filter pill), so a sheet the reader had open
  // for it would otherwise linger with nothing left to show.
  useEffect(() => {
    if (!building) setBuildSheetOpen(false);
  }, [building]);

  return (
    <View style={styles.railWrap}>
      {showSearch ? (
        <View style={{ gap: space.xs }}>
          <TextInput
            value={query}
            onChangeText={onQueryChange}
            onSubmitEditing={onSubmitQuery}
            placeholder={MAP_SEARCH_PLACEHOLDER}
            placeholderTextColor={t.muted}
            style={styles.searchInput}
            autoCapitalize="none"
            returnKeyType="search"
            accessibilityLabel="Search the map or explore a topic"
            autoFocus
          />
          {query.trim() && onSubmitQuery ? (
            // The keyboard's Search key is easy to miss and the run it starts is paid work, so
            // the same action is also a visible button that says what it does.
            <View style={styles.searchActions}>
              <Text variant="caption" color={t.muted} style={{ flex: 1 }}>
                {matchCount === undefined
                  ? ''
                  : `${matchCount} on the map`}
              </Text>
              <Button
                title="Search for papers"
                icon="compass"
                variant="ghost"
                onPress={onSubmitQuery}
                accessibilityLabel="Search scholarly sources for papers on this topic"
              />
            </View>
          ) : null}
        </View>
      ) : null}
      <View style={styles.rail}>
        {building ? (
          <Pressable
            onPress={() => setBuildSheetOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Map build in progress${progress ? `, ${progress.done} of ${progress.ready} analyzed` : ''} — show details`}
            style={styles.railSegment}
          >
            <Icon name="share-2" size={16} color={t.mint} />
            <Text variant="label" color={t.mint} numberOfLines={1}>Building…</Text>
            {progress ? (
              <Text variant="caption" color={t.muted} numberOfLines={1}>
                {progress.done}/{progress.ready}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => setFilterSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Map filter: ${active?.label ?? filter}. ${visibleCount} ${visibleCount === 1 ? 'node' : 'nodes'} visible. Tap to change.`}
          style={styles.railSegment}
        >
          <Icon name="sliders" size={16} color={t.violet} />
          <Text variant="label" numberOfLines={1}>{active?.label ?? filter}</Text>
          <Text variant="caption" color={t.muted}>{visibleCount}</Text>
        </Pressable>
      </View>

      <BottomSheet visible={buildSheetOpen} onClose={() => setBuildSheetOpen(false)} scrollable>
        <View style={styles.sheetHeadRow}>
          <ToneIcon name="share-2" tone="mint" compact />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="overline" color={t.mint}>MAP BUILD</Text>
            <Text variant="heading" numberOfLines={1}>Building map…</Text>
          </View>
        </View>
        <View style={{ marginTop: space.md }}>
          <BuildProgressDetails
            progress={progress}
            hint={hint}
            onStepPress={showHint}
            onDismissHint={dismissHint}
          />
        </View>
      </BottomSheet>

      <BottomSheet visible={filterSheetOpen} onClose={() => setFilterSheetOpen(false)}>
        <Text variant="heading">Filter</Text>
        <Text variant="caption" color={t.muted} style={{ marginTop: 2, marginBottom: space.md }}>
          {visibleCount} {visibleCount === 1 ? 'node' : 'nodes'} visible
        </Text>
        <View style={styles.filterChips}>
          {filters.map((f) => (
            <Pressable
              key={f.key}
              onPress={() => { onFilterChange(f.key); setFilterSheetOpen(false); }}
              accessibilityRole="button"
              accessibilityState={{ selected: f.key === filter }}
              style={[styles.filterChipTarget, f.key === filter && styles.filterChipTargetActive]}
            >
              {f.key === filter ? <Icon name="check" size={15} color={t.mint} /> : null}
              <Text variant="label" color={f.key === filter ? t.mint : t.text}>{f.label}</Text>
            </Pressable>
          ))}
        </View>
      </BottomSheet>
    </View>
  );
}

export function GraphPagerOverlay({
  shown,
  total,
  canIncrease,
  canDecrease,
  hitCap = false,
  onIncrease,
  onDecrease,
}: {
  shown: number;
  total: number;
  canIncrease: boolean;
  canDecrease: boolean;
  hitCap?: boolean;
  onIncrease: () => void;
  onDecrease: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.pagerOverlay}>
      <View style={styles.pager}>
        <Pressable
          onPress={onDecrease}
          disabled={!canDecrease}
          hitSlop={8}
          accessibilityLabel="Show fewer papers"
          style={[styles.pagerBtn, !canDecrease && styles.pagerBtnDisabled]}
        >
          <Icon name="minus" size={14} color={canDecrease ? t.text : t.muted} />
        </Pressable>
        <Text variant="caption" color={t.muted} style={{ marginHorizontal: space.sm }}>
          Showing {shown} of {total}
        </Text>
        <Pressable
          onPress={onIncrease}
          disabled={!canIncrease}
          hitSlop={8}
          accessibilityLabel="Show more papers"
          style={[styles.pagerBtn, !canIncrease && styles.pagerBtnDisabled]}
        >
          <Icon name="plus" size={14} color={canIncrease ? t.text : t.muted} />
        </Pressable>
      </View>
      {hitCap ? (
        <Text variant="caption" color={t.muted} style={styles.pagerCap}>
          Capped at {MAX_VISIBLE} · narrow the filter or search
        </Text>
      ) : null}
    </View>
  );
}

function Centered({ text, loading, action }: { text?: string; loading?: boolean; action?: React.ReactNode }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.centered}>
      {loading ? (
        <ActivityIndicator color={t.mint} />
      ) : (
        <>
          <Text variant="body" color={t.muted} style={{ textAlign: 'center', marginBottom: space.md }}>
            {text}
          </Text>
          {action}
        </>
      )}
    </View>
  );
}

const makeStyles = (t: ThemePalette, density: DensityMode) => StyleSheet.create({
  combinedBody: { paddingBottom: space.xxl },
  mapStateRegion: { minHeight: 420 },
  graphViewport: { minHeight: 360 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  banner: { margin: space.md, marginBottom: 0 },
  retrievalIndicatorRow: { paddingHorizontal: space.md, paddingTop: space.sm, alignItems: 'flex-start' },
  retrievalIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: t.amberLine,
    backgroundColor: t.amberWash,
  },
  retrievalIndicatorGhost: {
    opacity: 0.45,
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    paddingHorizontal: 4,
  },
  bannerLarge: { width: '100%', margin: 0 },
  buildHeader: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  buildHeading: { flex: 1, minWidth: 0 },
  buildTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  buildTitle: { flex: 1, minWidth: 0 },
  buildHint: { marginTop: space.md, padding: density === 'tight' ? space.sm : space.md },
  currentPaper: { marginTop: space.sm, padding: density === 'tight' ? space.sm : space.md },
  currentPaperTitle: {
    color: t.text,
    fontFamily: fonts.bodyMedium,
    fontSize: density === 'tight' ? 13 : 14,
    lineHeight: density === 'tight' ? 18 : 20,
    marginTop: 2,
  },
  progressRow: { marginTop: space.md, gap: space.xs },
  pagerOverlay: {
    position: 'absolute',
    top: space.sm,
    right: space.md,
    alignItems: 'flex-end',
    gap: 4,
  },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.elevated,
  },
  pagerCap: {
    maxWidth: 220,
    textAlign: 'right',
    paddingHorizontal: space.xs,
  },
  pagerBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line2,
  },
  pagerBtnDisabled: { opacity: 0.4 },
  // DR-069 — the compact rail replacing the old full-width MAP BUILD banner + FILTER card.
  // `railWrap` holds the (optional) search input above the rail; `rail` is the 48px segmented
  // row itself, left-aligned and sized to its content rather than stretched full-width — a
  // filter-only rail (the common case once a build finishes) reads as a compact ~150px pill,
  // not a card spanning the screen.
  railWrap: { marginHorizontal: space.md, marginTop: space.sm, gap: space.sm },
  rail: { flexDirection: 'row', alignSelf: 'flex-start', gap: space.sm },
  railSegment: {
    height: 48,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.elevated,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sheetHeadRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  filterChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  filterChipTarget: {
    minHeight: 48,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.elevated,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  filterChipTargetActive: { borderColor: t.mint, backgroundColor: t.mintWash },
  searchActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  searchInput: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  attribution: {
    alignSelf: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  confirmationCard: { margin: space.md, marginBottom: 0 },
});
