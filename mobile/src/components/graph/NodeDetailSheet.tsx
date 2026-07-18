// Bottom-sheet detail view for a tapped graph node: metadata, citation stats, which project
// papers cite it (with significance + a supporting excerpt), and — for a project paper node —
// what it in turn cites. Tapping a related project paper jumps straight to its Discussion.
// An external node also gets a one-tap "Add to project" action here (not just from the
// Recommendations panel), since a user can reach any external node directly from the canvas.

import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';

import { useAddPaper, useProjectMembership } from '@/api/queries';
import type { GraphEdge, GraphNode } from '@/api/types';
import { BottomSheet } from '@/components/BottomSheet';
import { Chip, Icon, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, stateMetaFor, type ThemePalette } from '@/theme/tokens';
import { fullPaperUrl } from '@/lib/paperLinks';

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
    <BottomSheet
      visible
      onClose={onClose}
      maxHeightPct={85}
      scrollable
      style={{ paddingBottom: space.xl }}
    >
      {/* Keyed by node.id: this sheet stays mounted across different nodes (the parent just
         swaps the `node` prop), so per-node local state (e.g. "just added") must reset when
         the node changes rather than leaking from whichever node was viewed previously. */}
      <SheetContent key={node.id} pid={pid} node={node} edges={edges} nodesById={nodesById} onOpenPaper={onOpenPaper} />
    </BottomSheet>
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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const meta = stateMetaFor(t);
  const addPaper = useAddPaper(pid ?? '');
  const [added, setAdded] = useState(false);
  // The graph snapshot can lag the reading list (e.g. the paper was added from Discover a
  // moment ago): an "external" node that is already in the project must not offer Add.
  const { isInProject } = useProjectMembership(pid);
  const inProject = added || isInProject({ arxivId: node.arxiv_id, title: node.title });

  const citedBy = edges.filter((e) => e.target === node.id);
  const citesOthers = node.kind === 'project' ? edges.filter((e) => e.source === node.id) : [];
  const link = fullPaperUrl(node);

  async function handleAdd() {
    if (!pid || inProject) return;
    try {
      await addPaper.mutateAsync({
        title: node.title,
        arxivId: node.arxiv_id ?? undefined,
        year: node.year ?? undefined,
      });
      setAdded(true);
    } catch {
      // surfaced inline via addPaper.isError
    }
  }

  return (
    <>
      <View style={styles.headerRow}>
        <Chip
          label={node.kind === 'project' ? 'In this project' : 'External reference'}
          color={node.kind === 'project' ? t.mint : t.violet}
        />
        {node.kind === 'project' && node.list_status ? (
          <Chip
            label={meta[node.list_status]?.label ?? node.list_status}
            color={meta[node.list_status]?.color ?? t.muted}
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
      {node.venue || node.year ? (
        <Text variant="caption" style={{ marginTop: 2 }}>
          {[node.venue, node.year].filter(Boolean).join(' · ')}
        </Text>
      ) : null}

      <View style={styles.statsRow}>
        <Stat label="Cited in project" value={String(node.cited_by_project_count)} />
        <Stat label="Significant citations" value={String(node.significant_cited_by_count)} />
        {node.kind === 'project' ? <Stat label="Cites" value={String(node.cites_count)} /> : null}
        {typeof node.citation_count === 'number' ? (
          <Stat label="Overall citations" value={node.citation_count.toLocaleString()} />
        ) : null}
      </View>
      <Text variant="caption" color={t.muted} style={{ marginTop: space.sm }}>
        Significant: cited as a baseline, extension, or dependency
      </Text>

      {node.kind === 'project' ? (
        <Pressable onPress={() => node.slug && onOpenPaper(node.slug)} style={styles.discussBtn}>
          <Text variant="heading" color={t.mintInk}>
            Open Discussion
          </Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={handleAdd}
          disabled={inProject || addPaper.isPending}
          style={[styles.discussBtn, inProject && styles.discussBtnDone]}
          accessibilityLabel={inProject ? `${node.title} is in this project` : `Add ${node.title} to project`}
        >
          {addPaper.isPending ? (
            <ActivityIndicator color={t.mintInk} />
          ) : (
            <Text variant="heading" color={inProject ? t.mint : t.mintInk}>
              {added ? 'Added to reading list' : inProject ? 'Already in this project' : 'Add to project'}
            </Text>
          )}
        </Pressable>
      )}

      {link ? (
        <Pressable onPress={() => Linking.openURL(link)} style={styles.linkBtn}>
          <Icon name="external-link" size={16} color={t.text} />
          <Text variant="heading">Open full paper</Text>
        </Pressable>
      ) : null}
      {addPaper.isError ? (
        <Text variant="caption" color={t.danger} style={{ marginTop: space.sm }}>
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
    </>
  );
}

// Label sits ABOVE the number: number-first tiles read as one phrase across the row
// ("10 Significant in" instead of "Significant in: 10") when labels wrap or tiles sit close.
function Stat({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="caption">{label}</Text>
      <Text variant="title" style={{ fontSize: 24 }} color={t.violet}>
        {value}
      </Text>
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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const tappable = !!onPress && otherNode?.kind === 'project';
  return (
    <Pressable
      onPress={tappable ? onPress : undefined}
      style={[styles.edgeRow, edge.significant && styles.edgeRowSignificant]}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginBottom: 4,
        }}
      >
        <Text variant="heading" style={{ flex: 1 }} numberOfLines={2}>
          {otherNode?.title ?? '(unknown)'}
        </Text>
        {edge.significant ? <Chip label="Significant" color={t.amber} /> : null}
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

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  headerRow: { flexDirection: 'row', gap: space.sm },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, rowGap: space.md, marginTop: space.lg },
  stat: { alignItems: 'flex-start' },
  linkBtn: {
    marginTop: space.sm,
    height: 48,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.elevated,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  discussBtn: {
    marginTop: space.lg,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: t.mint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discussBtnDone: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.mint,
  },
  edgeRow: {
    backgroundColor: t.elevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: space.md,
  },
  edgeRowSignificant: { borderColor: t.amber },
  context: { color: t.muted, marginTop: 2, fontSize: 14, lineHeight: 20 },
});
