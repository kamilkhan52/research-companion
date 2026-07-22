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
import { checkpointPlayback } from '../../playback-persistence';

import { useAudio } from '@/audio/AudioProvider';
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

export function NowPlaying({ inset = true }: { inset?: boolean }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const audio = useAudio();
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

  const wrapStyle = [styles.wrap, inset && { marginBottom: Math.max(insets.bottom, space.sm) }];

  // Preparing (nothing loaded yet): announce the stage + real progress; tap for the big view.
  if (!track) {
    if (!audio.prep) return null;
    const { stage, done, total, title } = audio.prep;
    const determinate = stage === 'synthesizing' && total > 0;
    return (
      <View style={wrapStyle}>
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
    <View style={wrapStyle}>
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

          <View style={{ flex: 1, minWidth: 0 }}>
            <Marquee
              text={String(track.title ?? 'Narration')}
              textStyle={{ fontFamily: fonts.bodySemiBold, fontSize: 15, lineHeight: 21, color: t.text }}
            />
            <Text variant="caption" color={buffering ? t.mint : undefined} numberOfLines={1}>
              {status}
            </Text>
          </View>

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
    width: 32,
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
