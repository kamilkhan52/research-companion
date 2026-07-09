// The spoken narration as a ROLLING transcript — the lyrics view of the full-screen player.
// OpenAI TTS returns no word/sentence timings, so the follow-along is an *approximation*:
// playback position / duration is mapped proportionally onto each sentence's share of the
// total character count. It tracks the audio closely enough to guide the eye without
// pretending to be frame-accurate. The active sentence is prominent and auto-centered;
// neighbors are dimmed for orientation; tapping a sentence seeks to (approximately) its start.
// Also home to GeneratingBar/prepLabel, the audio-preparation progress UI.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import TrackPlayer, { useActiveTrack } from 'react-native-track-player';

import { splitSentences, type SentenceBoundary } from '../../sentence-seek';
import { useSmoothPosition } from '@/audio/useSmoothPosition';
import { activeSentenceIndex, globalFraction, segmentForChar } from '@/audio/transcriptSync';
import { Text } from '@/ui';
import { colors, fonts, radius, space } from '@/theme/tokens';


/** How long a manual scroll suspends auto-follow, so the roll never fights the user's thumb. */
const FOLLOW_RESUME_MS = 4000;
/** Highlight slightly AHEAD of the estimated position. The proportional mapping plus the eye's
 *  reaction time both make a "exact" highlight feel late; a small preemptive lead reads right. */
const LEAD_S = 0.35;

/** One transcript sentence. Memoized (with stable handlers) so the 10Hz position clock in the
 *  parent only re-renders the two lines whose active state actually changed; the highlight
 *  crossfades instead of snapping. */
