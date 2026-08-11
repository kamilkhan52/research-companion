// Plan & usage detail screen — `docs/plan-usage-surface-spec.md`.
//
// Two rules from that spec are load-bearing and easy to undo by accident:
//
// 1. **Spent and held never share a bar.** The remaining figure is `limit - spent`; live holds get
//    their own amber card with no percentage and no shared axis. Rendering `remaining_nanousd`
//    (which subtracts holds) tells a reader with three jobs in flight that their month is nearly
//    gone when they have barely spent anything. That false alarm is the entire reason the endpoint
//    reports the two separately.
// 2. **The reader sees neither credits nor dollars.** A credit balance looks precise without being
//    actionable — nobody can predict whether the next paper costs 8 credits or 800. Percentage of
//    allowance remaining, the reset date, and the plan's promise in reading terms are the whole
//    surface.
//
// The screen also does not render `plan.warn`, which the server computes from spend PLUS holds so
// that it can precede a refusal. That is the right signal next to a refusal and the wrong one here:
// on this screen it would say the month is nearly gone because something is running.

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { usePlan } from '@/api/queries';
import type { Plan } from '@/api/types';
import { TopBar } from '@/components/TopBar';
import { useTheme, useThemedStyles, type DensityMode } from '@/theme/ThemeProvider';
import { fonts, moneyType, space, type ThemePalette } from '@/theme/tokens';
import {
  AnimatedProgressBar,
  Button,
  Card,
  Chip,
  Icon,
  Screen,
  Text,
  ToneIcon,
  ToneSurface,
} from '@/ui';

/** Display names only. The plan's PROMISE comes from `plan.summary` and nothing else: an operator
 *  override changes the enforced limit without changing the plan, so a second copy of "20 papers a
 *  month" living here would keep making that promise after the server had withdrawn it. */
const PLAN_LABELS: Record<string, string> = {
  tester: 'Tester',
  free: 'Free',
  basic: 'Basic',
};

function planLabel(name: string): string {
  return PLAN_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/** `Resets September 1` — a calendar date, never a raw ISO string and never "days left", which
 *  drifts across midnight and reads as a countdown the allowance is not.
 *
 *  Formatted in **UTC**, because that is the period the server actually resets on
 *  (`quotas.calendar_month` builds a UTC month boundary). Rendering the device's local date turned
 *  `2026-09-01T00:00:00Z` into "Resets August 31" everywhere west of Greenwich — a date on which
 *  nothing resets, told to the reader waiting for it. */
export function formatResetDate(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const date = when.toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  return `Resets ${date}`;
}

/** The spend-only share still available. `remaining_nanousd` is deliberately absent: that field
 *  subtracts holds, while this screen gives work in progress its own truthful treatment. */
export function remainingFraction(limitNanousd: number, spentNanousd: number): number {
  if (!Number.isFinite(limitNanousd) || limitNanousd <= 0) return 0;
  if (!Number.isFinite(spentNanousd)) return 0;
  return Math.max(0, Math.min(1, (limitNanousd - spentNanousd) / limitNanousd));
}

/** Whole-percent remaining, for `accessibilityValue`'s numeric slot only. Never build the spoken
 *  label from it: boundary rounding can say 0/100 when the visible label correctly says <1/>99. */
export function remainingPercent(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(100, Math.round(fraction * 100));
}

/** The percentage spoken aloud — the same claim the visible number makes. */
export function spokenRemainingPercent(fraction: number): string {
  const shown = formatRemainingPercent(fraction);
  if (shown === '<1%') return 'Less than 1 percent';
  if (shown === '>99%') return 'More than 99 percent';
  return `${shown.replace('%', '')} percent`;
}

/** The percentage as the reader sees it.
 *
 *  Neither rounding rule is safe on its own at the ends. Flooring a sliver of real room to `0%`
 *  claims nothing remains; rounding 99.6% to `100%` claims the allowance is untouched. The
 *  interior rounds, while the two open ends say `<1%` and `>99%`. */
export function formatRemainingPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  if (fraction >= 1) return '100%';
  const rounded = Math.round(fraction * 100);
  if (rounded <= 0) return '<1%';
  if (rounded >= 100) return '>99%';
  return `${rounded}%`;
}

