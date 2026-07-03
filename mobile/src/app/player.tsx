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
import { prepLabel, RollingTranscript } from '@/components/NarrationTranscript';
import { Screen, Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

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
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel="Collapse player">
          <Text style={styles.chevron}>⌄</Text>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="label" style={styles.nowLabel}>
            NOW PLAYING
          </Text>
          <Text variant="heading" numberOfLines={2}>
            {track?.title ?? audio.prep?.title ?? 'Narration'}
          </Text>
        </View>
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
              minimumTrackTintColor={colors.cyan}
              maximumTrackTintColor={colors.line2}
              thumbTintColor={colors.cyan}
              onValueChange={(v) => setScrubbing(v)}
              onSlidingComplete={(v) => {
                TrackPlayer.seekTo(v);
                setScrubbing(null);
              }}
            />
            <View style={styles.timesRow}>
              <Text variant="caption">{fmt(value)}</Text>
              <Text variant="caption" color={buffering ? colors.cyan : colors.muted}>
                {buffering ? 'Buffering…' : playing ? '' : state === State.Ended ? 'Ended' : 'Paused'}
              </Text>
              <Text variant="caption">{duration ? fmt(duration) : '–:––'}</Text>
            </View>

            <View style={styles.buttonsRow}>
              <Pressable
                onPress={() => TrackPlayer.seekBy(-SKIP_SECONDS)}
                hitSlop={8}
                style={styles.skipBtn}
                accessibilityLabel={`Back ${SKIP_SECONDS} seconds`}>
                <Text style={styles.skipGlyph}>«{SKIP_SECONDS}</Text>
              </Pressable>
              <Pressable
                onPress={togglePlay}
                style={styles.playBtn}
                accessibilityLabel={playing ? 'Pause' : 'Play'}>
                {buffering ? (
                  <ActivityIndicator color={colors.cyanInk} />
                ) : (
                  <Text style={styles.playGlyph}>{playing ? '❚❚' : '▶︎'}</Text>
                )}
              </Pressable>
              <Pressable
                onPress={() => TrackPlayer.seekBy(SKIP_SECONDS)}
                hitSlop={8}
                style={styles.skipBtn}
                accessibilityLabel={`Forward ${SKIP_SECONDS} seconds`}>
                <Text style={styles.skipGlyph}>{SKIP_SECONDS}»</Text>
              </Pressable>
            </View>
          </View>
        </>
      ) : audio.prep ? (
        // Opened while audio is still being prepared: show the live stage + real progress,
        // and hand over to the transcript/controls the moment the track loads.
        <View style={styles.centerFill}>
          <ActivityIndicator color={colors.cyan} />
          <Text variant="body" color={colors.cyan} style={{ marginTop: space.md }}>
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

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  chevron: { color: colors.muted, fontSize: 28, lineHeight: 30, paddingHorizontal: 2 },
  nowLabel: { letterSpacing: 1.2, marginBottom: 2 },
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
    justifyContent: 'center',
    gap: space.xl,
    marginTop: space.md,
  },
  playBtn: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: { color: colors.cyanInk, fontSize: 24, fontFamily: 'Manrope_700Bold' },
  skipBtn: {
    height: 52,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipGlyph: { color: colors.text, fontSize: 14, fontFamily: 'Manrope_600SemiBold' },
  prepTrack: {
    width: '70%',
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.line,
    overflow: 'hidden',
    marginTop: space.lg,
  },
  prepFill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.cyan },
  cancelBtn: {
    marginTop: space.xl,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line2,
  },
});
