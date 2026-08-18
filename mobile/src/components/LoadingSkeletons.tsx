import { StyleSheet, View } from 'react-native';

import { Skeleton, SkeletonGroup } from '@/components/Skeleton';
import { radius, space } from '@/theme/tokens';

function PaperRowSkeleton() {
  return (
    <View style={styles.paperRow}>
      <Skeleton width={54} height={70} radius={radius.md} />
      <View style={styles.grow}>
        <Skeleton width="88%" height={18} />
        <Skeleton width="62%" height={13} />
        <Skeleton width="42%" height={11} />
      </View>
    </View>
  );
}

export function LibraryLoadingSkeleton() {
  return (
    <SkeletonGroup label="Loading your library" style={styles.stack} testID="library-loading-skeleton">
      <View style={styles.card}>
        <View style={styles.between}>
          <Skeleton width="38%" height={18} />
          <Skeleton width="28%" height={12} />
        </View>
        <Skeleton height={6} radius={radius.pill} />
      </View>
      <View style={styles.chips}>
        <Skeleton width={68} height={32} radius={radius.pill} />
        <Skeleton width={82} height={32} radius={radius.pill} />
        <Skeleton width={94} height={32} radius={radius.pill} />
      </View>
      {[0, 1, 2, 3].map((key) => <PaperRowSkeleton key={key} />)}
    </SkeletonGroup>
  );
}

export function DiscoverLoadingSkeleton() {
  return (
    <SkeletonGroup label="Loading discovery" style={styles.stack} testID="discover-loading-skeleton">
      <Skeleton width="34%" height={26} style={styles.sectionGap} />
      {[0, 1, 2].map((key) => (
        <View key={key} style={styles.card}>
          <View style={styles.between}>
            <Skeleton width={28} height={28} radius={radius.pill} />
            <Skeleton width="24%" height={11} />
          </View>
          <Skeleton width="86%" height={17} />
          <Skeleton width="58%" height={13} />
          <Skeleton height={11} />
          <Skeleton width="72%" height={11} />
        </View>
      ))}
    </SkeletonGroup>
  );
}

export function NotesLoadingSkeleton() {
  return (
    <SkeletonGroup label="Loading notes" style={styles.notes} testID="notes-loading-skeleton">
      <Skeleton width="70%" height={30} />
      <Skeleton width="38%" height={12} />
      <View style={styles.rule} />
      {[92, 84, 96, 66, 88, 78, 95, 54].map((width, key) => (
        <Skeleton key={key} width={`${width}%`} height={14} radius={7} />
      ))}
      <Skeleton width="44%" height={23} style={styles.paragraphGap} />
      {[96, 82, 89, 61].map((width, key) => (
        <Skeleton key={`second-${key}`} width={`${width}%`} height={14} radius={7} />
      ))}
    </SkeletonGroup>
  );
}

export function SettingsLoadingSkeleton() {
  return (
    <SkeletonGroup label="Loading settings" style={styles.stack} testID="settings-loading-skeleton">
      {[0, 1, 2, 3].map((key) => (
        <View key={key} style={styles.card}>
          <Skeleton width="34%" height={18} />
          <Skeleton width="58%" height={11} />
          <Skeleton height={48} radius={radius.md} />
          {key < 2 ? <Skeleton height={48} radius={radius.md} /> : null}
        </View>
      ))}
    </SkeletonGroup>
  );
}

export function UsageLoadingSkeleton() {
  return (
    <SkeletonGroup label="Loading usage" style={styles.usage} testID="usage-loading-skeleton">
      <Skeleton width="38%" height={28} />
      <Skeleton width="56%" height={12} />
      <View style={styles.between}>
        <Skeleton width="42%" height={12} />
        <Skeleton width="30%" height={12} />
      </View>
    </SkeletonGroup>
  );
}

export function PaperSessionLoadingSkeleton({ label = 'Loading discussion' }: { label?: string }) {
  return (
    <SkeletonGroup label={label} style={styles.paper} testID="paper-loading-skeleton">
      <Skeleton width="82%" height={29} />
      <Skeleton width="54%" height={12} />
      <View style={styles.rule} />
      {[94, 87, 72].map((width, key) => (
        <Skeleton key={key} width={`${width}%`} height={15} radius={7} />
      ))}
      <View style={styles.userBubble}>
        <Skeleton width="62%" height={54} radius={radius.lg} />
      </View>
      {[91, 96, 78, 88, 58].map((width, key) => (
        <Skeleton key={`reply-${key}`} width={`${width}%`} height={15} radius={7} />
      ))}
    </SkeletonGroup>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  card: { gap: space.sm, padding: space.md },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chips: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.xs },
  paperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 94,
    padding: space.md,
  },
  grow: { flex: 1, gap: space.sm },
  sectionGap: { marginTop: space.md },
  notes: { padding: space.lg, gap: space.sm },
  paper: { padding: space.lg, gap: space.sm },
  rule: { height: space.md },
  paragraphGap: { marginTop: space.lg },
  usage: { gap: space.sm, paddingVertical: space.xs },
  userBubble: { alignItems: 'flex-end', marginVertical: space.lg },
});
