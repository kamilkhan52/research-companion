// Plan & usage detail screen — `docs/plan-usage-surface-spec.md`.
//
// Two rules from that spec are load-bearing and easy to undo by accident:
//
// 1. **Spent and held never share a bar.** `spent_fraction` owns the violet bar; live holds get
//    their own amber card with no percentage and no shared axis. Stacking them, or rendering
//    `remaining_nanousd` (which subtracts holds) as "left this month", tells a reader with three
//    jobs in flight that their month is nearly gone when they have barely spent anything. That
//    false alarm is the entire reason the endpoint reports the two separately.
// 2. **The reader sees neither credits nor dollars.** A credit balance looks precise without being
//    actionable — nobody can predict whether the next paper costs 8 credits or 800. Percentage of
//    allowance, the reset date, and the plan's promise in reading terms are the whole surface.
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
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';
import { Button, Card, Icon, ProgressBar, Screen, Text } from '@/ui';

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

/** Whole-percent spend, for `accessibilityValue`'s numeric slot only. Never build the spoken
 *  label from it: at the boundaries it rounds to the same 0/100 that `formatSpentPercent` exists
 *  to avoid, so a screen-reader user would hear the exact false claim a sighted one is protected
 *  from. Use `spokenPercent`. */
export function spentPercent(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(100, Math.round(fraction * 100));
}

/** The percentage spoken aloud — the same claim the visible number makes. */
export function spokenPercent(fraction: number): string {
  const shown = formatSpentPercent(fraction);
  if (shown === '<1%') return 'Less than 1 percent';
  if (shown === '>99%') return 'More than 99 percent';
  return `${shown.replace('%', '')} percent`;
}

/** The percentage as the reader sees it.
 *
 *  Neither rounding rule is safe on its own at the ends, and both failures are about money.
 *  Flooring shows real spend as a flat `0%`, which claims nothing has been spent. Rounding shows
 *  99.6% as `100%`, which claims the allowance is gone while work is still permitted. So the
 *  interior rounds — never systematically flattering — and the two ends say `<1%` and `>99%`,
 *  which are true at every value they cover. `100%` is reserved for actually reaching the limit. */
export function formatSpentPercent(fraction: number): string {
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
  const percent = spentPercent(plan.spent_fraction);
  const percentLabel = formatSpentPercent(plan.spent_fraction);
  const resets = formatResetDate(plan.period_ends);
  // The 80% card keys off SPEND alone, matching the bar beside it. See the header note.
  const approaching = plan.spent_fraction >= plan.warn_at_fraction && plan.spent_fraction < 1;

  return (
    <>
      <Card>
        <Text variant="overline" color={t.muted}>YOUR PLAN</Text>
        <Text variant="heading" style={styles.planName}>{planLabel(plan.plan.name)}</Text>
        {/* Server copy verbatim: it is the single source of what this plan promises. */}
        <Text variant="body" color={t.muted} style={[styles.cardBody, styles.bodyMin]}>{plan.plan.summary}</Text>
        <View style={styles.audioRow}>
          <Icon name={plan.plan.premium_audio ? 'volume-2' : 'smartphone'} size={14} color={t.muted} />
          <Text variant="caption" color={t.muted} style={[styles.audioLabel, styles.supportingMin]}>
            {plan.plan.premium_audio ? 'Studio narration included' : 'Device voice'}
          </Text>
        </View>
      </Card>

      {plan.usage_available ? (
        <Card style={styles.spaced}>
          <Text variant="overline" color={t.muted}>THIS MONTH</Text>
          <Text variant="display" style={styles.percent}>{percentLabel}</Text>
          <Text variant="body" color={t.muted} style={[styles.cardBody, styles.bodyMin]}>of your monthly allowance used</Text>
          <View
            style={styles.bar}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={`${spokenPercent(plan.spent_fraction)} of this month's allowance used.`}
            // `text` as well as `now`: the numeric slot is rounded, so at 0.01% it announces 0 and
            // at 99.6% it announces 100 — the boundary claims the visible text avoids. A
            // progressbar's value is announced independently of its label, so without `text` a
            // screen-reader user still hears the false number.
            accessibilityValue={{ min: 0, max: 100, now: percent, text: spokenPercent(plan.spent_fraction) }}
          >
            <ProgressBar
              testID="plan-spend-bar"
              value={plan.spent_fraction}
              color={t.violet}
              height={8}
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
        <Card style={styles.spaced}>
          <Text variant="overline" color={t.muted}>THIS MONTH</Text>
          <Text variant="body" color={t.muted} style={[styles.cardBody, styles.bodyMin]}>
            Usage isn't available right now. Your allowance is unchanged — pull down to try again.
          </Text>
        </Card>
      )}

      {approaching ? (
        <Card style={[styles.spaced, styles.noticeCard, { borderColor: t.amberLine, backgroundColor: t.amberWash }]}>
          <Text variant="heading" color={t.amber}>You're getting close</Text>
          <Text variant="body" color={t.muted} style={[styles.cardBody, styles.bodyMin]}>
            Scholiast keeps working until this month's allowance is used.
          </Text>
        </Card>
      ) : null}

      {plan.held_nanousd > 0 ? (
        <Card
          style={[styles.spaced, styles.noticeCard, { borderColor: t.amberLine, backgroundColor: t.amberWash }]}
          accessible
          accessibilityLabel={
            'Work in progress. Some allowance is set aside while it runs. Whatever the work costs '
            + 'is added above; the rest is released.'
          }
        >
          <View style={styles.audioRow}>
            <Icon name="activity" size={14} color={t.amber} />
            <Text variant="overline" color={t.amber} style={styles.audioLabel}>IN PROGRESS NOW</Text>
          </View>
          <Text variant="heading" style={styles.planName}>Some work is finishing</Text>
          {/* Deliberately no percentage and no shared axis with the bar above. */}
          <Text variant="body" color={t.muted} style={[styles.cardBody, styles.bodyMin]}>
            Room is set aside while it runs. What the work costs is added above when it finishes;
            the rest is released.
          </Text>
        </Card>
      ) : null}
    </>
  );
}

function makeStyles(t: ThemePalette) {
  return StyleSheet.create({
    // The spec fixes minimum type sizes for this surface: body >=15, supporting >=13. The shared
    // variants do not meet them — `body` drops to 14 under Tight density and `caption` is 12.5
    // even at Comfortable. Overriding here rather than changing the variants, because Tight is a
    // deliberate app-wide preference (DR-028) and this is one screen asking to opt out of it:
    // misreading a number about money costs more than the density it buys back.
    bodyMin: { fontSize: 15 },
    supportingMin: { fontSize: 13 },
    content: { padding: space.lg, paddingBottom: space.xl },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
    centeredText: { textAlign: 'center' },
    spaced: { marginTop: space.md },
    planName: { marginTop: space.xs },
    cardBody: { marginTop: space.xs },
    supporting: { marginTop: space.xs },
    audioRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.sm },
    audioLabel: { marginLeft: space.xs },
    percent: { marginTop: space.xs, color: t.violet, fontFamily: fonts.bodySemiBold },
    bar: { marginTop: space.md },
    resetRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.md },
    resetLabel: { marginLeft: space.xs },
    noticeCard: { borderWidth: 1, borderRadius: radius.md },
    cardAction: { marginTop: space.md },
  });
}
