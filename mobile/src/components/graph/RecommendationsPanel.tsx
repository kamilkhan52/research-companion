// Bottom-sheet listing external papers recommended for addition to the project, ranked by
// how many project papers cite them (and how significantly), plus a lightweight "bridge"
// signal. Tapping an entry opens its full detail; a dedicated button adds it straight to the
// reading list (unread, lazily retrieved later — same as any other paper) without leaving
// this sheet, since that's the whole point of a recommendation.

import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useAddPaper } from '@/api/queries';
import type { GraphRecommendation } from '@/api/types';
import { Card, Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

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
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text variant="title" style={{ marginBottom: 4 }}>
            Recommended additions
          </Text>
          <Text variant="caption" style={{ marginBottom: space.md }}>
            External papers your project's reading already leans on
          </Text>

          {recommendations.length === 0 ? (
            <Text variant="body" color={colors.muted} style={{ paddingVertical: space.xl, textAlign: 'center' }}>
              No strong recommendations yet — build (or rebuild) the graph once more papers have
              been read.
            </Text>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: '100%' }}>
              <View style={{ gap: space.sm, paddingBottom: space.xl }}>
                {recommendations.map((rec) => (
                  <RecommendationCard key={rec.id} pid={pid} rec={rec} onSelect={() => onSelect(rec)} />
                ))}
              </View>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
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

  async function handleAdd() {
    if (!pid || added) return;
    try {
      await addPaper.mutateAsync({ title: rec.title, arxivId: rec.arxiv_id ?? undefined });
      setAdded(true);
    } catch {
      // surfaced inline below via addPaper.isError; nothing else to do here
    }
  }

  return (
    <Pressable onPress={onSelect}>
      <Card style={styles.card}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Text variant="heading" numberOfLines={2}>
              {rec.title}
            </Text>
            {(rec.venue || rec.year) ? (
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

        <Pressable
          onPress={handleAdd}
          disabled={added || addPaper.isPending}
          hitSlop={6}
          style={[styles.addBtn, added && styles.addBtnDone]}
          accessibilityLabel={added ? `${rec.title} added to project` : `Add ${rec.title} to project`}>
          {addPaper.isPending ? (
            <ActivityIndicator size="small" color={colors.cyan} />
          ) : (
            <Text variant="caption" color={added ? colors.green : colors.cyan}>
              {added ? '✓ Added to reading list' : '+ Add to project'}
            </Text>
          )}
        </Pressable>
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
  scoreBadge: {
    borderWidth: 1,
    borderColor: colors.amber,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    minWidth: 44,
    alignItems: 'center',
  },
  addBtn: {
    marginTop: space.sm,
    height: 36,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnDone: { borderColor: colors.green },
});
