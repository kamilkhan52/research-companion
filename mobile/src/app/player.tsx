// Full-screen player — the focused listening surface. Just two things, per the design brief:
// the rolling transcript (the sentence being spoken, auto-centered, neighbors dimmed for
// orientation, tap a line to jump there) and the transport controls. Opened by tapping the
// mini player; everything else in the app stays reachable by swiping the modal away.

import Slider from '@react-native-community/slider';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import TrackPlayer, {
  State,
  useActiveTrack,
  useIsPlaying,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';

import { useAudio } from '@/audio/AudioProvider';
import { SKIP_SECONDS } from '@/audio/setup';
import { PLAYBACK_RATES, useListeningMode } from '@/store/listening';
import { checkpointPlayback } from '../../playback-persistence';
import { seekSentence } from '../../sentence-seek';
import { prepLabel, RollingTranscript } from '@/components/NarrationTranscript';
import { Icon, IconButton, Screen, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function PlayerScreen() {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const audio = useAudio();
  const track = useActiveTrack();
  const { playing } = useIsPlaying();
  const { state } = usePlaybackState();
  const { position, duration } = useProgress(250);
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  const narration = audio.currentId ? audio.narrationById[audio.currentId] : undefined;
  const buffering = state === State.Buffering || state === State.Loading;
  const value = scrubbing ?? position;

  // R6.6 — tap to cycle narration speed; persisted and applied by AudioProvider.
  const { playbackRate, setPlaybackRate } = useListeningMode();
  const cycleRate = () => {
    const i = PLAYBACK_RATES.indexOf(playbackRate);
    setPlaybackRate(PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length]);
  };

  async function togglePlay() {
    if (playing) {
      await TrackPlayer.pause();
      await checkpointPlayback(TrackPlayer).catch(() => {});
    } else {
      if (state === State.Ended) await TrackPlayer.seekTo(0);
      await TrackPlayer.play();
    }
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.header}>
        <IconButton name="chevron-down" size={20} onPress={() => router.back()} accessibilityLabel="Collapse player" />
        <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
          {/* No "Listening mode" label (polish plan F.3) — the screen is self-evident and the
              vertical space belongs to the transcript. */}
          <Text variant="serifTitle" style={{ fontSize: 17, lineHeight: 22, textAlign: 'center' }} numberOfLines={2}>
            {track?.title ?? audio.prep?.title ?? 'Narration'}
          </Text>
        </View>
        <Pressable
          onPress={cycleRate}
          hitSlop={8}
          style={[styles.rateBtn, playbackRate !== 1 && { borderColor: t.mint }]}
          accessibilityRole="button"
          accessibilityLabel={`Playback speed ${playbackRate} times. Tap to change.`}>
          <Text style={[styles.rateLabel, playbackRate !== 1 && { color: t.mint }]}>
            {playbackRate}×
          </Text>
        </Pressable>
      </View>

      {track ? (
        <>
          {narration ? (
            <RollingTranscript narration={narration} />
          ) : (
            <View style={styles.centerFill}>
              <Text variant="body" color={t.muted}>
                No transcript for this narration.
              </Text>
            </View>
          )}

          <View style={styles.controls}>
            <Slider
              style={styles.slider}
              minimumValue={0}
              maximumValue={duration || 1}
              value={value}
              minimumTrackTintColor={t.mint}
              maximumTrackTintColor={t.line2}
              thumbTintColor={t.mint}
              onValueChange={(v) => setScrubbing(v)}
              onSlidingComplete={(v) => {
                TrackPlayer.seekTo(v);
                setScrubbing(null);
              }}
            />
            <View style={styles.timesRow}>
              <Text variant="caption">{fmt(value)}</Text>
              <Text variant="caption" color={buffering ? t.mint : t.muted}>
                {buffering ? 'Buffering…' : playing ? '' : state === State.Ended ? 'Ended' : 'Paused'}
              </Text>
              <Text variant="caption">{duration ? fmt(duration) : '–:––'}</Text>
            </View>

            {/* One transport row, two jump kinds (Figma: 14 · Player Jump Controls, K1).
                Sentence jump is the semantic control ("say that again") so it sits
                first-class beside play with a mint outline; the coarse ±15s time jump
                stays outboard with its rotate-glyph identity. */}
            <View style={styles.buttonsRow}>
              <Pressable
                onPress={() => TrackPlayer.seekBy(-SKIP_SECONDS)}
                hitSlop={8}
                style={styles.timeBtn}
                accessibilityLabel={`Back ${SKIP_SECONDS} seconds`}>
                <Icon name="rotate-ccw" size={14} color={t.text} />
                <Text style={styles.skipGlyph}>{SKIP_SECONDS}</Text>
              </Pressable>
              <Pressable
                onPress={() => seekSentence(TrackPlayer, -1, SKIP_SECONDS)}
                hitSlop={8}
                style={styles.sentenceBtn}
                accessibilityLabel="Previous sentence">
                <Icon name="skip-back" size={17} color={t.mint} />
                <SentenceGlyph />
              </Pressable>
              <Pressable
                onPress={togglePlay}
                style={styles.playBtn}
                accessibilityLabel={playing ? 'Pause' : 'Play'}>
                {buffering ? (
                  <ActivityIndicator color={t.mintInk} />
                ) : (
                  // The play triangle's visual mass sits left of its bounding-box center
                  // (Feather draws it flush-left in the viewBox), so it needs a small
                  // rightward nudge to LOOK centered in the circle; pause is symmetric.
                  <Icon
                    name={playing ? 'pause' : 'play'}
                    size={26}
                    color={t.mintInk}
                    style={playing ? undefined : { marginLeft: 3 }}
                  />
                )}
              </Pressable>
              <Pressable
                onPress={() => seekSentence(TrackPlayer, 1, SKIP_SECONDS)}
                hitSlop={8}
                style={styles.sentenceBtn}
                accessibilityLabel="Next sentence">
                <SentenceGlyph />
                <Icon name="skip-forward" size={17} color={t.mint} />
              </Pressable>
              <Pressable
                onPress={() => TrackPlayer.seekBy(SKIP_SECONDS)}
                hitSlop={8}
                style={styles.timeBtn}
                accessibilityLabel={`Forward ${SKIP_SECONDS} seconds`}>
                <Text style={styles.skipGlyph}>{SKIP_SECONDS}</Text>
                <Icon name="rotate-cw" size={14} color={t.text} />
              </Pressable>
            </View>
          </View>
        </>
      ) : audio.prep ? (
        // Opened while audio is still being prepared: show the live stage + real progress,
        // and hand over to the transcript/controls the moment the track loads.
        <View style={styles.centerFill}>
          <ActivityIndicator color={t.mint} />
          <Text variant="body" color={t.mint} style={{ marginTop: space.md }}>
            {prepLabel(audio.prep.stage, audio.prep.done, audio.prep.total)}
          </Text>
          {audio.prep.stage === 'synthesizing' && audio.prep.total > 0 ? (
            <View style={styles.prepTrack}>
              <View
                style={[
                  styles.prepFill,
                  { width: `${Math.round((audio.prep.done / audio.prep.total) * 100)}%` },
                ]}
              />
            </View>
          ) : null}
          <Pressable
            onPress={() => {
              audio.cancelPrep();
              router.back();
            }}
            style={styles.cancelBtn}
            accessibilityLabel="Cancel audio preparation">
            <Text variant="caption" color={t.muted}>
              Cancel
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.centerFill}>
          <Text variant="body" color={t.muted}>
            Nothing playing.
          </Text>
        </View>
      )}
    </Screen>
  );
}

