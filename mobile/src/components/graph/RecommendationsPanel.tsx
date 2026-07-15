// Bottom-sheet listing external papers recommended for addition to the project, ranked by
// how many project papers cite them (and how significantly), plus a lightweight "bridge"
// signal. Tapping an entry opens its full detail; a dedicated button adds it straight to the
// reading list (unread, lazily retrieved later — same as any other paper) without leaving
// this sheet, since that's the whole point of a recommendation.

import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useAddPaper, useProjectMembership } from '@/api/queries';
import type { GraphRecommendation } from '@/api/types';
import { BottomSheet } from '@/components/BottomSheet';
import { fullPaperUrl } from '@/lib/paperLinks';
import { Button, Card, Icon, Text } from '@/ui';
import { colors, fonts, radius, space } from '@/theme/tokens';

// Shown a page at a time rather than the full ranked list at once — a project can accumulate
// well over a hundred candidate recommendations, most of which are low-signal tail entries.
const PAGE_SIZE = 20;
const MAX_VISIBLE = 100;

export function RecommendationsPanel({
  pid,
  visible,
  recommendations,
  onClose,
  onSelect,
}: {
  pid: string | null;
  visible: boolean;
  recommendations: GraphRecommendation[];
  onClose: () => void;
  onSelect: (rec: GraphRecommendation) => void;
}) {
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);

  // Fresh page each time the sheet is (re)opened, not wherever browsing left off last time —
  // also on a project switch, since this stays mounted and `visible` can stay true across one
  // (the sheet doesn't force-close just because the active project changed underneath it).
  useEffect(() => {
    if (visible) setVisibleLimit(PAGE_SIZE);
  }, [visible, pid]);

  const pageRecs = recommendations.slice(0, visibleLimit);
  const canShowMore = visibleLimit < Math.min(MAX_VISIBLE, recommendations.length);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text variant="editorial" style={{ marginBottom: 4 }}>
        Recommended additions
      </Text>
      <Text variant="caption" style={{ marginBottom: space.md }}>
        High-signal papers connected to your project
      </Text>

      {recommendations.length === 0 ? (
        <Text variant="body" color={colors.muted} style={{ paddingVertical: space.xl, textAlign: 'center' }}>
          No strong recommendations yet — build (or rebuild) the graph once more papers have been read.
        </Text>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 1, minHeight: 0 }}>
          <View style={{ gap: space.sm, paddingBottom: space.xl }}>
            {pageRecs.map((rec) => (
              <RecommendationCard key={rec.id} pid={pid} rec={rec} onSelect={() => onSelect(rec)} />
            ))}
            {canShowMore ? (
              <Button
                title={`Show more (${pageRecs.length} of ${recommendations.length})`}
                variant="ghost"
                onPress={() => setVisibleLimit((v) => Math.min(v + PAGE_SIZE, MAX_VISIBLE))}
              />
            ) : null}
          </View>
        </ScrollView>
      )}
    </BottomSheet>
  );
}

function RecommendationCard({
  pid,
  rec,
  onSelect,
}: {
  pid: string | null;
  rec: GraphRecommendation;
  onSelect: () => void;
}) {
  const addPaper = useAddPaper(pid ?? '');
  const [added, setAdded] = useState(false);
  // Recommendations come from the last graph build; membership must track the LIVE reading
  // list so papers added since (from any surface) stop offering "+ Add".
  const { isInProject } = useProjectMembership(pid);
  const inProject = added || isInProject({ arxivId: rec.arxiv_id, title: rec.title });
  const paperUrl = fullPaperUrl(rec);

  async function handleAdd() {
    if (!pid || inProject) return;
    try {
      await addPaper.mutateAsync({
        title: rec.title,
        arxivId: rec.arxiv_id ?? undefined,
        year: rec.year ?? undefined,
      });
      setAdded(true);
    } catch {
      // surfaced inline below via addPaper.isError; nothing else to do here
    }
  }

  return (
    <Pressable onPress={onSelect}>
      <Card style={styles.card}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: space.sm,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text variant="heading" numberOfLines={2}>
              {rec.title}
            </Text>
            {rec.venue || rec.year ? (
              <Text variant="caption" style={{ marginTop: 2 }}>
                {[rec.venue, rec.year].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
          </View>
          <View style={styles.scoreBadge}>
            <Text variant="heading" color={colors.amber}>
              {rec.recommend_score.toFixed(1)}
            </Text>
          </View>
        </View>

        <View style={{ marginTop: space.sm, gap: 3 }}>
          {rec.recommend_reasons.map((reason, i) => (
            <Text key={i} variant="caption" color={colors.text} style={{ opacity: 0.85 }}>
              • {reason}
            </Text>
          ))}
        </View>

        <View style={styles.actions}>
          {paperUrl ? (
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                void Linking.openURL(paperUrl).catch(() => undefined);
              }}
              style={styles.paperBtn}
              accessibilityLabel={`Open full paper for ${rec.title}`}
            >
              <Icon name="external-link" size={13} color={colors.muted} />
              <Text variant="caption">Full paper</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={(event) => {
              event.stopPropagation();
              void handleAdd();
            }}
            disabled={inProject || addPaper.isPending}
            hitSlop={6}
            style={[styles.addBtn, inProject && styles.addBtnDone]}
            accessibilityLabel={inProject ? `${rec.title} is in this project` : `Add ${rec.title} to project`}
          >
            {addPaper.isPending ? (
              <ActivityIndicator size="small" color={colors.mintInk} />
            ) : (
              <Text
                variant="caption"
                color={inProject ? colors.mint : colors.mintInk}
                style={inProject ? null : { fontFamily: fonts.bodySemiBold }}
              >
                {added ? 'Added to reading list' : inProject ? 'In project' : '+ Add'}
              </Text>
            )}
          </Pressable>
        </View>
        {addPaper.isError ? (
          <Text variant="caption" color={colors.danger} style={{ marginTop: 4 }}>
            {(addPaper.error as Error).message}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderColor: colors.line2 },
  scoreBadge: {
    borderWidth: 1,
    borderColor: colors.amber,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    minWidth: 44,
    alignItems: 'center',
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.md },
  paperBtn: {
    height: 40,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line2,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtn: {
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.mint,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnDone: {
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.mint,
  },
});
