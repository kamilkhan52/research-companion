// Bottom-sheet listing external papers recommended for addition to the project, ranked by
// how many project papers cite them (and how significantly), plus a lightweight "bridge"
// signal. Tapping an entry opens its full detail (reuses the same node detail sheet via a
// callback, so provenance/context stays one tap away).

import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { GraphRecommendation } from '@/api/types';
import { Card, Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

export function RecommendationsPanel({
  visible,
  recommendations,
  onClose,
  onSelect,
}: {
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
                  <Pressable key={rec.id} onPress={() => onSelect(rec)}>
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
                    </Card>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
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
});