// Three staggered "text lines" beside the skip glyph — the cue that this jump lands on a
// sentence of the transcript, not on the clock.
function SentenceGlyph() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.sentenceGlyph} accessible={false}>
      <View style={[styles.sentenceGlyphLine, { width: 7 }]} />
      <View style={[styles.sentenceGlyphLine, { width: 9 }]} />
      <View style={[styles.sentenceGlyphLine, { width: 5 }]} />
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  controls: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: t.line,
  },
  slider: { width: '100%', height: 32 },
  timesRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  buttonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.md,
  },
  playBtn: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    backgroundColor: t.mint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeBtn: {
    width: 64,
    height: 52,
    borderRadius: radius.lg,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  sentenceBtn: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.mint,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 3,
  },
  sentenceGlyph: { gap: 2, alignItems: 'flex-start' },
  sentenceGlyphLine: { height: 1.5, borderRadius: 1, backgroundColor: t.mint },
  skipGlyph: { color: t.text, fontSize: 12, fontFamily: fonts.bodySemiBold },
  // R9.10 — a proper pill (bg + border), bigger than the old bare-text control, so the speed
  // affordance is prominent enough to find and tap.
  rateBtn: {
    minWidth: 52,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rateLabel: { color: t.muted, fontSize: 15, fontFamily: fonts.bodySemiBold },
  prepTrack: {
    width: '70%',
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: t.line,
    overflow: 'hidden',
    marginTop: space.lg,
  },
  prepFill: { height: '100%', borderRadius: radius.pill, backgroundColor: t.mint },
  cancelBtn: {
    marginTop: space.xl,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.line2,
  },
});
