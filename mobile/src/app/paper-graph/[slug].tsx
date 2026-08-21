// The per-paper reference graph (ego view): one paper at the centre, what it REFERENCES fanned
// to the left and what (on the reading list) CITES it to the right — a readable, structured
// layout server-computed in graph.paper_ego, rendered by the same GraphCanvas the full Map uses
// (which takes the server x/y directly, so no illegible force sim). External papers that cite it
// are reported as a count, since they live in the DR-052 forward substrate id-only.
//
// Reached from a paper's "Reference graph" action. A "See in full map" link jumps to the whole
// Map focused on this node, so nothing the old full-Map behaviour offered is lost.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { usePaperGraph } from '@/api/queries';
import type { GraphNode } from '@/api/types';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { NodeDetailSheet } from '@/components/graph/NodeDetailSheet';
import { TopBar } from '@/components/TopBar';
import { useActiveProject } from '@/store/project';
import { Button, Icon, Screen, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { space, type ThemePalette } from '@/theme/tokens';

export default function PaperGraphScreen() {
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { activePid: pid } = useActiveProject();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const query = usePaperGraph(pid, slug ?? null);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  const ego = query.data?.ego ?? null;
  const building = query.data?.build?.status === 'running';
  const centre = ego?.nodes.find((n) => n.id === ego.center_id) ?? null;
  const title = centre?.title ?? 'Reference graph';
  const nodesById = useMemo(
    () => Object.fromEntries((ego?.nodes ?? []).map((n) => [n.id, n])),
    [ego?.nodes],
  );

  const openFullMap = () =>
    router.replace(`/graph?focus=${encodeURIComponent(slug ?? '')}&t=${Date.now()}`);

  return (
    <Screen edges={['top']}>
      <TopBar
        title={title}
        subtitle="Reference graph"
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={openFullMap}
            accessibilityRole="link"
            accessibilityLabel="See in full map"
            hitSlop={8}
            style={styles.mapLink}>
            <Icon name="share-2" size={16} color={t.mint} />
          </Pressable>
        }
      />

      {ego ? (
        <>
          {/* One structured summary: what it builds on, what builds on it, and how many
              outside the library cite it. Distinguishable at a glance, matching the layout. */}
          <View style={styles.summary}>
            <SummaryStat icon="arrow-left" label="references" value={ego.references_count} tone={t.muted} />
            <SummaryStat icon="arrow-right" label="cite it here" value={ego.citers_count} tone={t.mint} />
            {ego.external_citer_count != null && ego.external_citer_count > 0 ? (
              <SummaryStat icon="globe" label="cite it elsewhere" value={ego.external_citer_count} tone={t.violet} />
            ) : null}
          </View>
          {ego.capped ? (
            <Text variant="caption" color={t.muted} style={styles.cappedNote}>
              Showing the most significant on each side.
            </Text>
          ) : null}

          <GraphCanvas
            nodes={ego.nodes}
            edges={ego.edges}
            selectedId={selected?.id ?? null}
            highlightIds={null}
            onSelectNode={setSelected}
            layoutAlgo={ego.layout.algo}
          />

          <NodeDetailSheet
            pid={pid}
            node={selected}
            edges={ego.edges}
            nodesById={nodesById}
            onClose={() => setSelected(null)}
            onOpenPaper={(s) => {
              setSelected(null);
              router.push(`/paper/${encodeURIComponent(s)}`);
            }}
          />
        </>
      ) : (
        <View style={styles.centered}>
          {query.isLoading || building ? (
            <>
              <ActivityIndicator color={t.mint} />
              <Text variant="caption" color={t.muted} style={{ marginTop: space.md }}>
                {building ? 'Building the reference map…' : 'Loading…'}
              </Text>
            </>
          ) : (
            // DR-046: absence is an offer, never loss. The ego view needs the built graph; if
            // it's not there, point to the Map where a build starts.
            <>
              <Text variant="heading" style={{ textAlign: 'center' }}>
                No reference map yet
              </Text>
              <Text variant="caption" color={t.muted} style={styles.emptyBody}>
                This paper joins the reference graph once you build the project’s map.
              </Text>
              <Button title="Open the Map" onPress={openFullMap} style={{ marginTop: space.lg }} />
            </>
          )}
        </View>
      )}
    </Screen>
  );
}

function SummaryStat({ icon, label, value, tone }: {
  icon: React.ComponentProps<typeof Icon>['name']; label: string; value: number; tone: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.stat}>
      <Icon name={icon} size={13} color={tone} />
      <Text variant="caption" color={t.text}>
        <Text variant="caption" color={t.text} style={{ fontWeight: '600' }}>{value}</Text> {label}
      </Text>
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  mapLink: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  summary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  stat: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  cappedNote: { paddingHorizontal: space.md, paddingTop: 2 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  emptyBody: { textAlign: 'center', marginTop: space.sm, maxWidth: 280 },
});
