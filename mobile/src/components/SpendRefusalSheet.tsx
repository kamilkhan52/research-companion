import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, StyleSheet, View } from 'react-native';

import { apiGet, ApiError } from '@/api/client';
import { BottomSheet } from '@/components/BottomSheet';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';
import { Button, Icon, Text } from '@/ui';

export type SpendRefusalKind = 'exhausted' | 'busy' | 'too_large' | 'rate_limited';

export interface SpendRefusalOptions {
  /** Re-run the complete client flow, including attaching to the accepted background job. */
  retry?: () => void | Promise<unknown>;
  operation?: 'narration' | 'other';
  /** Optional real device-voice handoff. Without one the CTA opens Audio settings. */
  useDeviceVoice?: () => void | Promise<unknown>;
}

interface PresentedRefusal extends SpendRefusalOptions {
  error: ApiError;
  kind: SpendRefusalKind;
  shownAt: number;
}

let dispatch: ((refusal: PresentedRefusal) => void) | null = null;

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/** Classify only the refusal RESPONSE. Plan warnings and held usage never call this. */
export function classifySpendRefusal(error: unknown): SpendRefusalKind | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 429 && error.code === 'holds_outstanding') return 'busy';
  if (error.status === 429 && error.code === 'rate_limited') return 'rate_limited';
  if (error.status !== 402 || error.code !== 'quota_exceeded') return null;
  if (
    error.requested_nanousd != null
    && error.limit_nanousd != null
    && error.requested_nanousd > error.limit_nanousd
  ) return 'too_large';
  return 'exhausted';
}

/** Present a refusal globally and tell the caller whether its raw error was consumed. */
export function presentSpendRefusal(
  error: unknown,
  options: SpendRefusalOptions = {},
): boolean {
  const kind = classifySpendRefusal(error);
  if (!kind || !dispatch) return false;
  dispatch({ error: error as ApiError, kind, shownAt: monotonicNow(), ...options });
  return true;
}

/** Job continuations retain only safe server text, not an HTTP response body. */
export function presentSpendJobRefusal(
  message: string | null | undefined,
  options: SpendRefusalOptions = {},
): boolean {
  if (!message) return false;
  if (message === 'Your other tasks are still running. Give them a moment and try again.') {
    return presentSpendRefusal(new ApiError(429, message, {
      code: 'holds_outstanding', retryAfterSeconds: 15,
    }), options);
  }
  if (message === 'This task needs more than your whole monthly allowance.') {
    return presentSpendRefusal(new ApiError(402, message, {
      code: 'quota_exceeded', requested_nanousd: 1, limit_nanousd: 0,
    }), options);
  }
  if (message === 'Your usage limit has been reached. Try again after it resets.') {
    return presentSpendRefusal(new ApiError(402, message, {
      code: 'quota_exceeded', requested_nanousd: 0, limit_nanousd: 1,
    }), options);
  }
  return false;
}

