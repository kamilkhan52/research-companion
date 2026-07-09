// Bottom-sheet detail view for a tapped graph node: metadata, citation stats, which project
// papers cite it (with significance + a supporting excerpt), and — for a project paper node —
// what it in turn cites. Tapping a related project paper jumps straight to its Discussion.
// An external node also gets a one-tap "Add to project" action here (not just from the
// Recommendations panel), since a user can reach any external node directly from the canvas.

import { useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useAddPaper } from '@/api/queries';
import type { GraphEdge, GraphNode } from '@/api/types';
import { Chip, Icon, Text } from '@/ui';
import { colors, radius, space, stateMeta } from '@/theme/tokens';

export function NodeDetailSheet({
  pid,
  node,
  edges,
  nodesById,
  onClose,
  onOpenPaper,
}: {
  pid: string | null;
  node: GraphNode | null;
  edges: GraphEdge[];
  nodesById: Record<string, GraphNode>;
  onClose: () => void;
  onOpenPaper: (slug: string) => void;
}) {
  if (!node) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Keyed by node.id: this sheet stays mounted across different nodes (the parent just
           swaps the `node` prop), so per-node local state (e.g. "just added") must reset when
           the node changes rather than leaking from whichever node was viewed previously. */}
        <SheetContent
          key={node.id}
          pid={pid}
          node={node}
          edges={edges}
          nodesById={nodesById}
          onOpenPaper={onOpenPaper}
        />
      </Pressable>
    </Modal>
  );
}

function SheetContent({
  pid,
  node,
  edges,
  nodesById,
  onOpenPaper,
}: {
  pid: string | null;
  node: GraphNode;
  edges: GraphEdge[];
  nodesById: Record<string, GraphNode>;
  onOpenPaper: (slug: string) => void;
}) {
  const addPaper = useAddPaper(pid ?? '');
  const [added, setAdded] = useState(false);

  const citedBy = edges.filter((e) => e.target === node.id);
  const citesOthers = node.kind === 'project' ? edges.filter((e) => e.source === node.id) : [];
  const link =
    node.url || (node.arxiv_id ? `https://arxiv.org/abs/${node.arxiv_id}` : null) ||
    (node.doi ? `https://doi.org/${node.doi}` : null);

  async function handleAdd() {
    if (!pid || added) return;
    try {
      await addPaper.mutateAsync({ title: node.title, arxivId: node.arxiv_id ?? undefined });
      setAdded(true);
    } catch {
      // surfaced inline via addPaper.isError
    }
  }

  return (
    <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
      <View style={styles.handle} />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <Chip
            label={node.kind === 'project' ? 'In this project' : 'External reference'}
            color={node.kind === 'project' ? colors.mint : colors.violet}
          />
          {node.kind === 'project' && node.list_status ? (
            <Chip
              label={stateMeta[node.list_status]?.label ?? node.list_status}
              color={stateMeta[node.list_status]?.color ?? colors.muted}
            />
          ) : null}
        </View>

        <Text variant="editorial" style={{ marginTop: space.sm }}>
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
          {typeof node.citation_count === 'number' ? (
            <Stat label="Citations overall" value={node.citation_count.toLocaleString()} />
          ) : null}
        </View>

        {node.kind === 'project' ? (
          <Pressable onPress={() => node.slug && onOpenPaper(node.slug)} style={styles.discussBtn}>
            <Text variant="heading" color={colors.mintInk}>
              Open Discussion
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handleAdd}
            disabled={added || addPaper.isPending}
            style={[styles.discussBtn, added && styles.discussBtnDone]}
            accessibilityLabel={added ? `${node.title} added to project` : `Add ${node.title} to project`}>
            {addPaper.isPending ? (
              <ActivityIndicator color={colors.mintInk} />
            ) : (
              <Text variant="heading" color={added ? colors.mint : colors.mintInk}>
                {added ? 'Added to reading list' : 'Add to project'}
              </Text>
            )}
          </Pressable>
        )}

        {link ? (
          <Pressable onPress={() => Linking.openURL(link)} style={styles.linkBtn}>
            <Icon name="external-link" size={16} color={colors.text} />
            <Text variant="heading">Open source</Text>
          </Pressable>
        ) : null}
        {addPaper.isError ? (
          <Text variant="caption" color={colors.danger} style={{ marginTop: space.sm }}>
            {(addPaper.error as Error).message}
          </Text>
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
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text variant="title" style={{ fontSize: 24 }} color={colors.violet}>
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
        <Text key={i} variant="serifItalic" style={styles.context} numberOfLines={3}>
          “{ctx}”
        </Text>
      ))}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
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
    marginTop: space.sm,
    height: 48,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.elevated,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  discussBtn: {
    marginTop: space.lg,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: colors.mint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discussBtnDone: { backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.mint },
  edgeRow: {
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
  },
  edgeRowSignificant: { borderColor: colors.amber },
  context: { color: colors.muted, marginTop: 2, fontSize: 14, lineHeight: 20 },
});
