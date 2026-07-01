// Bottom-sheet detail view for a tapped graph node: metadata, citation stats, which project
// papers cite it (with significance + a supporting excerpt), and — for a project paper node —
// what it in turn cites. Tapping a related project paper jumps straight to its Discussion.

import { Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { GraphEdge, GraphNode } from '@/api/types';
import { Chip, Text } from '@/ui';
import { colors, radius, space, stateMeta } from '@/theme/tokens';

export function NodeDetailSheet({
  node,
  edges,
  nodesById,
  onClose,
  onOpenPaper,
}: {
  node: GraphNode | null;
  edges: GraphEdge[];
  nodesById: Record<string, GraphNode>;
  onClose: () => void;
  onOpenPaper: (slug: string) => void;
}) {
  if (!node) return null;

  const citedBy = edges.filter((e) => e.target === node.id);
  const citesOthers = node.kind === 'project' ? edges.filter((e) => e.source === node.id) : [];
  const link =
    node.url || (node.arxiv_id ? `https://arxiv.org/abs/${node.arxiv_id}` : null) ||
    (node.doi ? `https://doi.org/${node.doi}` : null);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={styles.headerRow}>
              <Chip
                label={node.kind === 'project' ? 'In this project' : 'External reference'}
                color={node.kind === 'project' ? colors.cyan : colors.violet}
              />
              {node.kind === 'project' && node.list_status ? (
                <Chip
                  label={stateMeta[node.list_status]?.label ?? node.list_status}
                  color={stateMeta[node.list_status]?.color ?? colors.muted}
                />
              ) : null}
            </View>

            <Text variant="title" style={{ marginTop: space.sm }}>
              {node.title}
            </Text>

            {node.authors.length > 0 ? (
              <Text variant="caption" style={{ marginTop: 6 }}>
                {node.authors.slice(0, 6).join(', ')}
                {node.authors.length > 6 ? ', et al.' : ''}
              </Text>
            ) : null}
            {(node.venue || node.year) ? (
              <Text variant="caption" style={{ marginTop: 2 }}>
                {[node.venue, node.year].filter(Boolean).join(' · ')}
              </Text>
            ) : null}

            <View style={styles.statsRow}>
              <Stat label="Cited by" value={String(node.cited_by_project_count)} />
              <Stat label="Significant in" value={String(node.significant_cited_by_count)} />
              {node.kind === 'project' ? <Stat label="Cites" value={String(node.cites_count)} /> : null}
            </View>

            {link ? (
              <Pressable onPress={() => Linking.openURL(link)} style={styles.linkBtn}>
                <Text variant="heading" color={colors.cyan}>
                  ↗ Open source
                </Text>
              </Pressable>
            ) : null}

            {node.kind === 'project' ? (
              <Pressable onPress={() => node.slug && onOpenPaper(node.slug)} style={styles.discussBtn}>
                <Text variant="heading" color={colors.cyanInk}>
                  Open Discussion
                </Text>
              </Pressable>
            ) : null}

            {citedBy.length > 0 ? (
              <Section title={`Cited by (${citedBy.length})`}>
                {citedBy.map((edge, i) => (
                  <EdgeRow
                    key={i}
                    edge={edge}
                    otherNode={nodesById[edge.source]}
                    onPress={() => nodesById[edge.source]?.slug && onOpenPaper(nodesById[edge.source].slug!)}
                  />
                ))}
              </Section>
            ) : null}

            {citesOthers.length > 0 ? (
              <Section title={`Cites (${citesOthers.length})`}>
                {citesOthers.map((edge, i) => (
                  <EdgeRow
                    key={i}
                    edge={edge}
                    otherNode={nodesById[edge.target]}
                    onPress={() =>
                      nodesById[edge.target]?.kind === 'project' && nodesById[edge.target]?.slug
                        ? onOpenPaper(nodesById[edge.target].slug!)
                        : undefined
                    }
                  />
                ))}
              </Section>
            ) : null}

            <View style={{ height: space.xl }} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text variant="display" style={{ fontSize: 22 }}>
        {value}
      </Text>
      <Text variant="caption">{label}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: space.lg }}>
      <Text variant="label" style={{ marginBottom: space.sm }}>
        {title.toUpperCase()}
      </Text>
      <View style={{ gap: space.sm }}>{children}</View>
    </View>
  );
}

function EdgeRow({
  edge,
  otherNode,
  onPress,
}: {
  edge: GraphEdge;
  otherNode: GraphNode | undefined;
  onPress?: () => void;
}) {
  const tappable = !!onPress && otherNode?.kind === 'project';
  return (
    <Pressable
      onPress={tappable ? onPress : undefined}
      style={[styles.edgeRow, edge.significant && styles.edgeRowSignificant]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Text variant="heading" style={{ flex: 1 }} numberOfLines={2}>
          {otherNode?.title ?? '(unknown)'}
        </Text>
        {edge.significant ? <Chip label="Significant" color={colors.amber} /> : null}
      </View>
      {edge.reason ? (
        <Text variant="caption" style={{ marginBottom: edge.contexts.length ? 4 : 0 }}>
          {edge.reason}
        </Text>
      ) : null}
      {edge.contexts.slice(0, 1).map((ctx, i) => (
        <Text key={i} variant="mono" style={styles.context} numberOfLines={3}>
          "{ctx}"
        </Text>
      ))}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bg2,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    paddingBottom: space.xl,
    maxHeight: '85%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line2,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  headerRow: { flexDirection: 'row', gap: space.sm },
  statsRow: { flexDirection: 'row', gap: space.xl, marginTop: space.lg },
  stat: { alignItems: 'flex-start' },
  linkBtn: {
    marginTop: space.lg,
    height: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.panel2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discussBtn: {
    marginTop: space.sm,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  edgeRow: {
    backgroundColor: colors.panel,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
  },
  edgeRowSignificant: { borderColor: colors.amber },
  context: { color: colors.muted, marginTop: 2, fontStyle: 'italic' },
});