const TranscriptLine = memo(function TranscriptLine({
  index,
  text,
  active,
  onPress,
  onLayout,
}: {
  index: number;
  text: string;
  active: boolean;
  onPress: (i: number) => void;
  onLayout: (i: number, y: number, h: number) => void;
}) {
  const glow = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(glow, {
      toValue: active ? 1 : 0,
      duration: 200,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [active, glow]);

  return (
    <Pressable
      onPress={() => onPress(index)}
      onLayout={(e) => onLayout(index, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}>
      <Animated.Text
        style={[
          styles.line,
          { opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) },
        ]}>
        {text}
      </Animated.Text>
    </Pressable>
  );
});

export function RollingTranscript({ narration }: { narration: string }) {
  // Smooth, dead-reckoned playback clock (see useSmoothPosition) instead of raw coarse polls.
  const { position, duration } = useSmoothPosition();
  const sentences = useMemo(() => splitSentences(narration), [narration]);

  // Progressive narration (#28) plays as several segment tracks, each reporting its own
  // position/duration. `useActiveTrack` tells us which segment is playing; we load the char
  // length of every segment for this slot so playback maps back onto the whole-narration
  // fractions above instead of resetting each segment.
  const active = useActiveTrack();
  const slotId = active?.slotId != null ? String(active.slotId) : null;
  const activeSeg = typeof active?.segmentIndex === 'number' ? active.segmentIndex : -1;
  const [segLens, setSegLens] = useState<number[]>([]);

  useEffect(() => {
    if (slotId == null || activeSeg < 0) {
      setSegLens((cur) => (cur.length ? [] : cur));
      return;
    }
    let cancelled = false;
    // Re-read as playback advances: later segments are still being appended, so the queue grows.
    TrackPlayer.getQueue().then((queue) => {
      if (cancelled) return;
      const lens: number[] = [];
      for (const track of queue) {
        const sId = track.slotId != null ? String(track.slotId) : String(track.id);
        if (sId !== slotId || typeof track.segmentIndex !== 'number') continue;
        lens[track.segmentIndex] = String(track.sentenceText ?? '').length || 1;
      }
      setSegLens(lens);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [slotId, activeSeg]);

  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef<Record<number, { y: number; h: number }>>({});
  const viewportH = useRef(0);
  // Timestamp until which auto-follow stays suspended (user is reading somewhere else).
  const followPausedUntil = useRef(0);
  const lastCentered = useRef(-1);

  // Only highlight once playback has actually started and we know the duration; before that
  // (duration 0) show the plain roll rather than pinning the first sentence.
  const progressive = activeSeg >= 0 && segLens.length > 0;
  const frac = duration <= 0
    ? -1
    : progressive
      ? globalFraction({
          segLens, activeSeg, within: (position + LEAD_S) / duration, totalChars: narration.length,
        })
      : Math.min(1, (position + LEAD_S) / duration);
  const activeIdx = activeSentenceIndex(sentences, frac);

  useEffect(() => {
    if (activeIdx < 0 || activeIdx === lastCentered.current) return;
    if (Date.now() < followPausedUntil.current) return;
    const line = offsets.current[activeIdx];
    if (!line || !viewportH.current) return;
    lastCentered.current = activeIdx;
    scrollRef.current?.scrollTo({
      y: Math.max(0, line.y + line.h / 2 - viewportH.current / 2),
      animated: true,
    });
  }, [activeIdx]);

  // Stable handlers (reading live values through refs) so TranscriptLine's memo holds.
  const stateRef = useRef({ sentences, duration, progressive, segLens, slotId, total: narration.length });
  stateRef.current = { sentences, duration, progressive, segLens, slotId, total: narration.length };
  const handlePress = useCallback((i: number) => {
    const { sentences: ss, duration: d, progressive: prog, segLens: lens, slotId: slot, total } = stateRef.current;
    followPausedUntil.current = 0; // jumping is an explicit "take me there" — resume follow
    lastCentered.current = -1;
    if (prog && slot != null && total > 0) {
      // Map the tapped sentence's whole-narration char position back to its segment track, skip
      // there, then seek within that segment. Segment durations are proportional to char length.
      const { index, within } = segmentForChar(lens, ss[i].startFrac * total);
      void (async () => {
        const queue = await TrackPlayer.getQueue();
        const qi = queue.findIndex((t) =>
          (t.slotId != null ? String(t.slotId) : String(t.id)) === slot && t.segmentIndex === index);
        if (qi < 0) return;
        await TrackPlayer.skip(qi);
        const { duration: segDur } = await TrackPlayer.getProgress();
        if (segDur > 0 && within > 0) await TrackPlayer.seekTo(within * segDur);
      })();
    } else if (d > 0) {
      void TrackPlayer.seekTo(ss[i].startFrac * d);
    }
  }, []);
  const handleLayout = useCallback((i: number, y: number, h: number) => {
    offsets.current[i] = { y, h };
  }, []);

  // Pad half a viewport top and bottom so the first/last sentences can still center.
  const pad = viewportH.current / 2;

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.roll}
      contentContainerStyle={{ paddingTop: pad, paddingBottom: pad }}
      showsVerticalScrollIndicator={false}
      onLayout={(e) => {
        viewportH.current = e.nativeEvent.layout.height;
      }}
      onScrollBeginDrag={() => {
        followPausedUntil.current = Date.now() + FOLLOW_RESUME_MS;
      }}>
      {sentences.map((s, i) => (
        <TranscriptLine
          key={i}
          index={i}
          text={s.text}
          active={i === activeIdx}
          onPress={handlePress}
          onLayout={handleLayout}
        />
      ))}
    </ScrollView>
  );
}

export function prepLabel(stage: 'starting' | 'narrating' | 'synthesizing', done: number, total: number): string {
  if (stage === 'narrating') return 'Adapting for listening…';
  if (stage === 'synthesizing') {
    return total > 1 ? `Synthesizing audio — part ${Math.min(done + 1, total)} of ${total}…` : 'Synthesizing audio…';
  }
  return 'Preparing…';
}

/** Progress bar shown while audio is being generated. The narrating stage is an opaque LLM
 *  call (indeterminate sweep, honestly labeled); synthesis reports real per-segment progress
 *  from the server job, so the bar actually fills. */
export function GeneratingBar({
  stage,
  done = 0,
  total = 0,
}: {
  stage: 'starting' | 'narrating' | 'synthesizing';
  done?: number;
  total?: number;
}) {
  const x = useRef(new Animated.Value(0)).current;
  const determinate = stage === 'synthesizing' && total > 0;
  useEffect(() => {
    if (determinate) return;
    const loop = Animated.loop(
      Animated.timing(x, {
        toValue: 1,
        duration: 1100,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [x, determinate]);

  const translateX = x.interpolate({ inputRange: [0, 1], outputRange: ['-40%', '260%'] });

  return (
    <View style={styles.genWrap}>
      <Text variant="caption" color={colors.mint}>
        {prepLabel(stage, done, total)}
      </Text>
      <View style={styles.track}>
        {determinate ? (
          <View style={[styles.fill, { width: `${Math.round((done / total) * 100)}%` }]} />
        ) : (
          <Animated.View style={[styles.sweep, { transform: [{ translateX }] }]} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  roll: { flex: 1, paddingHorizontal: space.lg },
  line: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 21,
    lineHeight: 32,
    color: colors.text, // dimming is the animated opacity, so inactive lines still read muted
    paddingVertical: space.sm,
  },
  genWrap: {
    marginTop: space.md,
    gap: space.sm,
  },
  track: {
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.line,
    overflow: 'hidden',
  },
  sweep: {
    width: '40%',
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.mint,
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.mint,
  },
});
