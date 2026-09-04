import { StyleSheet, View, type DimensionValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SessionState } from '@/api/types';
import { EdgeFade } from '@/components/EdgeFade';
import { discussionComposerPadding } from '@/components/chat/discussionLayout';
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

/**
 * The empty-cache state for an existing discussion. It mirrors the actual immersive viewport:
 * the TAIL of one long assistant analysis — continuous prose paragraphs with a heading and a
 * blockquote, ending in the message's action row (DR-101, Kamil: "We are usually just seeing
 * the last part of a long message by the AI, not a short back and forth like a chat app").
 * The floating composer plus bottom fade remain connected to that same canvas. There is
 * deliberately no fake title inside the transcript — the real floating TopBar owns identity.
 */
export function DiscussionLoadingSkeleton({ state = 'in_discussion' }: { state?: SessionState }) {
  const insets = useSafeAreaInsets();
  const paperStyles = useThemedStyles(makePaperLoadingStyles);
  const bottomMode = state === 'notes_drafted'
    ? 'review'
    : state === 'committed'
      ? 'committed'
      : 'composer';
  const fadeHeight = insets.bottom
    + (bottomMode === 'committed' ? 190 : bottomMode === 'review' ? 166 : 146);

  return (
    <View style={paperStyles.discussionRoot} testID="discussion-loading-skeleton">
      <SkeletonGroup
        label="Loading discussion"
        style={[paperStyles.discussionTranscript, { paddingTop: insets.top + 84 }]}
        testID="discussion-loading-transcript">
        {/* One long analysis, mid-flow: paragraph → heading → paragraph → indented quote →
            closing paragraphs → the message's own action row. Line widths echo justified
            serif prose (near-full lines, a short last line per paragraph). */}
        {[
          { kind: 'paragraph', widths: [97, 94, 98, 91, 58] },
          { kind: 'heading', widths: [44] },
          { kind: 'paragraph', widths: [96, 98, 92, 71] },
          { kind: 'quote', widths: [88, 93, 64] },
          { kind: 'paragraph', widths: [95, 97, 90, 96, 47] },
          { kind: 'paragraph', widths: [98, 93, 89, 66] },
        ].map((block, blockIndex) => (
          <View
            key={`block-${blockIndex}`}
            style={[
              paperStyles.assistantTurn,
              block.kind === 'quote' && paperStyles.quoteBlock,
            ]}
            testID={`discussion-${block.kind}-skeleton`}>
            {block.widths.map((width, lineIndex) => (
              <Skeleton
                key={`line-${lineIndex}`}
                width={`${width}%`}
                height={block.kind === 'heading' ? 22 : 15}
                radius={block.kind === 'heading' ? 8 : 7}
              />
            ))}
            {blockIndex === 5 ? (
              <View style={paperStyles.messageActions}>
                <Skeleton width={46} height={13} />
                <Skeleton width={42} height={13} />
                <Skeleton width={52} height={13} />
              </View>
            ) : null}
          </View>
        ))}
      </SkeletonGroup>

      <EdgeFade
        edge="bottom"
        size={fadeHeight}
        transparentInset={64}
        testID="discussion-bottom-edge-fade"
        style={paperStyles.discussionBottomFade}
      />
      {bottomMode === 'composer' ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[paperStyles.composerOverlay, discussionComposerPadding(insets.bottom)]}
          testID="discussion-composer-skeleton">
          <View style={paperStyles.composerPill}>
            <Skeleton width="72%" height={16} radius={8} />
            <Skeleton width={38} height={38} radius={radius.pill} />
          </View>
        </View>
      ) : (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[paperStyles.statusOverlay, { paddingBottom: insets.bottom + space.sm }]}
          testID={`discussion-${bottomMode}-skeleton`}>
          <View style={paperStyles.statusCard}>
            {bottomMode === 'committed' ? <Skeleton width="62%" height={13} /> : null}
            <Skeleton
              width={bottomMode === 'committed' ? 174 : 132}
              height={42}
              radius={radius.md}
            />
          </View>
        </View>
      )}
    </View>
  );
}

