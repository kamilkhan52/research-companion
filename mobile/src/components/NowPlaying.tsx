// Global mini-player: a floating card that appears whenever audio is being PREPARED or a
// narration track is loaded, so the user always knows what the audio system is doing from
// anywhere in the app. Deliberately minimal — play/pause, title + status, a hairline progress
// strip, and dismiss; tapping the card expands into the full-screen player (app/player.tsx),
// which owns the rolling transcript, scrubber, and skips. Rendered twice, mutually exclusive:
// inside the tab bar (above the tab row) on tab screens, and at the root layout's bottom edge
// on stack screens — audio persists across navigation either way.

import { Feather } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, {
  State,
  useActiveTrack,
  useIsPlaying,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { checkpointPlayback } from '../../playback-persistence';
import { SENTENCE_SEEK_PREROLL_SECONDS, seekSentence } from '../../sentence-seek';

import { useAudio } from '@/audio/AudioProvider';
import { parseMessageAudioId, sessionAddressFromAudioSlug } from '@/audio/identity';
import { isContentQualifiedAudioId } from '@/audio/discussionFollow';
import {
  narrationCursorSnapshot,
  PASSIVE_NARRATION_LEAD_SECONDS,
} from '@/audio/useNarrationCursor';
import { SKIP_SECONDS } from '@/audio/setup';
import { useListeningMode } from '@/store/listening';
import { Marquee } from '@/ui/Marquee';
import { prepLabel } from '@/components/NarrationTranscript';
import { Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const TRACK_SETTLE_ATTEMPTS = 5;
const TRACK_SETTLE_MS = 80;

function trackInstanceId(track: unknown): string {
  const value = track as { id?: unknown } | undefined;
  return value?.id == null ? '' : String(value.id);
}

/** A progressive sentence step may switch queue tracks before TrackPlayer's imperative reads
 * expose the new track and its queue metadata. Poll for that bounded transition and resolve the
 * new segment at its deterministic start; its old segment's duration/position are incompatible. */
async function cursorAfterTrackChange(previousTrackId: string) {
  for (let attempt = 0; attempt < TRACK_SETTLE_ATTEMPTS; attempt += 1) {
    const [soughtTrack, queue] = await Promise.all([
      TrackPlayer.getActiveTrack(),
      TrackPlayer.getQueue(),
    ]);
    if (soughtTrack && trackInstanceId(soughtTrack) !== previousTrackId) {
      let target = narrationCursorSnapshot(soughtTrack, queue, { position: 0, duration: 1 }, 0);
      const progressiveTrack = soughtTrack as {
        narration?: unknown;
        sentenceText?: unknown;
        segmentIndex?: unknown;
      };
      const narration = typeof progressiveTrack.narration === 'string'
        ? progressiveTrack.narration
        : '';
      const segmentText = typeof progressiveTrack.sentenceText === 'string'
        ? progressiveTrack.sentenceText.trim()
        : '';
      const segmentIndex = typeof progressiveTrack.segmentIndex === 'number'
        ? progressiveTrack.segmentIndex
        : -1;
      if (narration && segmentText && segmentIndex >= 0) {
        const slotId = String((soughtTrack as { slotId?: unknown }).slotId ?? soughtTrack.id);
        const priorLength = queue.reduce((total, queuedValue) => {
          const queued = queuedValue as {
            id?: unknown;
            slotId?: unknown;
            segmentIndex?: unknown;
            sentenceText?: unknown;
          };
          const queuedSlotId = String(queued.slotId ?? queued.id);
          return typeof queued.segmentIndex === 'number'
            && queuedSlotId === slotId
            && queued.segmentIndex < segmentIndex
            && typeof queued.sentenceText === 'string'
            ? total + queued.sentenceText.length
            : total;
        }, 0);
        const segmentStart = narration.indexOf(segmentText, Math.max(0, priorLength - 2));
        if (segmentStart >= 0) {
          const fraction = segmentStart / narration.length;
          const exactIndex = target.sentences.findIndex(
            (sentence) => fraction >= sentence.startFrac && fraction < sentence.endFrac,
          );
          if (exactIndex >= 0) target = { ...target, activeIndex: exactIndex };
        }
      }
      if (target.activeIndex >= 0) return { soughtTrack, target };
    }
    if (attempt + 1 < TRACK_SETTLE_ATTEMPTS) {
      await new Promise<void>((resolve) => setTimeout(resolve, TRACK_SETTLE_MS));
    }
  }
  return null;
}

export function NowPlaying({ inset = true }: { inset?: boolean }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const audio = useAudio();
  const { followNarrationInDiscussion } = useListeningMode();
  const pathname = usePathname();
  // Guard against stacking duplicate full-screen player routes when the bar is tapped
  // repeatedly (each raw push() would mount another copy). navigate() rewinds to an existing
  // instance; the pathname check also blocks a re-tap while already on the player.
  const openPlayer = () => {
    if (pathname !== '/player') router.navigate('/player');
  };
  const track = useActiveTrack();
  const { playing } = useIsPlaying();
  const { state } = usePlaybackState();
  const { position, duration } = useProgress(500);

  const seekAndFollow = async (direction: -1 | 1) => {
    const previousTrackId = trackInstanceId(track);
    const outcome = await seekSentence(TrackPlayer, direction, SKIP_SECONDS);
    if (!followNarrationInDiscussion) return;

    // Seeking a progressive narration can skip to a different queue track. Read identity only
    // AFTER the seek settles, and publish that same exact slot to Discussion and the route.
    const settled = outcome === 'track' ? await cursorAfterTrackChange(previousTrackId) : null;
    if (outcome === 'track' && !settled) return;
    let soughtTrack: Awaited<ReturnType<typeof TrackPlayer.getActiveTrack>>;
    let target: ReturnType<typeof narrationCursorSnapshot>;
    let passiveIndex: number;
    if (settled) {
      ({ soughtTrack, target } = settled);
      // A progressive track transition starts at the new segment boundary. Both explicit and
      // passive cursors therefore name that segment's sentence without consulting stale progress.
      passiveIndex = target.activeIndex;
    } else {
      const [activeTrack, queue, soughtProgress] = await Promise.all([
        TrackPlayer.getActiveTrack(),
        TrackPlayer.getQueue(),
        TrackPlayer.getProgress(),
      ]);
      soughtTrack = activeTrack;
      // Sentence seeks intentionally pre-roll by 0.75 s. Resolve just past that boundary so the
      // explicit landing highlights the sentence the reader requested immediately, rather than
      // the preceding sentence until the passive playback clock catches up.
      target = narrationCursorSnapshot(
        activeTrack,
        queue,
        soughtProgress,
        SENTENCE_SEEK_PREROLL_SECONDS + 0.05,
      );
      // Carry the passive interpretation of this same post-seek snapshot. Discussion's own hook
      // can still describe the pre-seek position for another 500 ms, so it cannot supply the
      // baseline used to decide whether playback has genuinely crossed a later boundary.
      passiveIndex = narrationCursorSnapshot(
        activeTrack,
        queue,
        soughtProgress,
        PASSIVE_NARRATION_LEAD_SECONDS,
        target.sentences,
      ).activeIndex;
    }
    const slotId = String(soughtTrack?.slotId ?? soughtTrack?.id ?? '');
    if (!isContentQualifiedAudioId(slotId)) return;
    const identity = parseMessageAudioId(slotId);
    if (!identity?.contentTag) return;
    if (target.activeIndex < 0) return;
    const address = sessionAddressFromAudioSlug(identity.slug);
    audio.publishDiscussionJump(slotId, target.activeIndex, passiveIndex);
    router.navigate({
      pathname: '/paper/[slug]',
      params: {
        slug: address.slug,
        project: identity.project,
        thread: address.threadId,
      },
    });
  };

  // DR-055: the STACK copy sits outside the screen's own KeyboardAvoidingView (it's a sibling
  // of the Stack at the root layout, not inside the composer's scope), so without this it stays
  // put while the keyboard covers it from below rather than being pushed above it like the
  // composer itself is. `react-native-keyboard-controller`'s keyboard state is global — this
  // works whether or not the component that opened the keyboard is a sibling or not.
  //
  // Deliberately NOT applied to the tab-bar copy (`inset=false`): that card sits ABOVE an
  // in-flow tab row that does not move when the keyboard opens, so pushing the card up by the
  // full keyboard height would overshoot by the tab row's own height and leave a gap between
  // the card and the keyboard. No tab screen has a bottom-anchored text input today (Discover's
  // goals field lives inside a scrolling card with its own KeyboardAvoidingView) — Kamil's
  // report was specifically about the paper screen's comment composer, a stack screen.
  const keyboardHeight = useKeyboardState((s) => (s.isVisible ? s.height : 0));

  const wrapStyle = [
    styles.wrap,
    inset && { marginBottom: keyboardHeight > 0 ? keyboardHeight : Math.max(insets.bottom, space.sm) },
  ];

  // Preparing (nothing loaded yet): announce the stage + real progress; tap for the big view.
  if (!track) {
    if (!audio.prep) return null;
    const { stage, done, total, title } = audio.prep;
    const determinate = stage === 'synthesizing' && total > 0;
    return (
      <View testID="now-playing-wrap" style={wrapStyle}>
        <Pressable onPress={openPlayer} style={styles.card} accessibilityLabel="Open player">
          <View style={styles.row}>
            <View style={styles.artBadge}>
              <Feather name="music" size={16} color={t.mint} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Marquee
                text={title}
                textStyle={{ fontFamily: fonts.bodySemiBold, fontSize: 15, lineHeight: 21, color: t.text }}
              />
              <Text variant="caption" color={t.mint} numberOfLines={1}>
                {prepLabel(stage, done, total)}
              </Text>
            </View>
            <Pressable
              onPress={audio.cancelPrep}
              hitSlop={10}
              style={styles.sideBtn}
              accessibilityLabel="Cancel audio preparation">
              <Feather name="x" size={16} color={t.muted} />
            </Pressable>
          </View>
          <View style={styles.progressStrip}>
            <View
              style={[
                styles.progressFill,
                { width: determinate ? `${Math.round((done / total) * 100)}%` : '8%' },
              ]}
            />
          </View>
        </Pressable>
      </View>
    );
  }

  const buffering = state === State.Buffering || state === State.Loading;
  const status = buffering
    ? 'Buffering…'
    : `${fmt(position)} ${duration ? `/ ${fmt(duration)}` : ''}${playing ? '' : ' · paused'}`;

  return (
    <View testID="now-playing-wrap" style={wrapStyle}>
      <Pressable onPress={openPlayer} style={styles.card} accessibilityLabel="Open player">
        <View style={styles.row}>
          <Pressable
            onPress={async () => {
              if (playing) {
                await TrackPlayer.pause();
                await checkpointPlayback(TrackPlayer).catch(() => {});
              } else {
                const { state: s } = await TrackPlayer.getPlaybackState();
                if (s === State.Ended) await TrackPlayer.seekTo(0);
                await TrackPlayer.play();
              }
            }}
            hitSlop={8}
            style={styles.playBtn}
            accessibilityLabel={playing ? 'Pause' : 'Play'}>
            {/* Optical centering: the play triangle's mass sits left of center (see
               player.tsx), so nudge it right; pause is symmetric. */}
            <Feather
              name={playing ? 'pause' : 'play'}
              size={17}
              color={t.mintInk}
              style={playing ? undefined : { marginLeft: 2 }}
            />
          </Pressable>

          {/* DR-103 (Kamil): "controls for next and previous sentence can be added besides the
             play and pause… The paper title in this view is already available at the top." So
             the title gives up weight and a line of size to the two controls that matter while
             listening; the full-screen player keeps the ±15s skips and the scrubber. */}
          <Pressable
            onPress={() => void seekAndFollow(-1)}
            hitSlop={8}
            style={styles.sideBtn}
            accessibilityLabel="Previous sentence">
            <Feather name="skip-back" size={16} color={t.text} />
          </Pressable>

          <View style={{ flex: 1, minWidth: 0 }}>
            <Marquee
              text={String(track.title ?? 'Narration')}
              textStyle={{ fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: t.text }}
            />
            <Text variant="caption" color={buffering ? t.mint : undefined} numberOfLines={1}>
              {status}
            </Text>
          </View>

          <Pressable
            onPress={() => void seekAndFollow(1)}
            hitSlop={8}
            style={styles.sideBtn}
            accessibilityLabel="Next sentence">
            <Feather name="skip-forward" size={16} color={t.text} />
          </Pressable>

          <Feather name="chevron-up" size={18} color={t.muted} />
          <Pressable
            onPress={() => void audio.dismiss()}
            hitSlop={10}
            style={styles.sideBtn}
            accessibilityLabel="Close player">
            <Feather name="x" size={16} color={t.muted} />
          </Pressable>
        </View>
        <View style={styles.progressStrip}>
          <View
            style={[
              styles.progressFill,
              { width: duration ? `${Math.min(100, (position / duration) * 100)}%` : '0%' },
            ]}
          />
        </View>
      </Pressable>
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  // A plain full-width rectangular bar (R12.6, per Kamil): no side insets, no rounding —
  // the standard bottom-docked mini player.
  wrap: { backgroundColor: 'transparent' },
  // Pass-through wrapper (the JSX still nests it); the rectangular bar needs no rounded
  // shadow layer.
  card: {
    backgroundColor: t.elevated,
    borderTopWidth: 1,
    borderTopColor: t.line2,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  artBadge: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: t.mintWashStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: t.mint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sideBtn: {
    width: 30,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressStrip: {
    height: 3,
    backgroundColor: t.line,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: t.mint },
});
