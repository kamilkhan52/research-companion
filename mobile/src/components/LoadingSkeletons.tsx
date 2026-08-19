import { StyleSheet, View, type DimensionValue } from 'react-native';

import { Skeleton, SkeletonGroup } from '@/components/Skeleton';
import { useThemedStyles, type DensityMode } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';

function LibraryPaperCardSkeleton({
  styles,
  titleWidths,
}: {
  styles: ReturnType<typeof makeLibraryStyles>;
  titleWidths: [DimensionValue, DimensionValue];
}) {
  return (
    <View style={styles.paperCard} testID="library-paper-card-skeleton">
      <View style={styles.paperCopy} testID="library-paper-copy-skeleton">
        <Skeleton width="38%" height={12} />
        <Skeleton width={titleWidths[0]} height={19} />
        <Skeleton width={titleWidths[1]} height={19} />
        <Skeleton width="31%" height={12} />
      </View>
      <View style={styles.paperAction} testID="library-paper-action-skeleton">
        <Skeleton width={30} height={30} radius={radius.pill} />
        <Skeleton width={48} height={13} />
        <Skeleton width={11} height={14} />
      </View>
    </View>
  );
}

export function LibraryLoadingSkeleton() {
  const libraryStyles = useThemedStyles(makeLibraryStyles);

  return (
    <SkeletonGroup
      label="Loading your library"
      style={libraryStyles.stack}
      testID="library-loading-skeleton">
      <View style={libraryStyles.continueCard} testID="library-continue-card-skeleton">
        <View style={styles.between}>
          <Skeleton width="44%" height={26} />
          <Skeleton width={42} height={42} radius={radius.pill} />
        </View>
        <View style={libraryStyles.continueBody}>
          <Skeleton
            width={84}
            height={104}
            radius={radius.md}
            testID="library-cover-skeleton"
          />
          <View style={libraryStyles.continueCopy}>
            <Skeleton width="96%" height={22} />
            <Skeleton width="88%" height={22} />
            <Skeleton width="64%" height={22} />
            <Skeleton width="72%" height={12} />
            <View style={libraryStyles.continueActions}>
              <Skeleton width={126} height={42} radius={radius.pill} />
              <Skeleton width={42} height={42} radius={radius.pill} />
            </View>
          </View>
        </View>
      </View>

      <View style={libraryStyles.progressCard} testID="library-progress-card-skeleton">
        <View style={styles.between}>
          <Skeleton width="38%" height={18} />
          <Skeleton width="28%" height={12} />
        </View>
        <Skeleton height={6} radius={radius.pill} />
      </View>

      <View style={libraryStyles.filters} testID="library-filter-skeleton">
        <Skeleton width={64} height={34} radius={radius.pill} />
        <Skeleton width={82} height={34} radius={radius.pill} />
        <Skeleton width={102} height={34} radius={radius.pill} />
        <Skeleton width={68} height={34} radius={radius.pill} />
      </View>

      {([
        ['92%', '66%'],
        ['84%', '76%'],
        ['95%', '58%'],
        ['88%', '70%'],
      ] as [DimensionValue, DimensionValue][]).map((titleWidths, key) => (
        <LibraryPaperCardSkeleton key={key} styles={libraryStyles} titleWidths={titleWidths} />
      ))}
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
  sectionGap: { marginTop: space.md },
  notes: { padding: space.lg, gap: space.sm },
  paper: { padding: space.lg, gap: space.sm },
  rule: { height: space.md },
  paragraphGap: { marginTop: space.lg },
  usage: { gap: space.sm, paddingVertical: space.xs },
  userBubble: { alignItems: 'flex-end', marginVertical: space.lg },
});

const makeLibraryStyles = (t: ThemePalette, density: DensityMode) => {
  const tight = density === 'tight';
  const cardPadding = tight ? space.md : space.lg;
  const sectionGap = tight ? space.sm : space.md;

  return StyleSheet.create({
    stack: { gap: sectionGap },
    continueCard: {
      gap: sectionGap,
      padding: cardPadding,
      backgroundColor: t.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: t.line2,
    },
    continueBody: { flexDirection: 'row', gap: tight ? space.md : space.lg },
    continueCopy: { flex: 1, minWidth: 0, gap: 5 },
    continueActions: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-end',
      gap: space.sm,
      marginTop: space.xs,
    },
    progressCard: {
      gap: sectionGap,
      padding: cardPadding,
      backgroundColor: t.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: t.line,
    },
    filters: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
    },
    paperCard: {
      minHeight: tight ? 112 : 124,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      padding: cardPadding,
      backgroundColor: t.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: t.line,
    },
    paperCopy: { flex: 1, minWidth: 0, gap: 6 },
    paperAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  });
};
