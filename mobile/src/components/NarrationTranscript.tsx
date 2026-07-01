// The spoken narration, shown as a follow-along transcript beneath an assistant message while
// its audio is prepared/played. OpenAI TTS returns no word/sentence timings, so the highlight
// is an *approximation*: playback position / duration is mapped proportionally onto each
// sentence's share of the total character count. It tracks the audio closely enough to guide
// the eye without pretending to be frame-accurate. Only the currently-playing message mounts
// this, so exactly one useProgress poller is ever active.

import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useProgress } from 'react-native-track-player';

import { Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

interface Sentence {
  text: string;
  startFrac: number;
  endFrac: number;
}

/** Split into sentences (keeping short fragments intact) and tag each with the [start, end)
 *  fraction of the total text it occupies — the basis for the proportional highlight. */
function splitSentences(text: string): Sentence[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [trimmed];
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  let acc = 0;
  const out: Sentence[] = [];
  for (const p of parts) {
    const start = acc;
    acc += p.length;
    const t = p.trim();
    if (t) out.push({ text: t, startFrac: start / total, endFrac: acc / total });
  }
  return out;
}

export function NarrationTranscript({ narration }: { narration: string }) {
  // Poll ~4x/sec: smooth enough for sentence-level following, cheap enough to ignore.
  const { position, duration } = useProgress(250);
  const sentences = useMemo(() => splitSentences(narration), [narration]);

  // Only highlight once playback has actually started and we know the duration; before that
  // (duration 0) show the plain transcript rather than pinning the first sentence.
  const frac = duration > 0 ? Math.min(1, position / duration) : -1;
  const activeIdx =
    frac < 0 ? -1 : sentences.findIndex((s) => frac >= s.startFrac && frac < s.endFrac);

  return (
    <View style={styles.wrap}>
      <Text variant="caption" color={colors.muted} style={styles.label}>
        Transcript
      </Text>
      <Text variant="body">
        {sentences.map((s, i) => (
          <Text key={i} style={i === activeIdx ? styles.active : undefined}>
            {s.text + ' '}
          </Text>
        ))}
      </Text>
    </View>
  );
}

/** Indeterminate sweep bar shown while audio is being generated. There's no real percentage
 *  (narrate + speak are opaque LLM/TTS calls), so this communicates "working" honestly with a
 *  stage label rather than a fake filling progress bar. */
export function GeneratingBar({ stage }: { stage: 'narrating' | 'synthesizing' }) {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
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
  }, [x]);

  const translateX = x.interpolate({ inputRange: [0, 1], outputRange: ['-40%', '260%'] });
  const label = stage === 'narrating' ? 'Adapting for listening…' : 'Synthesizing audio…';

  return (
    <View style={styles.genWrap}>
      <Text variant="caption" color={colors.cyan}>
        {label}
      </Text>
      <View style={styles.track}>
        <Animated.View style={[styles.sweep, { transform: [{ translateX }] }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  label: {
    marginBottom: space.sm,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  active: {
    color: colors.cyan,
    backgroundColor: colors.cyanInk,
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
    backgroundColor: colors.cyan,
  },
});
