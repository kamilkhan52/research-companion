// Bottom-sheet for a reading session: the paper's most significant related works (from the
// reference graph) — prior work it builds on / compares against, and project papers that build
// on it — each with the extracted reason it matters. In-project entries jump straight into
// that paper's discussion; external ones can be added to the reading list or opened at their
// source. The analyst's context lists the same entries, so it can say "see X in your Related
// works menu" and the menu will actually contain X.

import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';

import { useAddPaper, useRelatedWorks } from '@/api/queries';
import type { RelatedWork } from '@/api/types';
import { BottomSheet } from '@/components/BottomSheet';
import { Card, Icon, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';
import { fullPaperUrl } from '@/lib/paperLinks';

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
  const t = useTheme();
  const related = useRelatedWorks(pid, slug, visible); // fetch only once the menu opens

  return (
    <BottomSheet visible={visible} onClose={onClose} scrollable>
      <Text variant="editorial" style={{ marginBottom: 4 }}>
        Related works
      </Text>
      <Text variant="caption" style={{ marginBottom: space.md }}>
        The works this paper leans on most, and project papers that build on it
      </Text>

      {related.isLoading ? (
        <ActivityIndicator color={t.mint} style={{ paddingVertical: space.xl }} />
      ) : !related.data?.length ? (
        <Text variant="body" color={t.muted} style={{ paddingVertical: space.xl, textAlign: 'center' }}>
          Nothing yet — build the reference graph to populate this menu.
        </Text>
      ) : (
        <View style={{ gap: space.sm, paddingBottom: space.xl }}>
          {related.data.map((work) => (
            <RelatedCard key={work.id} pid={pid} work={work} onOpenPaper={onOpenPaper} />
          ))}
        </View>
      )}
    </BottomSheet>
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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const addPaper = useAddPaper(pid ?? '');
  const [added, setAdded] = useState(false);
  const inProject = work.kind === 'project' && !!work.slug;
  const link = fullPaperUrl(work);
  const meta = [
    work.year ?? null,
    work.direction === 'builds_on' ? 'builds on it' : 'builds on this paper',
    inProject ? (work.list_status === 'read' ? 'in project · read' : 'in project') : 'external',
    work.citation_count ? `~${work.citation_count.toLocaleString()} citations` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  async function handleAdd() {
    if (!pid || added) return;
    try {
      await addPaper.mutateAsync({
        title: work.title,
        arxivId: work.arxiv_id ?? undefined,
        year: work.year ?? undefined,
      });
      setAdded(true);
    } catch {
      // surfaced inline via addPaper.isError
    }
  }

  return (
    <Card style={styles.card}>
      <Text variant="serifTitle" numberOfLines={3}>
        {work.title}
      </Text>
      <Text variant="caption" style={{ marginTop: 4 }}>
        {meta}
      </Text>
      {work.reason ? (
        <View style={{ marginTop: space.sm }}>
          <Text variant="label" color={t.violet}>
            Why it matters here
          </Text>
          <Text variant="body" style={{ marginTop: 2, fontSize: 14.5, lineHeight: 21 }}>
            {work.reason}
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        {inProject ? (
          <Pressable
            onPress={() => onOpenPaper(work.slug!)}
            style={[styles.actionBtn, styles.actionBtnPrimary]}
            accessibilityLabel={`Open ${work.title}`}
          >
            <Text variant="caption" color={t.mintInk} style={{ fontFamily: fonts.bodySemiBold }}>
              Open discussion
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handleAdd}
            disabled={added || addPaper.isPending}
            style={[styles.actionBtn, added ? { borderColor: t.mint } : styles.actionBtnPrimary]}
            accessibilityLabel={`Add ${work.title} to project`}
          >
            {addPaper.isPending ? (
              <ActivityIndicator size="small" color={t.mintInk} />
            ) : (
              <Text
                variant="caption"
                color={added ? t.mint : t.mintInk}
                style={added ? null : { fontFamily: fonts.bodySemiBold }}
              >
                {added ? 'Added' : 'Add to project'}
              </Text>
            )}
          </Pressable>
        )}
        {link ? (
          <Pressable
            onPress={() => Linking.openURL(link)}
            style={styles.actionBtn}
            accessibilityLabel={`Open full paper for ${work.title}`}
          >
            <Icon name="external-link" size={12} color={t.muted} />
            <Text variant="caption" color={t.muted}>
              Open full paper
            </Text>
          </Pressable>
        ) : null}
      </View>
      {addPaper.isError ? (
        <Text variant="caption" color={t.danger} style={{ marginTop: 4 }}>
          {(addPaper.error as Error).message}
        </Text>
      ) : null}
    </Card>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  card: { borderColor: t.line2 },
  actions: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.md,
    alignItems: 'center',
  },
  actionBtn: {
    height: 38,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.line2,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  // Mint fill for the card's main CTA (frame 06); mintInk text is only legible on this fill.
  actionBtnPrimary: { backgroundColor: t.mint, borderColor: t.mint },
});
