// Global mini-player: a slim bar that appears whenever a narration track is loaded. Play/pause,
// 15s skips, and a scrubber — reflecting TrackPlayer state so it stays in sync with lock-screen
// and background playback. Rendered in the root layout so audio persists across navigation.

import Slider from '@react-native-community/slider';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, {
  useActiveTrack,
  useIsPlaying,
  useProgress,
} from 'react-native-track-player';

import { SKIP_SECONDS } from '@/audio/setup';
import { Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function NowPlaying() {
  const insets = useSafeAreaInsets();
  const track = useActiveTrack();
  const { playing } = useIsPlaying();
  const { position, duration } = useProgress(500);
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  if (!track) return null;

  const value = scrubbing ?? position;

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      <View style={styles.row}>
        <Pressable
          onPress={() => playing ? TrackPlayer.pause() : TrackPlayer.play()}
          hitSlop={8}
          style={styles.playBtn}
          accessibilityLabel={playing ? 'Pause' : 'Play'}>
          <Text style={styles.playGlyph}>{playing ? '❚❚' : '►'}</Text>
        </Pressable>

        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="heading" numberOfLines={1}>
            {track.title ?? 'Narration'}
          </Text>
          <Text variant="caption">
            {fmt(value)} {duration ? `/ ${fmt(duration)}` : ''}
          </Text>
        </View>

        <Pressable
          onPress={() => TrackPlayer.seekBy(-SKIP_SECONDS)}
          hitSlop={8}
          style={styles.skipBtn}
          accessibilityLabel={`Back ${SKIP_SECONDS} seconds`}>
          <Text style={styles.skipGlyph}>«{SKIP_SECONDS}</Text>
        </Pressable>
        <Pressable
          onPress={() => TrackPlayer.seekBy(SKIP_SECONDS)}
          hitSlop={8}
          style={styles.skipBtn}
          accessibilityLabel={`Forward ${SKIP_SECONDS} seconds`}>
          <Text style={styles.skipGlyph}>{SKIP_SECONDS}»</Text>
        </Pressable>
      </View>

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
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.bg2,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: { color: colors.cyanInk, fontSize: 16, fontFamily: 'Manrope_700Bold' },
  skipBtn: {
    height: 40,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipGlyph: { color: colors.text, fontSize: 12, fontFamily: 'Manrope_600SemiBold' },
  slider: { width: '100%', height: 32 },
});
