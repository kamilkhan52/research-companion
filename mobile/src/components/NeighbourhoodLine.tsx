// DR-052 PR 4 — the shared corpus-neighbourhood freshness line. Both the Map and the Discover
// tab render THIS, reading the one substrate they both maintain (the graph store's forward
// citer sets), so the reader sees the same "checked N ago · M of P monitored" on either tab —
// which is how the merge beneath the two tabs (spec docs/map-discover-merge-design.md) becomes
// visible without collapsing them into one screen.
//
// The two kinds of stale it distinguishes are the spec's (§1): composition-stale (papers added
// since the last sweep — exact, auto-fixed by the next run, shown as a gentle count) and
// time-stale (the world published new citers; the age of the last sweep, addressed by a
// refresh). A never-swept neighbourhood reads as an offer, never as loss (DR-046).

import { Pressable, StyleSheet, View } from 'react-native';

import type { Neighbourhood } from '@/api/endpoints';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { space, type ThemePalette } from '@/theme/tokens';
import { Icon, Text } from '@/ui';

/** Coarse, human relative age — this line is ambient context, not a clock. */
export function relativeAge(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 90) return 'just now';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  return weeks < 5 ? `${weeks}w ago` : `${Math.round(days / 30)}mo ago`;
}

export function neighbourhoodSummary(n: Neighbourhood): string {
  if (!n.ever_swept) return 'Neighbourhood not mapped yet';
  const parts = [`Neighbourhood checked ${relativeAge(n.age_seconds)}`];
  if (n.total_papers > 0) parts.push(`${n.monitored} of ${n.total_papers} papers`);
  return parts.join(' · ');
}

/** `onRefresh` is the tab's own refresh action (rebuild the map, or re-run Discover); the line
 *  labels it so a tap reads as refreshing the SHARED neighbourhood, not just this view. */
export function NeighbourhoodLine({ neighbourhood, onRefresh, refreshing = false, refreshLabel }: {
  neighbourhood: Neighbourhood | undefined;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshLabel?: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  if (!neighbourhood) return null;

  const stale = neighbourhood.time_stale;
  const added = neighbourhood.composition_stale;
  const notMapped = !neighbourhood.ever_swept;
  const tone = notMapped ? t.muted : stale ? t.amber : t.muted;

  return (
    <View style={styles.row} testID="neighbourhood-line">
      <Icon name={notMapped ? 'circle' : stale ? 'refresh-cw' : 'check-circle'} size={13} color={tone} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="caption" color={t.muted} numberOfLines={1}>
          {neighbourhoodSummary(neighbourhood)}
        </Text>
        {/* Composition-stale is shown as information, never a warning — the next run fixes it. */}
        {added > 0 && !notMapped ? (
          <Text variant="caption" color={t.muted} numberOfLines={1}>
            {added} newer paper{added === 1 ? '' : 's'} join on the next run
          </Text>
        ) : null}
      </View>
      {onRefresh ? (
        <Pressable
          onPress={onRefresh}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel={refreshLabel ?? 'Refresh the neighbourhood'}
          hitSlop={8}
          style={styles.action}
        >
          <Text variant="caption" color={refreshing ? t.muted : t.mint}>
            {refreshing ? 'Refreshing…' : refreshLabel ?? 'Refresh'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingVertical: space.xs,
  },
  action: { paddingHorizontal: space.sm, paddingVertical: 2 },
});
