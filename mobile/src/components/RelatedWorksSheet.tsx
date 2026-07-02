// Bottom-sheet for a reading session: the paper's most significant related works (from the
// reference graph) — prior work it builds on / compares against, and project papers that build
// on it — each with the extracted reason it matters. In-project entries jump straight into
// that paper's discussion; external ones can be added to the reading list or opened at their
// source. The analyst's context lists the same entries, so it can say "see X in your Related
// works menu" and the menu will actually contain X.

import { useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useAddPaper, useRelatedWorks } from '@/api/queries';
import type { RelatedWork } from '@/api/types';
import { Card, Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

export function RelatedWorksSheet({
  pid,
  slug,
  visible,
  onClose,
  onOpenPaper,
}: {
  pid: string | null;
  slug: string | null;
  visible: boolean;
  onClose: () => void;
  onOpenPaper: (slug: string) => void;
}) {
  const related = useRelatedWorks(pid, slug, visible); // fetch only once the menu opens

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text variant="title" style={{ marginBottom: 4 }}>
            Related works
          </Text>
          <Text variant="caption" style={{ marginBottom: space.md }}>
            The works this paper leans on most, and project papers that build on it
          </Text>

          {related.isLoading ? (
            <ActivityIndicator color={colors.cyan} style={{ paddingVertical: space.xl }} />
          ) : !related.data?.length ? (
            <Text variant="body" color={colors.muted} style={{ paddingVertical: space.xl, textAlign: 'center' }}>
              Nothing yet — build the reference graph to populate this menu.
            </Text>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: '100%' }}>
              <View style={{ gap: space.sm, paddingBottom: space.xl }}>
                {related.data.map((work) => (
                  <RelatedCard key={work.id} pid={pid} work={work} onOpenPaper={onOpenPaper} />
                ))}
              </View>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function RelatedCard({
  pid,
  work,
  onOpenPaper,
}: {
  pid: string | null;
  work: RelatedWork;
  onOpenPaper: (slug: string) => void;
}) {
  const addPaper = useAddPaper(pid ?? '');
  const [added, setAdded] = useState(false);
  const inProject = work.kind === 'project' && !!work.slug;
  const link = work.url ?? (work.arxiv_id ? `https://arxiv.org/abs/${work.arxiv_id}` : null);
  const meta = [
    work.year ?? null,
    work.direction === 'builds_on' ? 'builds on it' : 'builds on this paper',
    inProject ? (work.list_status === 'read' ? 'in project · read' : 'in project') : 'external',
    work.citation_count ? `~${work.citation_count.toLocaleString()} citations` : null,
  ].filter(Boolean).join(' · ');

  async function handleAdd() {
    if (!pid || added) return;
    try {
      await addPaper.mutateAsync({ title: work.title, arxivId: work.arxiv_id ?? undefined });
      setAdded(true);
    } catch {
      // surfaced inline via addPaper.isError
    }
  }

  return (
    <Card style={styles.card}>
      <Text variant="heading" numberOfLines={2}>{work.title}</Text>
      <Text variant="caption" style={{ marginTop: 2 }}>{meta}</Text>
      {work.reason ? (
        <Text variant="caption" color={colors.text} style={{ marginTop: space.sm, opacity: 0.85 }}>
          {work.reason}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {inProject ? (
          <Pressable
            onPress={() => onOpenPaper(work.slug!)}
            style={styles.actionBtn}
            accessibilityLabel={`Open ${work.title}`}>
            <Text variant="caption" color={colors.cyan}>→ Open discussion</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handleAdd}
            disabled={added || addPaper.isPending}
            style={[styles.actionBtn, added && { borderColor: colors.green }]}
            accessibilityLabel={`Add ${work.title} to project`}>
            {addPaper.isPending ? (
              <ActivityIndicator size="small" color={colors.cyan} />
            ) : (
              <Text variant="caption" color={added ? colors.green : colors.cyan}>
                {added ? '✓ Added' : '+ Add to project'}
              </Text>
            )}
          </Pressable>
        )}
        {link ? (
          <Pressable
            onPress={() => Linking.openURL(link)}
            style={styles.actionBtn}
            accessibilityLabel={`Open source for ${work.title}`}>
            <Text variant="caption" color={colors.muted}>↗ Source</Text>
          </Pressable>
        ) : null}
      </View>
      {addPaper.isError ? (
        <Text variant="caption" color={colors.danger} style={{ marginTop: 4 }}>
          {(addPaper.error as Error).message}
        </Text>
      ) : null}
    </Card>
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
    maxHeight: '75%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line2,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  card: { borderColor: colors.line2 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  actionBtn: {
    height: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line2,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
});
