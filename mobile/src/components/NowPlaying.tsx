// Global mini-player: a slim bar that appears whenever audio is being PREPARED or a narration
// track is loaded, so the user always knows what the audio system is doing from anywhere in
// the app. Deliberately minimal — play/pause, title + status, a hairline progress strip, and
// dismiss; tapping the bar expands into the full-screen player (app/player.tsx), which owns
// the rolling transcript, scrubber, and skips. Rendered in the root layout so audio persists
// across navigation.

import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, {
  State,
  useActiveTrack,
  useIsPlaying,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';

import { useAudio } from '@/audio/AudioProvider';
import { prepLabel } from '@/components/NarrationTranscript';
import { Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const openPlayer = () => router.push('/player');

export function NowPlaying() {
  const insets = useSafeAreaInsets();
  const audio = useAudio();
  const track = useActiveTrack();
  const { playing } = useIsPlaying();
  const { state } = usePlaybackState();
  const { position, duration } = useProgress(500);

  const bottomPad = { paddingBottom: Math.max(insets.bottom, space.sm) };

  // Preparing (nothing loaded yet): announce the stage + real progress; tap for the big view.
  if (!track) {
    if (!audio.prep) return null;
    const { stage, done, total, title } = audio.prep;
    const determinate = stage === 'synthesizing' && total > 0;
    return (
      <Pressable onPress={openPlayer} style={[styles.bar, bottomPad]} accessibilityLabel="Open player">
        <View style={styles.progressStrip}>
          <View
            style={[
              styles.progressFill,
              { width: determinate ? `${Math.round((done / total) * 100)}%` : '8%' },
            ]}
          />
        </View>
        <View style={styles.row}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="heading" numberOfLines={1}>{title}</Text>
            <Text variant="caption" color={colors.cyan}>{prepLabel(stage, done, total)}</Text>
          </View>
          <Pressable
            onPress={audio.cancelPrep}
            hitSlop={8}
            style={styles.sideBtn}
            accessibilityLabel="Cancel audio preparation">
            <Text style={styles.sideGlyph}>✕</Text>
          </Pressable>
        </View>
      </Pressable>
    );
  }

  const buffering = state === State.Buffering || state === State.Loading;
  const status = buffering
    ? 'Buffering…'
    : `${fmt(position)} ${duration ? `/ ${fmt(duration)}` : ''}${playing ? '' : ' · paused'}`;

  return (
    <Pressable onPress={openPlayer} style={[styles.bar, bottomPad]} accessibilityLabel="Open player">
      <View style={styles.progressStrip}>
        <View
          style={[
            styles.progressFill,
            { width: duration ? `${Math.min(100, (position / duration) * 100)}%` : '0%' },
          ]}
        />
      </View>
      <View style={styles.row}>
        <Pressable
          onPress={async () => {
            if (playing) {
              await TrackPlayer.pause();
            } else {
              const { state: s } = await TrackPlayer.getPlaybackState();
              if (s === State.Ended) await TrackPlayer.seekTo(0);
              await TrackPlayer.play();
            }
          }}
          hitSlop={8}
          style={styles.playBtn}
          accessibilityLabel={playing ? 'Pause' : 'Play'}>
          <Text style={styles.playGlyph}>{playing ? '❚❚' : '▶︎'}</Text>
        </Pressable>

        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="heading" numberOfLines={1}>
            {track.title ?? 'Narration'}
          </Text>
          <Text variant="caption" color={buffering ? colors.cyan : undefined}>
            {status}
          </Text>
        </View>

        <Text style={styles.expandGlyph}>⌃</Text>
        <Pressable
          onPress={() => void audio.dismiss()}
          hitSlop={8}
          style={styles.sideBtn}
          accessibilityLabel="Close player">
          <Text style={styles.sideGlyph}>✕</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.bg2,
    paddingHorizontal: space.md,
  },
  progressStrip: {
    height: 2,
    marginHorizontal: -space.md, // full-bleed across the bar
    backgroundColor: colors.line,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.cyan },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.sm },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: { color: colors.cyanInk, fontSize: 16, fontFamily: 'Manrope_700Bold' },
  expandGlyph: { color: colors.muted, fontSize: 16, paddingHorizontal: 2 },
  sideBtn: {
    height: 40,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sideGlyph: { color: colors.text, fontSize: 12, fontFamily: 'Manrope_600SemiBold' },
});
