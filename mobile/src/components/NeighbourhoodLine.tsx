// DR-052 PR 4 — the shared corpus-neighbourhood freshness line. It reflects the FORWARD-citation
// neighbourhood (which papers cite the reader's library, and when we last looked) — the graph
// store's per-anchor citer sets. Those are maintained by DISCOVERY (the citation chase + delta
// lane); the Map build does not touch them. So the line is Discover's domain: the Discover tab
// shows it and can refresh it (a re-run re-sweeps); the Map tab shows the same line read-only,
// and only once it exists, so the reader sees the shared substrate beneath the two tabs (spec
// docs/map-discover-merge-design.md) without the Map claiming to own a scan it doesn't run.
//
// A never-swept neighbourhood reads as an offer ("not scanned yet"), never as loss (DR-046).

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
  if (!n.ever_swept) return 'Neighbourhood not scanned yet';
  const age = relativeAge(n.age_seconds);
  // Guard the empty age (a malformed stored timestamp yields age_seconds null while ever_swept
  // stays true) so the line never renders "checked  · …" with a dangling separator.
  const parts = [age ? `Neighbourhood checked ${age}` : 'Neighbourhood checked recently'];
  if (n.total_papers > 0) parts.push(`${n.monitored} of ${n.total_papers} papers`);
  return parts.join(' · ');
}

/** `onRefresh` is the owning tab's refresh — only Discover passes one (a re-run re-sweeps the
 *  forward substrate). The Map passes none: it shows the line read-only, so it never offers to
 *  refresh a scan it doesn't run. */
export function NeighbourhoodLine({ neighbourhood, onRefresh, refreshLabel }: {
  neighbourhood: Neighbourhood | undefined;
  onRefresh?: () => void;
  refreshLabel?: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  if (!neighbourhood) return null;

  const stale = neighbourhood.time_stale;
  const notScanned = !neighbourhood.ever_swept;

  return (
    <View style={styles.row} testID="neighbourhood-line">
      <Icon
        name={notScanned ? 'circle' : stale ? 'refresh-cw' : 'check-circle'}
        size={13}
        color={stale ? t.amber : t.muted}
      />
      <Text variant="caption" color={t.muted} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
        {neighbourhoodSummary(neighbourhood)}
      </Text>
      {onRefresh ? (
        <Pressable
          onPress={onRefresh}
          accessibilityRole="button"
          accessibilityLabel={refreshLabel ?? 'Refresh the neighbourhood'}
          hitSlop={8}
          style={styles.action}
        >
          <Text variant="caption" color={t.mint}>{refreshLabel ?? 'Refresh'}</Text>
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
