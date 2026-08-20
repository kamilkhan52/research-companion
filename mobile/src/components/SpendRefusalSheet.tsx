import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, StyleSheet, View } from 'react-native';

import { apiGet, ApiError } from '@/api/client';
import type { SpendRefusalPayload } from '@/api/types';
import { BottomSheet } from '@/components/BottomSheet';
import { useTheme, useThemedStyles, type DensityMode } from '@/theme/ThemeProvider';
import { moneyType, space, type ThemePalette } from '@/theme/tokens';
import { Button, Icon, Text, ToneIcon, ToneSurface, type SurfaceTone } from '@/ui';

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

/** A refusal delivered on a JOB snapshot rather than as an HTTP response (DR-049): the server's
 *  `refusal_payload()` — the same dict the admission handler answers with — stamped onto the
 *  job by the registry. The client classifies `code`; the prose in `detail` is display copy the
 *  server may edit freely. (This replaced an exact-prose matcher that pinned three server
 *  messages to a client release.) */
export function presentSpendJobRefusal(
  refusal: SpendRefusalPayload | null | undefined,
  options: SpendRefusalOptions = {},
): boolean {
  if (!refusal?.code || !refusal.detail) return false;
  if (refusal.code === 'holds_outstanding' || refusal.code === 'rate_limited') {
    return presentSpendRefusal(new ApiError(429, refusal.detail, {
      code: refusal.code,
      retryAfterSeconds: refusal.retry_after_seconds ?? 15,
    }), options);
  }
  if (refusal.code === 'quota_exceeded') {
    return presentSpendRefusal(new ApiError(402, refusal.detail, {
      code: 'quota_exceeded',
      requested_nanousd: refusal.requested_nanousd,
      limit_nanousd: refusal.limit_nanousd,
    }), options);
  }
  // Unknown codes (e.g. quota_unavailable) fall through to the caller's generic error
  // handling — a sheet that guesses at a state it does not understand is worse than a toast.
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
  const tone: SurfaceTone = timed ? 'amber' : 'violet';
  const accent = tone === 'amber' ? t.amber : t.violet;

  let title: string;
  let body: string;
  let eyebrow: string;
  if (refusal.kind === 'exhausted') {
    eyebrow = 'MONTHLY ALLOWANCE';
    title = "This month's allowance is used.";
    body = reset
      ? `Paid work returns ${reset}. Reading anything already retrieved, hand-editing notes, and device voice still work.`
      : 'Paid work returns when the monthly allowance resets. Reading anything already retrieved, hand-editing notes, and device voice still work.';
  } else if (refusal.kind === 'busy') {
    eyebrow = 'WORK IN PROGRESS';
    title = 'A few things are finishing.';
    body = 'Work already running has a little room set aside. That room returns within seconds when it finishes.';
  } else if (refusal.kind === 'rate_limited') {
    eyebrow = 'TRY AGAIN SHORTLY';
    title = 'New work is starting too quickly.';
    body = 'Seminar limits how quickly new work can start. Wait a few seconds, then try again.';
  } else {
    eyebrow = refusal.operation === 'narration' ? 'NARRATION' : 'THIS ACTION';
    title = refusal.operation === 'narration'
      ? "This narration won't fit your plan."
      : "This action won't fit your plan.";
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
        <ToneIcon name={icon} tone={tone} />
        <Text variant="overline" color={accent} style={styles.eyebrow}>{eyebrow}</Text>
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
          <ToneSurface tone="violet" style={styles.notice}>
            <Icon name="calendar" size={16} color={t.violet} />
            <View style={styles.noticeCopy}>
              <Text variant="overline" color={t.violet}>PAID WORK RETURNS</Text>
              <Text variant="label" color={t.text} style={styles.supportingMin}>Resets {reset}</Text>
            </View>
          </ToneSurface>
        ) : refusal.kind === 'too_large' && refusal.operation === 'narration' ? (
          <ToneSurface tone="violet" style={styles.notice}>
            <Icon name="smartphone" size={16} color={t.violet} />
            <View style={styles.noticeCopy}>
              <Text variant="overline" color={t.violet}>AVAILABLE NOW</Text>
              <Text variant="label" color={t.text} style={styles.supportingMin}>Device voice is included</Text>
            </View>
          </ToneSurface>
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

const makeStyles = (_t: ThemePalette, density: DensityMode) => StyleSheet.create({
  sheet: { paddingBottom: space.sm, paddingTop: density === 'tight' ? 0 : space.xs },
  eyebrow: { marginTop: space.md },
  title: {
    marginTop: space.xs,
    fontSize: density === 'tight' ? 27 : 29,
    lineHeight: density === 'tight' ? 32 : 35,
  },
  // Spend-adjacent copy opts out of Tight's smaller shared variants.
  body: { marginTop: space.sm, fontSize: moneyType.body, lineHeight: moneyType.bodyLine },
  supportingMin: { fontSize: moneyType.supporting, lineHeight: moneyType.supportingLine },
  notice: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.lg,
  },
  noticeCopy: { flex: 1, minWidth: 0, gap: 2 },
  primary: { marginTop: space.lg },
  secondary: { marginTop: space.sm },
});