export default function PlanScreen() {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const query = usePlan();
  const { refetch } = query;
  const plan = query.data;

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  }, [router]);

  // Enforcement can end while this screen is open (sign-out, or a config/connectivity change).
  // LEAVE, rather than explain: the spec's rule is that an unenforced deployment shows nothing
  // about allowances at all, and an "allowance unavailable" page is still a page about the
  // allowance. It also strands the reader one tap from where they were.
  const unenforced = plan != null && !plan.enforced;
  useEffect(() => {
    if (unenforced) goBack();
  }, [unenforced, goBack]);

  // Refetch when the screen is focused. `refetchOnWindowFocus` does nothing here: React Native
  // has no window focus events unless a `focusManager` bridge is installed, and Expo Router's
  // screen focus is a separate concept. Without this the reader can return from a paid turn to a
  // stale figure.
  // `refetch` and not `query`: TanStack's result object is a new reference on every render, so
  // depending on it recreates this callback, `useFocusEffect` re-runs it, and that starts another
  // fetch — a refetch loop for as long as the screen is open.
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  if (unenforced) return null;

  return (
    <Screen>
      <TopBar title="Plan & usage" onBack={goBack} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => { void query.refetch(); }}
            tintColor={t.muted}
          />
        }
      >
        {query.isLoading ? (
          <Text variant="body" color={t.muted} style={styles.bodyMin}>Loading your plan…</Text>
        ) : query.isError || !plan ? (
          <Card>
            <Text variant="heading">Couldn't load your plan</Text>
            <Text variant="body" color={t.muted} style={[styles.cardBody, styles.bodyMin]}>
              This only affects what this screen can show. Your allowance is unchanged.
            </Text>
            <Button title="Try again" onPress={() => { void query.refetch(); }} style={styles.cardAction} />
          </Card>
        ) : (
          <PlanBody plan={plan} />
        )}
      </ScrollView>
    </Screen>
  );
}

function PlanBody({ plan }: { plan: Plan }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const remaining = remainingFraction(plan.limit_nanousd, plan.spent_nanousd);
  const percent = remainingPercent(remaining);
  const percentLabel = formatRemainingPercent(remaining);
  const resets = formatResetDate(plan.period_ends);
  // The 80% card keys off the server's SPEND fraction; the remaining bar is its complement.
  // Keep the upper bound so the approaching treatment never appears once the allowance is gone.
  const approaching = plan.spent_fraction >= plan.warn_at_fraction && plan.spent_fraction < 1;

  return (
    <>
      <View style={styles.hero}>
        <Text variant="overline" color={t.violet}>MONTHLY READING</Text>
        <Text variant="editorial" style={styles.heroTitle}>Your allowance</Text>
        <Text variant="body" color={t.muted} style={[styles.heroBody, styles.bodyMin]}>
          Room for the analysis and narration that support your reading.
        </Text>
      </View>

      {plan.usage_available ? (
        <Card style={styles.allowanceCard}>
          <View style={styles.cardHeader}>
            <Text variant="overline" color={t.muted}>REMAINING THIS MONTH</Text>
            <Icon name="book-open" size={17} color={t.violet} />
          </View>
          <View style={styles.percentRow}>
            <Text variant="display" style={styles.percent}>{percentLabel}</Text>
            <Text variant="body" color={t.muted} style={[styles.remainingLabel, styles.bodyMin]}>
              remaining
            </Text>
          </View>
          <View
            style={styles.bar}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={`${spokenRemainingPercent(remaining)} of this month's allowance remaining.`}
            // `text` as well as `now`: the numeric slot is rounded, so at 0.01% it announces 0 and
            // at 99.6% it announces 100 — the boundary claims the visible text avoids. A
            // progressbar's value is announced independently of its label, so without `text` a
            // screen-reader user still hears the false number.
            accessibilityValue={{ min: 0, max: 100, now: percent, text: spokenRemainingPercent(remaining) }}
          >
            <AnimatedProgressBar
              testID="plan-remaining-bar"
              value={remaining}
              color={t.violet}
            />
          </View>
          {resets ? (
            <View style={styles.resetRow}>
              <Icon name="calendar" size={14} color={t.muted} />
              <Text variant="caption" color={t.muted} style={[styles.resetLabel, styles.supportingMin]}>{resets}</Text>
            </View>
          ) : null}
        </Card>
      ) : (
        // `enforced` is true but this read failed. Saying "0% used" here would be the most
        // misleading pair the screen could show: a full allowance at the moment it cannot be read.
        <ToneSurface tone="neutral" style={styles.spaced}>
          <View style={styles.noticeHeading}>
            <ToneIcon name="refresh-cw" compact />
            <Text variant="heading">Usage is taking a moment</Text>
          </View>
          <Text variant="body" color={t.muted} style={[styles.cardBody, styles.bodyMin]}>
            Your allowance is unchanged. Pull down to try again.
          </Text>
        </ToneSurface>
      )}

      {approaching ? (
        <ToneSurface tone="amber" style={styles.spaced}>
          <View style={styles.noticeHeading}>
            <ToneIcon name="info" tone="amber" compact />
            <Text variant="heading" color={t.amber}>A little room remains</Text>
          </View>
          <Text variant="body" color={t.muted} style={[styles.cardBody, styles.bodyMin]}>
            Nothing changes until the allowance reaches zero. Scholiast keeps working in the meantime.
          </Text>
        </ToneSurface>
      ) : null}

      {plan.held_nanousd > 0 ? (
        <ToneSurface
          tone="amber"
          style={styles.spaced}
          accessible
          accessibilityLabel={
            'Work in progress. Some allowance is set aside while it runs. Whatever the work costs '
            + 'is added above; the rest is released.'
          }
        >
          <View style={styles.noticeHeading}>
            <ToneIcon name="activity" tone="amber" compact />
            <View style={styles.noticeCopy}>
              <Text variant="overline" color={t.amber}>IN PROGRESS NOW</Text>
              <Text variant="heading" style={styles.noticeTitle}>Some work is finishing</Text>
            </View>
          </View>
          {/* Deliberately no percentage and no shared axis with the bar above. */}
          <Text variant="body" color={t.muted} style={[styles.cardBody, styles.bodyMin]}>
            Room is set aside while it runs. What the work costs is added above when it finishes;
            the rest is released.
          </Text>
        </ToneSurface>
      ) : null}

      <Card style={[styles.spaced, styles.planCard]}>
        <View style={styles.planHeader}>
          <ToneIcon name="bookmark" tone="violet" />
          <View style={styles.planCopy}>
            <Text variant="overline" color={t.muted}>YOUR PLAN</Text>
            <View style={styles.planLabelRow}>
              <Chip label={planLabel(plan.plan.name)} color={t.violet} dot={false} />
            </View>
          </View>
        </View>
        {/* Server copy verbatim: it is the single source of what this plan promises. */}
        <Text variant="body" color={t.muted} style={[styles.planSummary, styles.bodyMin]}>{plan.plan.summary}</Text>
      </Card>
    </>
  );
}