/** Empty-cache state for a paper that has not started yet. Mirrors ComposeFirst rather than chat. */
export function PaperSetupLoadingSkeleton() {
  const paperStyles = useThemedStyles(makePaperLoadingStyles);

  return (
    <View style={paperStyles.setupRoot} testID="paper-setup-loading-skeleton">
      <SkeletonGroup
        label="Loading paper setup"
        style={paperStyles.setupContent}
        testID="paper-setup-loading-content">
        <View style={paperStyles.setupCard} testID="paper-setup-hero-skeleton">
          <Skeleton width={94} height={28} radius={radius.pill} />
          <Skeleton width="94%" height={28} />
          <Skeleton width="78%" height={28} />
          <Skeleton width="42%" height={13} />
          <Skeleton width="84%" height={15} />
        </View>

        <View style={paperStyles.setupSection} testID="paper-setup-modes-skeleton">
          <Skeleton width="30%" height={12} />
          <Skeleton width="72%" height={13} />
          {[0, 1, 2, 3].map((key) => (
            <View key={key} style={paperStyles.modeRow}>
              <Skeleton width={36} height={36} radius={radius.pill} />
              <View style={paperStyles.modeCopy}>
                <Skeleton width={key === 3 ? '40%' : '56%'} height={16} />
                {key === 0 ? <Skeleton width="88%" height={12} /> : null}
              </View>
              <Skeleton width={20} height={20} radius={radius.pill} />
            </View>
          ))}
          <View style={paperStyles.modelRow}>
            <Skeleton width={38} height={38} radius={radius.pill} />
            <View style={paperStyles.modeCopy}>
              <Skeleton width="30%" height={16} />
              <Skeleton width="52%" height={12} />
            </View>
            <Skeleton width={54} height={13} />
          </View>
        </View>

        <View style={paperStyles.setupCard} testID="paper-setup-source-skeleton">
          <View style={styles.between}>
            <View style={paperStyles.sourceIdentity}>
              <Skeleton width={38} height={38} radius={radius.pill} />
              <View style={paperStyles.modeCopy}>
                <Skeleton width="58%" height={17} />
                <Skeleton width="82%" height={12} />
              </View>
            </View>
            <Skeleton width={24} height={24} radius={radius.pill} />
          </View>
        </View>
      </SkeletonGroup>

      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={paperStyles.setupFooter}
        testID="paper-setup-footer-skeleton">
        <Skeleton height={48} radius={radius.md} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  card: { gap: space.sm, padding: space.md },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionGap: { marginTop: space.md },
  notes: { padding: space.lg, gap: space.sm },
  rule: { height: space.md },
  paragraphGap: { marginTop: space.lg },
  usage: { gap: space.sm, paddingVertical: space.xs },
});

const makePaperLoadingStyles = (t: ThemePalette, density: DensityMode) => {
  const tight = density === 'tight';
  const horizontal = tight ? space.md : space.lg;

  return StyleSheet.create({
    discussionRoot: { flex: 1, backgroundColor: t.bg },
    discussionTranscript: {
      flex: 1,
      gap: tight ? space.md : space.lg,
      paddingHorizontal: horizontal,
      paddingBottom: 132,
      overflow: 'hidden',
    },
    assistantTurn: { gap: tight ? 6 : space.sm },
    // DR-101 — the blockquote hint: inset with a leading rule, like Markdown.tsx's quotes.
    quoteBlock: { marginLeft: space.lg, paddingLeft: space.md, borderLeftWidth: 3,
      borderLeftColor: t.line2 },
    messageActions: { flexDirection: 'row', gap: space.lg, paddingTop: space.sm },
    discussionBottomFade: { zIndex: 10 },
    composerOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20 },
    composerPill: {
      minHeight: 58,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: space.sm,
      paddingLeft: tight ? space.sm : space.md,
      paddingRight: 6,
      paddingVertical: 6,
      backgroundColor: t.elevated,
      borderWidth: 1,
      borderColor: t.line2,
      borderRadius: 24,
    },
    statusOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20 },
    statusCard: {
      alignItems: 'center',
      gap: space.sm,
      marginHorizontal: horizontal,
      padding: horizontal,
      backgroundColor: t.elevated,
      borderWidth: 1,
      borderColor: t.line2,
      borderRadius: radius.lg,
    },
    setupRoot: { flex: 1 },
    setupContent: { gap: tight ? space.md : space.lg, padding: horizontal, paddingBottom: 92 },
    setupCard: {
      gap: space.sm,
      padding: horizontal,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.line2,
      borderRadius: radius.lg,
    },
    setupSection: { gap: space.sm, paddingTop: space.xs },
    modeRow: {
      minHeight: tight ? 54 : 60,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      padding: space.sm,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.line,
      borderRadius: radius.md,
    },
    modeCopy: { flex: 1, minWidth: 0, gap: 5 },
    modelRow: {
      minHeight: 64,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      padding: space.md,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.line2,
      borderRadius: radius.lg,
    },
    sourceIdentity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.sm },
    setupFooter: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      padding: horizontal,
      paddingTop: space.sm,
      paddingBottom: space.lg,
      backgroundColor: t.bg,
      borderTopWidth: 1,
      borderTopColor: t.line,
    },
  });
};

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
