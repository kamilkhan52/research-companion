// Reference Graph — a project-scoped screen showing how the project's papers cite each
// other and which external works they lean on, with a recommendation ranking for what to
// add next. Reachable from the Library's project bar. See app/graph.py for the pipeline.

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { useGraph } from '@/api/queries';
import type { GraphEdge, GraphNode, GraphRecommendation, GraphStatus } from '@/api/types';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { NodeDetailSheet } from '@/components/graph/NodeDetailSheet';
import { RecommendationsPanel } from '@/components/graph/RecommendationsPanel';
import { IconButton, TopBar } from '@/components/TopBar';
import { useGraphBuild, type GraphBuildState } from '@/hooks/useGraphBuild';
import { useActiveProject } from '@/store/project';
import { Button, Card, Screen, Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

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
  const highlightIds = useMemo(
    () => (isFiltering ? new Set(filteredNodes.map((n) => n.id)) : null),
    [isFiltering, filteredNodes],
  );

  // Perf: the graph can be 700+ nodes (mostly single-citation external leaves). By default we
  // render a focused subgraph — the project papers plus the external works that are significant
  // or cited by 2+ project papers — which is both far faster (the layout is O(n²)) and more
  // readable. Searching or an explicit "Show all" renders everything. Edges are kept only
  // between visible nodes.
  const renderAll = showAll || isFiltering;
  const visibleGraph = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    if (renderAll) return { nodes: graph.nodes, edges: graph.edges };
    const keep = new Set<string>();
    for (const n of graph.nodes) {
      if (n.kind === 'project' || n.significant_cited_by_count > 0 || n.cited_by_project_count >= 2) {
        keep.add(n.id);
      }
    }
    return {
      nodes: graph.nodes.filter((n) => keep.has(n.id)),
      edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }, [graph, renderAll]);

  function openPaper(slug: string) {
    setSelectedNode(null);
    router.push(`/paper/${encodeURIComponent(slug)}`);
  }

  function selectRecommendation(rec: GraphRecommendation) {
    setShowRecs(false);
    setSelectedNode(rec);
  }

  const staleCount = status?.stale_papers.length ?? 0;

  return (
    <Screen edges={['top']}>
      <TopBar
        title="Reference Graph"
        subtitle={graph ? `${graph.nodes.length} papers · ${graph.edges.length} citations` : undefined}
        onBack={() => router.back()}
        right={
          <>
            <IconButton
              glyph="↻"
              onPress={() => graphQuery.refetch()}
              accessibilityLabel="Refresh graph"
            />
            <IconButton glyph="✦" onPress={() => setShowRecs(true)} accessibilityLabel="Recommendations" />
          </>
        }
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
          {build.building ? (
            <BuildProgressBanner progress={build.progress} />
          ) : staleCount > 0 ? (
            <StaleBanner count={staleCount} onRebuild={() => build.run(false)} />
          ) : null}

          <FilterBar
            query={query}
            onQueryChange={setQuery}
            filter={filter}
            onFilterChange={setFilter}
            resultCount={isFiltering ? filteredNodes.length : null}
          />

          {!isFiltering && graph.nodes.length > visibleGraph.nodes.length ? (
            <Pressable onPress={() => setShowAll((v) => !v)} style={styles.focusToggle}>
              <Text variant="caption" color={colors.cyan}>
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
            highlightIds={highlightIds}
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
        <ActivityIndicator color={colors.cyan} />
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

function StaleBanner({ count, onRebuild }: { count: number; onRebuild: () => void }) {
  return (
    <Card style={styles.banner}>
      <Text variant="body">
        {count} paper{count === 1 ? '' : 's'} changed since the graph was last built.
      </Text>
      <Button title="Rebuild" variant="ghost" onPress={onRebuild} style={{ marginTop: space.sm }} />
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
  filter,
  onFilterChange,
  resultCount,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  filter: FilterKind;
  onFilterChange: (f: FilterKind) => void;
  resultCount: number | null;
}) {
  return (
    <View style={styles.filterBar}>
      <TextInput
        value={query}
        onChangeText={onQueryChange}
        placeholder="Search title, author, year…"
        placeholderTextColor={colors.muted}
        style={styles.searchInput}
        autoCapitalize="none"
        returnKeyType="search"
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.sm }}>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <Pressable
                key={f.key}
                onPress={() => onFilterChange(f.key)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Filter: ${f.label}`}
                accessibilityState={{ selected: active }}
                style={[styles.filterChip, active && styles.filterChipActive]}>
                <Text variant="caption" color={active ? colors.cyan : colors.muted}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
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
        <ActivityIndicator color={colors.cyan} />
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
    backgroundColor: colors.panel2,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.cyan, borderRadius: 3 },
  focusToggle: {
    alignSelf: 'center',
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.panel2,
  },
  filterBar: { paddingHorizontal: space.md, paddingTop: space.sm },
  searchInput: {
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    color: colors.text,
    fontFamily: 'Manrope_400Regular',
    fontSize: 14,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line2,
  },
  filterChipActive: { borderColor: colors.cyan },
  resultCount: { justifyContent: 'center', paddingHorizontal: 4 },
});