function makeStyles(t: ThemePalette, density: DensityMode) {
  const tight = density === 'tight';
  return StyleSheet.create({
    // The spec fixes minimum type sizes for this surface: body >=15, supporting >=13. The shared
    // variants do not meet them — `body` drops to 14 under Tight density and `caption` is 12.5
    // even at Comfortable. Overriding here rather than changing the variants, because Tight is a
    // deliberate app-wide preference (DR-028) and this is one screen asking to opt out of it:
    // misreading a number about money costs more than the density it buys back.
    bodyMin: { fontSize: moneyType.body, lineHeight: moneyType.bodyLine },
    supportingMin: { fontSize: moneyType.supporting, lineHeight: moneyType.supportingLine },
    content: { paddingHorizontal: space.lg, paddingTop: tight ? space.sm : space.md, paddingBottom: space.xxl },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
    centeredText: { textAlign: 'center' },
    spaced: { marginTop: space.md },
    hero: { paddingHorizontal: tight ? space.xs : space.sm, marginBottom: tight ? space.md : space.lg },
    heroTitle: { marginTop: space.xs, fontSize: tight ? 27 : 30, lineHeight: tight ? 32 : 36 },
    heroBody: { marginTop: space.xs, maxWidth: 330 },
    allowanceCard: { backgroundColor: t.elevated, padding: tight ? space.lg : space.xl },
    cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    percentRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, marginTop: space.sm },
    remainingLabel: { paddingBottom: tight ? 2 : 3 },
    cardBody: { marginTop: space.xs },
    percent: { color: t.violet, fontFamily: fonts.bodySemiBold, fontSize: tight ? 34 : 38, lineHeight: tight ? 40 : 44 },
    bar: { marginTop: space.lg },
    resetRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.md },
    resetLabel: { marginLeft: space.xs },
    noticeHeading: { flexDirection: 'row', alignItems: 'center', gap: space.md },
    noticeCopy: { flex: 1, minWidth: 0 },
    noticeTitle: { marginTop: 2 },
    planCard: { backgroundColor: t.surface },
    planHeader: { flexDirection: 'row', alignItems: 'center', gap: space.md },
    planCopy: { flex: 1, minWidth: 0 },
    planLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.xs },
    planSummary: { marginTop: space.md },
    cardAction: { marginTop: space.md },
  });
}
