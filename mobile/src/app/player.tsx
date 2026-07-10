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
import { seekSentence } from '../../sentence-seek';
import { prepLabel, RollingTranscript } from '@/components/NarrationTranscript';
import { Icon, IconButton, Screen, Text } from '@/ui';
import { colors, fonts, radius, space } from '@/theme/tokens';

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function PlayerScreen() {
  const router = useRouter();
  const audio = useAudio();
  const track = useActiveTrack();
  const { playing } = useIsPlaying();
  const { state } = usePlaybackState();
  const { position, duration } = useProgress(250);
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  const narration = audio.currentId ? audio.narrationById[audio.currentId] : undefined;
  const buffering = state === State.Buffering || state === State.Loading;
  const value = scrubbing ?? position;

  async function togglePlay() {
    if (playing) {
      await TrackPlayer.pause();
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
          <Text variant="heading" style={{ fontSize: 18 }} color={colors.mint}>
            Listening mode
          </Text>
          <Text variant="serifTitle" style={{ fontSize: 17, lineHeight: 22, textAlign: 'center' }} numberOfLines={2}>
            {track?.title ?? audio.prep?.title ?? 'Narration'}
          </Text>
        </View>
        <View style={{ width: 42 }} />
      </View>

      {track ? (
        <>
          {narration ? (
            <RollingTranscript narration={narration} />
          ) : (
            <View style={styles.centerFill}>
              <Text variant="body" color={colors.muted}>
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
              minimumTrackTintColor={colors.mint}
              maximumTrackTintColor={colors.line2}
              thumbTintColor={colors.mint}
              onValueChange={(v) => setScrubbing(v)}
              onSlidingComplete={(v) => {
                TrackPlayer.seekTo(v);
                setScrubbing(null);
              }}
            />
            <View style={styles.timesRow}>
              <Text variant="caption">{fmt(value)}</Text>
              <Text variant="caption" color={buffering ? colors.mint : colors.muted}>
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
                <Icon name="rotate-ccw" size={14} color={colors.text} />
                <Text style={styles.skipGlyph}>{SKIP_SECONDS}</Text>
              </Pressable>
              <Pressable
                onPress={() => seekSentence(TrackPlayer, -1, SKIP_SECONDS)}
                hitSlop={8}
                style={styles.sentenceBtn}
                accessibilityLabel="Previous sentence">
                <Icon name="skip-back" size={17} color={colors.mint} />
                <SentenceGlyph />
              </Pressable>
              <Pressable
                onPress={togglePlay}
                style={styles.playBtn}
                accessibilityLabel={playing ? 'Pause' : 'Play'}>
                {buffering ? (
                  <ActivityIndicator color={colors.mintInk} />
                ) : (
                  <Icon name={playing ? 'pause' : 'play'} size={26} color={colors.mintInk} />
                )}
              </Pressable>
              <Pressable
                onPress={() => seekSentence(TrackPlayer, 1, SKIP_SECONDS)}
                hitSlop={8}
                style={styles.sentenceBtn}
                accessibilityLabel="Next sentence">
                <SentenceGlyph />
                <Icon name="skip-forward" size={17} color={colors.mint} />
              </Pressable>
              <Pressable
                onPress={() => TrackPlayer.seekBy(SKIP_SECONDS)}
                hitSlop={8}
                style={styles.timeBtn}
                accessibilityLabel={`Forward ${SKIP_SECONDS} seconds`}>
                <Text style={styles.skipGlyph}>{SKIP_SECONDS}</Text>
                <Icon name="rotate-cw" size={14} color={colors.text} />
              </Pressable>
            </View>
          </View>
        </>
      ) : audio.prep ? (
        // Opened while audio is still being prepared: show the live stage + real progress,
        // and hand over to the transcript/controls the moment the track loads.
        <View style={styles.centerFill}>
          <ActivityIndicator color={colors.mint} />
          <Text variant="body" color={colors.mint} style={{ marginTop: space.md }}>
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
            <Text variant="caption" color={colors.muted}>
              Cancel
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.centerFill}>
          <Text variant="body" color={colors.muted}>
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
  return (
    <View style={styles.sentenceGlyph} accessible={false}>
      <View style={[styles.sentenceGlyphLine, { width: 7 }]} />
      <View style={[styles.sentenceGlyphLine, { width: 9 }]} />
      <View style={[styles.sentenceGlyphLine, { width: 5 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
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
    borderTopColor: colors.line,
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
    backgroundColor: colors.mint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeBtn: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 3,
  },
  sentenceBtn: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: 'rgba(101, 214, 180, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 3,
  },
  sentenceGlyph: { gap: 2, alignItems: 'flex-start' },
  sentenceGlyphLine: { height: 1.5, borderRadius: 1, backgroundColor: colors.mint },
  skipGlyph: { color: colors.text, fontSize: 12, fontFamily: fonts.bodySemiBold },
  prepTrack: {
    width: '70%',
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.line,
    overflow: 'hidden',
    marginTop: space.lg,
  },
  prepFill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.mint },
  cancelBtn: {
    marginTop: space.xl,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line2,
  },
});