export function resetLabel(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function secondsRemaining(refusal: PresentedRefusal, now: number): number {
  const wait = Math.max(0, Math.ceil(refusal.error.retryAfterSeconds ?? 1));
  return Math.max(0, wait - Math.floor((now - refusal.shownAt) / 1000));
}

export function SpendRefusalHost() {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [refusal, setRefusal] = useState<PresentedRefusal | null>(null);
  const [now, setNow] = useState(monotonicNow());
  const [reset, setReset] = useState<string | null>(null);
  const headingRef = useRef<View>(null);

  useEffect(() => {
    dispatch = (next) => {
      setNow(monotonicNow());
      setReset(null);
      setRefusal(next);
    };
    return () => {
      dispatch = null;
    };
  }, []);

  useEffect(() => {
    if (!refusal || (refusal.kind !== 'busy' && refusal.kind !== 'rate_limited')) return;
    const interval = setInterval(() => setNow(monotonicNow()), 250);
    return () => clearInterval(interval);
  }, [refusal]);

  useEffect(() => {
    if (refusal?.kind !== 'exhausted') return;
    let current = true;
    apiGet<{ period_ends: string }>('/api/plan')
      .then((plan) => {
        if (current) setReset(resetLabel(plan.period_ends));
      })
      .catch(() => {
        // The refusal remains useful without inventing a date. Plan & usage can retry the read.
      });
    return () => { current = false; };
  }, [refusal]);

  useEffect(() => {
    if (!refusal) return;
    const frame = requestAnimationFrame(() => {
      const tag = findNodeHandle(headingRef.current);
      if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
    });
    return () => cancelAnimationFrame(frame);
  }, [refusal]);

  const close = useCallback(() => setRefusal(null), []);
  if (!refusal) return null;

  const countdown = secondsRemaining(refusal, now);
  const timed = refusal.kind === 'busy' || refusal.kind === 'rate_limited';
  const icon = refusal.kind === 'busy' || refusal.kind === 'rate_limited'
    ? 'clock' : refusal.kind === 'too_large' ? 'minimize-2' : 'calendar';
  const accent = timed ? t.amber : t.violet;

  let title: string;
  let body: string;
  if (refusal.kind === 'exhausted') {
    title = "This month's allowance is used.";
    body = reset
      ? `Paid work returns ${reset}. Reading anything already retrieved, hand-editing notes, and device voice still work.`
      : 'Paid work returns when the monthly allowance resets. Reading anything already retrieved, hand-editing notes, and device voice still work.';
  } else if (refusal.kind === 'busy') {
    title = 'A few things are finishing.';
    body = 'Work already running has a little room set aside. That room returns within seconds when it finishes.';
  } else if (refusal.kind === 'rate_limited') {
    title = 'New work is starting too quickly.';
    body = 'Scholiast limits how quickly new work can start. Wait a few seconds, then try again.';
  } else {
    title = "This won't fit your plan.";
    body = refusal.operation === 'narration'
      ? "This studio-voice version is larger than your plan's whole monthly allowance. Waiting won't help."
      : "This action is larger than your plan's whole monthly allowance. Waiting won't help; choose a smaller action.";
  }

  const retry = () => {
    if (countdown > 0 || !refusal.retry) return;
    const action = refusal.retry;
    close();
    void action();
  };

  const useDeviceVoice = () => {
    const action = refusal.useDeviceVoice;
    close();
    if (action) void action();
    else router.push('/settings');
  };

  return (
    <BottomSheet visible onClose={close} maxHeightPct={75}>
      <View style={styles.sheet}>
        <View style={[styles.icon, { backgroundColor: timed ? t.amberWash : t.violetWash }]}>
          <Icon name={icon} size={24} color={accent} />
        </View>
        <View
          ref={headingRef}
          accessible
          accessibilityRole="header"
          accessibilityLabel={title}
        >
          <Text variant="editorial" style={styles.title}>{title}</Text>
        </View>
        <Text variant="body" color={t.muted} style={styles.body}>{body}</Text>

        {refusal.kind === 'exhausted' && reset ? (
          <View style={[styles.notice, { borderColor: t.violet, backgroundColor: t.violetWash }]}>
            <View style={[styles.dot, { backgroundColor: t.violet }]} />
            <Text variant="label" color={t.violet} style={styles.supportingMin}>Resets {reset}</Text>
          </View>
        ) : null}

        {timed ? (
          <Button
            title={countdown > 0 ? `Try again in ${countdown}s` : 'Try again'}
            onPress={retry}
            disabled={countdown > 0 || !refusal.retry}
            style={styles.primary}
            accessibilityLiveRegion="polite"
          />
        ) : refusal.kind === 'exhausted' ? (
          <>
            <Button title="Keep reading" onPress={close} style={styles.primary} />
            <Button
              title="View plan & usage"
              variant="ghost"
              onPress={() => {
                close();
                router.push('/plan' as never);
              }}
              style={styles.secondary}
            />
          </>
        ) : refusal.kind === 'too_large' && refusal.operation === 'narration' ? (
          <>
            <Button title="Use device voice" onPress={useDeviceVoice} style={styles.primary} />
            <Button title="Not now" variant="ghost" onPress={close} style={styles.secondary} />
          </>
        ) : (
          <Button title="Choose a smaller action" onPress={close} style={styles.primary} />
        )}

        {timed ? (
          <Button title="Not now" variant="ghost" onPress={close} style={styles.secondary} />
        ) : null}
      </View>
    </BottomSheet>
  );
}

const makeStyles = (_t: ThemePalette) => StyleSheet.create({
  sheet: { paddingBottom: space.sm },
  icon: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { marginTop: space.md },
  // Spend-adjacent copy opts out of Tight's smaller shared variants.
  body: { marginTop: space.sm, fontSize: 15, lineHeight: 23 },
  supportingMin: { fontSize: 13 },
  notice: {
    minHeight: 54,
    borderWidth: 1,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    marginTop: space.lg,
  },
  dot: { width: 8, height: 8, borderRadius: radius.pill },
  primary: { marginTop: space.lg },
  secondary: { marginTop: space.sm },
});
