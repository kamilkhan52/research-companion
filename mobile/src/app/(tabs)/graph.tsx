// Reference Graph — a project-scoped screen showing how the project's papers cite each
// other and which external works they lean on, with a recommendation ranking for what to
// add next. Reachable from the Library's project bar. See app/graph.py for the pipeline.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { useGraph } from '@/api/queries';
import type { GraphEdge, GraphNode, GraphRecommendation, GraphRetrievalCandidate, GraphStatus } from '@/api/types';
import { BottomSheet } from '@/components/BottomSheet';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { NodeDetailSheet } from '@/components/graph/NodeDetailSheet';
import { RecommendationsPanel } from '@/components/graph/RecommendationsPanel';
import { TabHeader } from '@/components/TopBar';
import { canStartGraphBuild } from '@/graph/buildAvailability';
import { useGraphBuild, type GraphBuildState } from '@/hooks/useGraphBuild';
import { useActiveProject } from '@/store/project';
import { useGraphSettings } from '@/store/graphSettings';
import { Button, Card, Chip, Icon, Screen, Text } from '@/ui';
import { Marquee } from '@/ui/Marquee';
import { colors, fonts, radius, space } from '@/theme/tokens';

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
const PAGE_SIZE = 20;
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
  // `?focus=<slug>` (from the paper action sheet's "Show in Map") selects that node once
  // the graph is available; `t` is a per-tap nonce so re-focusing the same slug re-selects.
  const { focus, t: focusNonce } = useLocalSearchParams<{ focus?: string; t?: string }>();
  const { activePid } = useActiveProject();
  const graphQuery = useGraph(activePid);
  const build = useGraphBuild(activePid);
  const { allowAllFilter } = useGraphSettings();

  const [query, setQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [filter, setFilter] = useState<FilterKind>('significant');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [showRecs, setShowRecs] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);

  // A filter/search change (or switching to a different project's graph — this tab stays
  // mounted across the Library's project switch) starts a fresh page rather than keeping
  // whatever limit was reached browsing the previous set.
  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [filter, query, activePid]);

  const data = graphQuery.data;
  const graph = data?.graph ?? null;
  const recommendations = data?.recommendations ?? [];
  const status = data?.status ?? null;
  const showAllFilter = allowAllFilter || graph?.stage === 'skeleton';
  const filters = useMemo(
    () => (showAllFilter ? FILTERS : FILTERS.filter((f) => f.key !== 'all')),
    [showAllFilter],
  );

  // A metadata-only skeleton cannot have locally significant edges by design, so show its full
  // map instead of leaving the default Significant filter on an apparently empty canvas. Once
  // enrichment finishes, restore the normal Settings-controlled visibility of the All filter.
  useEffect(() => {
    if (graph?.stage === 'skeleton' && filter === 'significant') setFilter('all');
    else if (graph?.stage !== 'skeleton' && filter === 'all' && !allowAllFilter) {
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

  const filteredNodes = useMemo(() => {
    if (!graph) return [];
    let ns = graph.nodes;
    if (filter === 'project') ns = ns.filter((n) => n.kind === 'project');
    else if (filter === 'external') ns = ns.filter((n) => n.kind === 'external');
    else if (filter === 'significant') ns = ns.filter((n) => n.significant_cited_by_count > 0);
    const q = query.trim().toLowerCase();
    if (q) {
      ns = ns.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.authors.some((a) => a.toLowerCase().includes(q)) ||
          String(n.year ?? '').includes(q),
      );
    }
    return [...ns].sort(rankNode);
  }, [graph, filter, query]);

  const isFiltering = !!query.trim() || filter !== 'all';

  // What actually gets rendered: the current filter/search's matches, paginated (not "render all
  // and dim" — that rendered 700+ views even for the 'significant' tab, the cause of the slow
  // tabs). Edges are kept only between visible nodes.
  const pagedNodes = useMemo(() => filteredNodes.slice(0, visibleLimit), [filteredNodes, visibleLimit]);

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
  const showPager = filteredNodes.length > PAGE_SIZE;
  const canIncrease = visibleLimit < Math.min(MAX_VISIBLE, filteredNodes.length);
  const canDecrease = visibleLimit > PAGE_SIZE;
  const hitCap = visibleLimit >= MAX_VISIBLE && filteredNodes.length > pagedNodes.length;
  function increaseVisible() {
    setVisibleLimit((v) => Math.min(v + PAGE_SIZE, MAX_VISIBLE));
  }
  function decreaseVisible() {
    setVisibleLimit((v) => Math.max(v - PAGE_SIZE, PAGE_SIZE));
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

  function selectRecommendation(rec: GraphRecommendation) {
    setShowRecs(false);
    setSelectedNode(rec);
  }

  return (
    <Screen edges={['top']}>
      <TabHeader
        title="Map"
        subtitle={graph ? `${graph.nodes.length} papers · ${graph.edges.length} citations` : undefined}
        actions={[
          {
            name: 'search',
            onPress: () => {
              // Closing the search also clears it — a hidden query would silently keep
              // culling the canvas.
              setShowSearch((v) => {
                if (v) setQuery('');
                return !v;
              });
            },
            accessibilityLabel: showSearch ? 'Hide search' : 'Search papers',
          },
          {
            name: 'refresh-cw',
            badge: needsBuildAttention,
            onPress: () => {
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
                  `${reasons} ${needsEnrichment ? 'Continue' : 'Rebuild'} to process the affected papers.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Just refresh', onPress: () => void graphQuery.refetch() },
                    { text: needsEnrichment ? 'Continue' : 'Rebuild', onPress: () => build.run(false) },
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
          { name: 'zap', onPress: () => setShowRecs(true), accessibilityLabel: 'Recommendations' },
        ]}
      />

      {!activePid ? (
        <Centered text="No active project selected." />
      ) : graphQuery.isLoading ? (
        <Centered loading />
      ) : graphQuery.isError ? (
        <Centered
          text={(graphQuery.error as Error)?.message ?? 'Could not load the graph.'}
          action={<Button title="Retry" variant="ghost" onPress={() => graphQuery.refetch()} />}
        />
      ) : !graph ? (
        <EmptyBuildState status={status} build={build} />
      ) : (
        <>
          {build.building ? <BuildProgressBanner progress={build.progress} /> : null}

          {needsEnrichment ? <SkeletonResume build={build} /> : null}

          <RetrievalConfirmations candidates={retrievalCandidates} build={build} />

          <RetrievalErrors errors={retrievalErrors} build={build} />

          <FilterBar
            query={query}
            onQueryChange={setQuery}
            showSearch={showSearch}
            filters={filters}
            filter={filter}
            onFilterChange={setFilter}
            resultCount={isFiltering ? filteredNodes.length : null}
          />

          {showPager ? (
            <View style={styles.pager}>
              <Pressable
                onPress={decreaseVisible}
                disabled={!canDecrease}
                hitSlop={8}
                accessibilityLabel="Show fewer papers"
                style={[styles.pagerBtn, !canDecrease && styles.pagerBtnDisabled]}>
                <Icon name="minus" size={14} color={canDecrease ? colors.text : colors.muted} />
              </Pressable>
              <Text variant="caption" color={colors.muted} style={{ marginHorizontal: space.sm }}>
                Showing {pagedNodes.length} of {filteredNodes.length}
              </Text>
              <Pressable
                onPress={increaseVisible}
                disabled={!canIncrease}
                hitSlop={8}
                accessibilityLabel="Show more papers"
                style={[styles.pagerBtn, !canIncrease && styles.pagerBtnDisabled]}>
                <Icon name="plus" size={14} color={canIncrease ? colors.text : colors.muted} />
              </Pressable>
            </View>
          ) : null}
          {hitCap ? (
            <Text variant="caption" color={colors.muted} style={{ textAlign: 'center', marginTop: 4 }}>
              Capped at {MAX_VISIBLE} · narrow the filter or search to see the rest
            </Text>
          ) : null}

          <GraphCanvas
            nodes={visibleGraph.nodes}
            edges={visibleGraph.edges}
            selectedId={selectedNode?.id ?? null}
            highlightIds={null}
            onSelectNode={setSelectedNode}
            layoutAlgo={graph?.layout?.algo ?? null}
          />

          {hasSemanticScholarData ? (
            <Pressable
              onPress={() => void Linking.openURL('https://www.semanticscholar.org/')}
              accessibilityRole="link"
              accessibilityLabel="Open Semantic Scholar"
              style={styles.attribution}>
              <Text variant="caption" color={colors.muted}>
                Reference metadata provided by Semantic Scholar ↗
              </Text>
            </Pressable>
          ) : null}

          {build.error ? <ErrorBanner detail={build.error} onDismiss={build.clearError} /> : null}
        </>
      )}

      <NodeDetailSheet
        pid={activePid}
        node={selectedNode}
        edges={graph?.edges ?? []}
        nodesById={nodesById}
        onClose={() => setSelectedNode(null)}
        onOpenPaper={openPaper}
      />

      <RecommendationsPanel
        pid={activePid}
        visible={showRecs}
        recommendations={recommendations}
        onClose={() => setShowRecs(false)}
        onSelect={selectRecommendation}
      />
    </Screen>
  );
}

function EmptyBuildState({ status, build }: { status: GraphStatus | null; build: GraphBuildState }) {
  if (build.building) {
    return (
      <View style={styles.emptyWrap}>
        <BuildProgressBanner progress={build.progress} large />
      </View>
    );
  }
  return (
    <View style={styles.emptyWrap}>
      <Text variant="title" style={{ textAlign: 'center', marginBottom: space.sm }}>
        No reference graph yet
      </Text>
      <Text variant="body" color={colors.muted} style={{ textAlign: 'center', marginBottom: space.lg }}>
        {status
          ? status.semantic_scholar_enabled
            ? `Build a fast reference map for ${status.total_papers} paper${status.total_papers === 1 ? '' : 's'} ` +
              'from Semantic Scholar metadata, then retrieve missing full text when a confident arXiv source is available.'
            : `Build it from this project's ${status.total_papers} paper${status.total_papers === 1 ? '' : 's'}. ` +
              'Cached full text is analyzed directly; missing text is retrieved from arXiv when a source can be matched confidently.'
          : 'Papers are analyzed to find how they cite each other and which outside work they depend on.'}
      </Text>
      {build.error ? (
        <Text variant="caption" color={colors.danger} style={{ textAlign: 'center', marginBottom: space.md }}>
          {build.error}
        </Text>
      ) : null}
      <RetrievalConfirmations
        candidates={build.progress?.retrievalCandidates ?? status?.retrieval_candidates ?? {}}
        build={build}
      />
      <Button
        title="Build graph"
        onPress={() => build.run(false)}
        disabled={!canStartGraphBuild(status)}
      />
      {status && status.retrievable_papers === 0 ? (
        <Text variant="caption" style={{ marginTop: space.md, textAlign: 'center' }}>
          Missing papers will be matched through arXiv. You will be asked to confirm any ambiguous source.
        </Text>
      ) : null}
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
  const entries = Object.entries(candidates).filter(([, options]) => options.length > 0);
  if (!entries.length || build.building) return null;
  return (
    <Card style={styles.confirmationCard}>
      <Text variant="heading">Confirm paper sources</Text>
      <Text variant="caption" color={colors.muted} style={{ marginTop: space.xs }}>
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
  return (
    <Card style={styles.confirmationCard}>
      <Text variant="heading">Fast map ready</Text>
      <Text variant="caption" color={colors.muted} style={{ marginTop: space.xs }}>
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
          <Icon name="alert-circle" size={14} color={colors.amber} />
          {!dismissed ? (
            <Text variant="caption" color={colors.amber}>
              {entries.length} not retrieved
            </Text>
          ) : null}
        </Pressable>
      </View>
      <BottomSheet visible={open} onClose={() => setOpen(false)}>
        <Text variant="heading">Papers that could not be retrieved</Text>
        <Text variant="caption" color={colors.muted} style={{ marginTop: space.xs }}>
          The map still works; these papers just have no full text yet.
        </Text>
        <View style={{ marginTop: space.md, gap: space.sm }}>
          {entries.map(([slug, detail]) => (
            <View key={slug}>
              <Text variant="heading" style={{ fontSize: 14 }}>{slug}</Text>
              <Text variant="caption" color={colors.muted}>{detail}</Text>
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
  { key: 'metadata', label: 'Mapped', verb: 'Mapping references' },
  { key: 'retrieval', label: 'Retrieved', verb: 'Retrieving' },
  { key: 'extraction', label: 'Enriched', verb: 'Enriching' },
] as const;

export function BuildProgressBanner({ progress, large }: { progress: GraphBuildState['progress']; large?: boolean }) {
  const pct = progress && progress.ready > 0 ? progress.done / progress.ready : 0;
  const phaseIndex = Math.max(0, BUILD_STEPS.findIndex((s) => s.key === progress?.phase));
  const skeletonReady = progress?.graphStage === 'skeleton';
  const verb = BUILD_STEPS[phaseIndex]?.verb ?? 'Working';
  return (
    <Card style={[styles.banner, large && styles.bannerLarge]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <ActivityIndicator color={colors.mint} />
        <Text variant="heading" style={{ flex: 1 }} numberOfLines={1}>
          Building map…
        </Text>
        {/* The fast skeleton being usable is a state, not part of a sentence: a compact badge
            instead of a prefix glued onto whatever the worker is doing. */}
        {skeletonReady ? <Chip label="✓ Fast map ready" color={colors.mint} /> : null}
      </View>
      {progress ? (
        <>
          <View style={styles.buildStepsRow}>
            {BUILD_STEPS.map((step, i) => {
              const state = i < phaseIndex ? 'done' : i === phaseIndex ? 'active' : 'pending';
              return (
                <View key={step.key} style={styles.buildStep}>
                  {i > 0 ? (
                    <View style={[styles.buildStepLine, state !== 'pending' && styles.buildStepLineDone]} />
                  ) : null}
                  <View style={[styles.buildStepDot, state === 'done' && styles.buildStepDotDone]}>
                    {state === 'done' ? (
                      <Icon name="check" size={11} color={colors.mintInk} />
                    ) : state === 'active' ? (
                      <ActivityIndicator size="small" color={colors.mint} />
                    ) : null}
                  </View>
                  <Text variant="caption" color={state === 'pending' ? colors.muted : colors.text}>
                    {step.label}
                  </Text>
                </View>
              );
            })}
          </View>
          {progress.currentTitle ? (
            <View style={{ marginTop: space.sm }}>
              <Text variant="caption" color={colors.muted}>
                {verb}
              </Text>
              <Marquee
                text={progress.currentTitle}
                textStyle={{ color: colors.text, fontSize: 14, lineHeight: 20 }}
                accessibilityLabel={`${verb} ${progress.currentTitle}`}
              />
            </View>
          ) : null}
          <View style={[styles.progressTrack, { marginTop: space.sm }]}>
            <View style={[styles.progressFill, { width: `${Math.round(pct * 100)}%` }]} />
          </View>
          <Text variant="caption" style={{ marginTop: 4 }}>
            {progress.ready} of {progress.total} ready · {progress.done} analyzed
          </Text>
        </>
      ) : null}
    </Card>
  );
}

function ErrorBanner({ detail, onDismiss }: { detail: string; onDismiss: () => void }) {
  return (
    <Card style={[styles.banner, { borderColor: colors.danger }]}>
      <Text variant="body" color={colors.danger}>
        {detail}
      </Text>
      <Button title="Dismiss" variant="ghost" onPress={onDismiss} style={{ marginTop: space.sm }} />
    </Card>
  );
}

function FilterBar({
  query,
  onQueryChange,
  showSearch,
  filters,
  filter,
  onFilterChange,
  resultCount,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  showSearch: boolean;
  filters: { key: FilterKind; label: string }[];
  filter: FilterKind;
  onFilterChange: (f: FilterKind) => void;
  resultCount: number | null;
}) {
  return (
    <View style={styles.filterBar}>
      {showSearch ? (
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          placeholder="Search title, author, year…"
          placeholderTextColor={colors.muted}
          style={styles.searchInput}
          autoCapitalize="none"
          returnKeyType="search"
          autoFocus
        />
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.sm }}>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {filters.map((f) => (
            <Chip
              key={f.key}
              label={f.label}
              dot={false}
              selected={f.key === filter}
              onPress={() => onFilterChange(f.key)}
            />
          ))}
          {resultCount !== null ? (
            <View style={styles.resultCount}>
              <Text variant="caption">{resultCount} match{resultCount === 1 ? '' : 'es'}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function Centered({ text, loading, action }: { text?: string; loading?: boolean; action?: React.ReactNode }) {
  return (
    <View style={styles.centered}>
      {loading ? (
        <ActivityIndicator color={colors.mint} />
      ) : (
        <>
          <Text variant="body" color={colors.muted} style={{ textAlign: 'center', marginBottom: space.md }}>
            {text}
          </Text>
          {action}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
    borderColor: 'rgba(228, 184, 92, 0.4)',
    backgroundColor: 'rgba(228, 184, 92, 0.08)',
  },
  retrievalIndicatorGhost: {
    opacity: 0.45,
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    paddingHorizontal: 4,
  },
  buildStepsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: space.md,
  },
  buildStep: { alignItems: 'center', gap: 4, flex: 1 },
  buildStepLine: {
    position: 'absolute',
    top: 11,
    right: '50%',
    left: '-50%',
    height: 2,
    backgroundColor: colors.line,
    zIndex: -1,
  },
  buildStepLineDone: { backgroundColor: colors.mint },
  buildStepDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.line,
    backgroundColor: colors.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buildStepDotDone: { backgroundColor: colors.mint, borderColor: colors.mint },
  bannerLarge: { width: '100%', margin: 0 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.elevated,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.mint, borderRadius: 3 },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: space.sm,
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.elevated,
  },
  pagerBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line2,
  },
  pagerBtnDisabled: { opacity: 0.4 },
  filterBar: { paddingHorizontal: space.md, paddingTop: space.sm },
  searchInput: {
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  resultCount: { justifyContent: 'center', paddingHorizontal: 4 },
  attribution: {
    alignSelf: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  confirmationCard: { margin: space.md, marginBottom: 0 },
});
