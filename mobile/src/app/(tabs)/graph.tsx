// Reference Graph — a project-scoped screen showing how the project's papers cite each
// other and which external works they lean on, with a recommendation ranking for what to
// add next. Reachable from the Library's project bar. See app/graph.py for the pipeline.

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { useGraph } from '@/api/queries';
import type { GraphEdge, GraphNode, GraphRecommendation, GraphStatus } from '@/api/types';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { NodeDetailSheet } from '@/components/graph/NodeDetailSheet';
import { RecommendationsPanel } from '@/components/graph/RecommendationsPanel';
import { TabHeader } from '@/components/TopBar';
import { useGraphBuild, type GraphBuildState } from '@/hooks/useGraphBuild';
import { useActiveProject } from '@/store/project';
import { Button, Card, Chip, Screen, Text } from '@/ui';
import { colors, fonts, radius, space } from '@/theme/tokens';

type FilterKind = 'all' | 'project' | 'external' | 'significant';

const FILTERS: { key: FilterKind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'project', label: 'In project' },
  { key: 'external', label: 'External' },
  { key: 'significant', label: 'Significant' },
];

export default function GraphScreen() {
  const router = useRouter();
  const { activePid } = useActiveProject();
  const graphQuery = useGraph(activePid);
  const build = useGraphBuild(activePid);

  const [query, setQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [filter, setFilter] = useState<FilterKind>('all');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [showRecs, setShowRecs] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const data = graphQuery.data;
  const graph = data?.graph ?? null;
  const recommendations = data?.recommendations ?? [];
  const status = data?.status ?? null;

  // Recover in-progress builds on (re)open: if loading the graph reveals a build still running
  // server-side (e.g. the app was minimized during it), re-attach to it so the progress UI
  // shows live status again instead of the "no graph yet" state. resume() is a no-op unless
  // the job is actually running, and is idempotent if we're already polling it.
  const resumeBuild = build.resume;
  useEffect(() => {
    resumeBuild(data?.build);
  }, [data?.build, resumeBuild]);

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
    return ns;
  }, [graph, filter, query]);

  const isFiltering = !!query.trim() || filter !== 'all';

  // What actually gets rendered. A filter/search CULLS to the matching nodes (not "render all
  // and dim" — that was rendering 700+ views even for the 'significant' tab, the cause of the
  // slow tabs). With no filter we default to a focused subgraph (project papers + significant /
  // well-connected externals) unless "show all" is on. Edges are kept only between visible nodes.
  const visibleGraph = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    const withEdges = (keep: Set<string>, ns: GraphNode[]) => ({
      nodes: ns,
      edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    });
    if (isFiltering) return withEdges(new Set(filteredNodes.map((n) => n.id)), filteredNodes);
    if (showAll) return { nodes: graph.nodes, edges: graph.edges };
    const keep = new Set<string>();
    for (const n of graph.nodes) {
      if (n.kind === 'project' || n.significant_cited_by_count > 0 || n.cited_by_project_count >= 2) {
        keep.add(n.id);
      }
    }
    return withEdges(keep, graph.nodes.filter((n) => keep.has(n.id)));
  }, [graph, isFiltering, filteredNodes, showAll]);

  const staleCount = status?.stale_papers.length ?? 0;

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
            badge: staleCount > 0,
            onPress: () => {
              if (staleCount > 0) {
                Alert.alert(
                  'Rebuild reference graph?',
                  `${staleCount} paper${staleCount === 1 ? '' : 's'} changed since the last build.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Just refresh', onPress: () => void graphQuery.refetch() },
                    { text: 'Rebuild', onPress: () => build.run(false) },
                  ],
                );
              } else {
                void graphQuery.refetch();
              }
            },
            accessibilityLabel: staleCount > 0 ? 'Refresh graph (rebuild available)' : 'Refresh graph',
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

          <FilterBar
            query={query}
            onQueryChange={setQuery}
            showSearch={showSearch}
            filter={filter}
            onFilterChange={setFilter}
            resultCount={isFiltering ? filteredNodes.length : null}
          />

          {!isFiltering && graph.nodes.length > visibleGraph.nodes.length ? (
            <Pressable onPress={() => setShowAll((v) => !v)} style={styles.focusToggle}>
              <Text variant="caption" color={colors.mint}>
                {showAll
                  ? `Showing all ${graph.nodes.length} · tap to focus`
                  : `Focused: ${visibleGraph.nodes.length} key papers · tap to show all ${graph.nodes.length}`}
              </Text>
            </Pressable>
          ) : null}

          <GraphCanvas
            nodes={visibleGraph.nodes}
            edges={visibleGraph.edges}
            selectedId={selectedNode?.id ?? null}
            highlightIds={null}
            onSelectNode={setSelectedNode}
          />

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
          ? `Build it from this project's ${status.retrievable_papers} paper${status.retrievable_papers === 1 ? '' : 's'}. ` +
            'Each paper is read once by an LLM to extract its bibliography and how significantly it uses each ' +
            'reference — the result is cached, so future rebuilds only cost tokens on papers that changed.'
          : 'Papers are analyzed to find how they cite each other and which outside work they depend on.'}
      </Text>
      {build.error ? (
        <Text variant="caption" color={colors.danger} style={{ textAlign: 'center', marginBottom: space.md }}>
          {build.error}
        </Text>
      ) : null}
      <Button title="Build graph" onPress={() => build.run(false)} disabled={!status || status.retrievable_papers === 0} />
      {status && status.retrievable_papers === 0 ? (
        <Text variant="caption" style={{ marginTop: space.md, textAlign: 'center' }}>
          No papers in this project have cached full text yet — open one in Discussion first.
        </Text>
      ) : null}
    </View>
  );
}

function BuildProgressBanner({ progress, large }: { progress: GraphBuildState['progress']; large?: boolean }) {
  const pct = progress && progress.total > 0 ? progress.done / progress.total : 0;
  return (
    <Card style={[styles.banner, large && styles.bannerLarge]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <ActivityIndicator color={colors.mint} />
        <Text variant="heading" style={{ flex: 1 }} numberOfLines={1}>
          {progress?.currentTitle ? `Analyzing "${progress.currentTitle}"…` : 'Building graph…'}
        </Text>
      </View>
      {progress ? (
        <>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(pct * 100)}%` }]} />
          </View>
          <Text variant="caption" style={{ marginTop: 4 }}>
            {progress.done} / {progress.total} papers
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
  filter,
  onFilterChange,
  resultCount,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  showSearch: boolean;
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
          {FILTERS.map((f) => (
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
  bannerLarge: { width: '100%', margin: 0 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.elevated,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.mint, borderRadius: 3 },
  focusToggle: {
    alignSelf: 'center',
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.elevated,
  },
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
});
