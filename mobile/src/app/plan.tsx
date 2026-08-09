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

import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { usePlan } from '@/api/queries';
import type { Plan } from '@/api/types';
import { TopBar } from '@/components/TopBar';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';
import { Button, Card, Icon, ProgressBar, Screen, Text } from '@/ui';

/** Plan promise in reading terms. `plan.summary` is authoritative and rendered verbatim; this only
 *  supplies the display label and the supporting line the spec specifies per plan. */
const PLAN_LABELS: Record<string, { label: string; supporting: string }> = {
  tester: {
    label: 'Tester',
    supporting: 'Testing plan — generous allowance while the app is in review',
  },
  free: { label: 'Free', supporting: "3–4 papers a month, your device's voice" },
  basic: { label: 'Basic', supporting: '20 papers a month, 45 minutes of studio narration' },
};

function planLabel(name: string): string {
  return PLAN_LABELS[name]?.label ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/** `Resets September 1` — a local calendar date, never a raw ISO string and never "days left",
 *  which drifts across midnight and reads as a countdown the allowance is not. */
export function formatResetDate(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return `Resets ${when.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`;
}

/** Whole-percent spend, floored so 99.6% never renders as a reassuring "100%" while work is still
 *  permitted, and clamped because a settled overshoot can push the fraction just past 1. */
export function spentPercent(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(100, Math.floor(fraction * 100));
}

export default function PlanScreen() {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const query = usePlan();
  const plan = query.data;

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  }, [router]);

  // Enforcement can end while this screen is open (sign-out, or a config/connectivity change).
  // Leave rather than fall back to a zeroed bar: a confident "0% used" would be a claim about an
  // allowance this deployment is no longer applying.
  if (plan && !plan.enforced) {
    return (
      <Screen>
        <TopBar title="Plan & usage" onBack={goBack} />
        <View style={styles.centered}>
          <Text variant="body" color={t.muted} style={styles.centeredText}>
            This server is not applying a monthly allowance.
          </Text>
          <Button title="Back to settings" onPress={goBack} style={{ marginTop: space.md }} />
        </View>
      </Screen>
    );
  }

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
          <Text variant="body" color={t.muted}>Loading your plan…</Text>
        ) : query.isError || !plan ? (
          <Card>
            <Text variant="heading">Couldn't load your plan</Text>
            <Text variant="body" color={t.muted} style={styles.cardBody}>
              Nothing is blocked — this is only the usage view.
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
  const resets = formatResetDate(plan.period_ends);
  const supporting = PLAN_LABELS[plan.plan.name]?.supporting;
  // The 80% card keys off SPEND alone, matching the bar beside it. See the header note.
  const approaching = plan.spent_fraction >= plan.warn_at_fraction && plan.spent_fraction < 1;

  return (
    <>
      <Card>
        <Text variant="overline" color={t.muted}>YOUR PLAN</Text>
        <Text variant="heading" style={styles.planName}>{planLabel(plan.plan.name)}</Text>
        {/* Server copy verbatim: it is the single source of what this plan promises. */}
        <Text variant="body" color={t.muted} style={styles.cardBody}>{plan.plan.summary}</Text>
        {supporting && supporting !== plan.plan.summary ? (
          <Text variant="caption" color={t.muted} style={styles.supporting}>{supporting}</Text>
        ) : null}
        <View style={styles.audioRow}>
          <Icon name={plan.plan.premium_audio ? 'volume-2' : 'smartphone'} size={14} color={t.muted} />
          <Text variant="caption" color={t.muted} style={styles.audioLabel}>
            {plan.plan.premium_audio ? 'Studio narration included' : 'Device voice'}
          </Text>
        </View>
      </Card>

      {plan.usage_available ? (
        <Card style={styles.spaced}>
          <Text variant="overline" color={t.muted}>THIS MONTH</Text>
          <Text variant="display" style={styles.percent}>{percent}%</Text>
          <Text variant="body" color={t.muted} style={styles.cardBody}>of your monthly allowance used</Text>
          <View
            style={styles.bar}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={`${percent} percent of this month's allowance used.`}
            accessibilityValue={{ min: 0, max: 100, now: percent }}
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
              <Text variant="caption" color={t.muted} style={styles.resetLabel}>{resets}</Text>
            </View>
          ) : null}
        </Card>
      ) : (
        // `enforced` is true but this read failed. Saying "0% used" here would be the most
        // misleading pair the screen could show: a full allowance at the moment it cannot be read.
        <Card style={styles.spaced}>
          <Text variant="overline" color={t.muted}>THIS MONTH</Text>
          <Text variant="body" color={t.muted} style={styles.cardBody}>
            Usage isn't available right now. Your allowance is unchanged — pull down to try again.
          </Text>
        </Card>
      )}

      {approaching ? (
        <Card style={[styles.spaced, styles.noticeCard, { borderColor: t.amberLine, backgroundColor: t.amberWash }]}>
          <Text variant="heading" color={t.amber}>You're getting close</Text>
          <Text variant="body" color={t.muted} style={styles.cardBody}>
            Nothing is blocked. Scholiast will keep working until this month's allowance is used.
          </Text>
        </Card>
      ) : null}

      {plan.held_nanousd > 0 ? (
        <Card
          style={[styles.spaced, styles.noticeCard, { borderColor: t.amberLine, backgroundColor: t.amberWash }]}
          accessible
          accessibilityLabel={
            'Work in progress. Some allowance is temporarily set aside and returns when the work finishes.'
          }
        >
          <View style={styles.audioRow}>
            <Icon name="activity" size={14} color={t.amber} />
            <Text variant="overline" color={t.amber} style={styles.audioLabel}>IN PROGRESS NOW</Text>
          </View>
          <Text variant="heading" style={styles.planName}>Some work is finishing</Text>
          {/* Deliberately no percentage and no shared axis with the bar above. */}
          <Text variant="body" color={t.muted} style={styles.cardBody}>
            A little room is temporarily set aside. It returns as the work finishes.
          </Text>
        </Card>
      ) : null}
    </>
  );
}

function makeStyles(t: ThemePalette) {
  return StyleSheet.create({
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
