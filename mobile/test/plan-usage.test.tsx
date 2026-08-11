// Plan & usage surface (`docs/plan-usage-surface-spec.md`).
//
// The properties asserted here are the ones the spec calls load-bearing, and each corresponds to a
// way the screen could mislead someone about money: showing holds as spend, showing a confident
// zero when nothing is known, or showing an allowance on a deployment that applies none.

import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderAsync, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, RefreshControl } from 'react-native';

import PlanScreen, {
  formatRemainingPercent,
  formatResetDate,
  remainingFraction,
  remainingPercent,
  spokenRemainingPercent,
} from '@/app/plan';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { Plan } from '@/api/types';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { createTestQueryClient } from './queryClient';

const mockBack = jest.fn();
const mockReplace = jest.fn();
const focusCallbacks: (() => void | (() => void))[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, replace: mockReplace, push: jest.fn(), canGoBack: () => true }),
  // Runs the effect like a focused screen, and records the callback so a test can drive a focus
  // transition explicitly rather than relying on mount.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const { useEffect } = require('react');
    focusCallbacks.push(cb);
    useEffect(() => cb(), [cb]);
  },
}));

function plan(
  overrides: Omit<Partial<Plan>, 'plan'> & { plan?: Partial<Plan['plan']> } = {},
): Plan {
  const { plan: planOverrides, ...rest } = overrides;
  const limit = rest.limit_nanousd ?? 2_500_000_000;
  const spentFraction = rest.spent_fraction ?? 0.18;
  const spent = rest.spent_nanousd ?? Math.round(limit * spentFraction);
  return {
    plan: {
      name: 'basic',
      summary: '20 papers a month, 45 minutes of studio narration',
      monthly_credits: 2500,
      ...planOverrides,
    },
    limit_nanousd: limit,
    spent_nanousd: spent,
    held_nanousd: 0,
    remaining_nanousd: limit - spent,
    spent_fraction: spentFraction,
    warn: false,
    warn_at_fraction: 0.8,
    at_capacity: false,
    period_ends: '2026-09-01T00:00:00+00:00',
    enforced: true,
    usage_available: true,
    ...rest,
  };
}

async function renderScreen() {
  return renderAsync(
    <QueryClientProvider client={createTestQueryClient()}>
      <ThemeProvider>
        <PlanScreen />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  focusCallbacks.length = 0;
  // The plan query is gated on a configured server, same as every other app-global query.
  await setBaseUrl('https://api.test');
});

afterEach(() => jest.restoreAllMocks());

test('the bar reports limit minus spend, never the transport remainder that also subtracts holds', async () => {
  // 18% spent with a large hold in flight. `remaining_nanousd` says 50%, but the truthful
  // spend-only remainder is 82% — work in progress has its own card below.
  jest.mocked(api.getPlan).mockResolvedValue(
    plan({
      spent_fraction: 0.18,
      held_nanousd: 800_000_000,
      remaining_nanousd: 1_250_000_000,
    }),
  );

  const view = await renderScreen();

  await waitFor(() => view.getByText('82%'));
  view.getByLabelText("82 percent of this month's allowance remaining.");
  expect(view.queryByText('50%')).toBeNull();

  // The BAR itself, not just the caption beside it. Asserting only the text let the bar be
  // switched to spend+held with every test still green — the one rule the spec calls
  // load-bearing, unguarded. 32% of the allowance is held here; the fill must ignore it.
  const bar = view.getByTestId('plan-remaining-bar', { includeHiddenElements: true });
  expect(bar.props.accessibilityValue.now).toBe(82);
  expect(remainingFraction(2_500_000_000, 450_000_000)).toBe(0.82);
});

test('a live hold gets its own card, with no percentage of its own', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan({ held_nanousd: 800_000_000 }));

  const view = await renderScreen();

  await waitFor(() => view.getByText('IN PROGRESS NOW'));
  view.getByText('Some work is finishing');
  // The label must not promise the whole hold comes back: what the work costs becomes durable
  // spend, and only the unused remainder is released.
  view.getByLabelText(
    'Work in progress. Some allowance is set aside while it runs. Whatever the work costs is '
    + 'added above; the rest is released.',
  );
});

test('no hold means no live-work card at all', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan({ held_nanousd: 0 }));

  const view = await renderScreen();

  await waitFor(() => view.getByText('82%'));
  expect(view.queryByText('IN PROGRESS NOW')).toBeNull();
});

test('the approaching card keys off SPEND, so holds alone never trigger it', async () => {
  // Exactly the case the server's `warn` flag fires on — spend under the line, spend+holds over
  // it. The detail screen must stay quiet, because the month is not nearly gone.
  jest.mocked(api.getPlan).mockResolvedValue(
    plan({ spent_fraction: 0.76, held_nanousd: 810_000_000, warn: true, at_capacity: true }),
  );

  const view = await renderScreen();

  await waitFor(() => view.getByText('24%'));
  expect(view.queryByText('A little room remains')).toBeNull();
});

test('spend past the warning line does show the approaching card, and blocks nothing', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan({ spent_fraction: 0.86, warn: true }));

  const view = await renderScreen();

  await waitFor(() => view.getByText('A little room remains'));
  // Not "nothing is blocked": holds can fill the remainder, so at 86% spent a new job may still be
  // refused. What stays true is that the allowance itself is not spent.
  view.getByText(/Nothing changes until the allowance reaches zero/);
});

test('an unenforced deployment leaves the screen rather than explaining itself', async () => {
  // An "allowance unavailable" page is still a page about the allowance, and it strands the
  // reader one tap from where they were.
  jest.mocked(api.getPlan).mockResolvedValue(plan({ enforced: false }));

  const view = await renderScreen();

  await waitFor(() => expect(mockBack).toHaveBeenCalled());
  expect(view.queryByText('0%')).toBeNull();
  expect(view.queryByText('THIS MONTH')).toBeNull();
  expect(view.queryByText('YOUR PLAN')).toBeNull();
});

test('an unreadable usage row says so instead of showing a full allowance', async () => {
  // `enforced` true with `usage_available` false is the most misleading pair the screen could
  // render: a confident empty bar at the exact moment every job may be failing closed.
  jest.mocked(api.getPlan).mockResolvedValue(
    plan({ usage_available: false, spent_fraction: 0, spent_nanousd: 0 }),
  );

  const view = await renderScreen();

  await waitFor(() => view.getByText('Usage is taking a moment'));
  view.getByText(/Your allowance is unchanged/);
  expect(view.queryByText('0%')).toBeNull();
});

test('neither credits nor dollars reach the reader', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan({ held_nanousd: 800_000_000 }));

  const view = await renderScreen();

  await waitFor(() => view.getByText('82%'));
  // Asserted against rendered TEXT, not the tree dump: the transport fields are legitimately in
  // the props, and the claim being made is about what a reader can read.
  expect(view.queryAllByText(/\$/)).toHaveLength(0);
  expect(view.queryAllByText(/credit/i)).toHaveLength(0);
  expect(view.queryAllByText(/2[,_ ]?500/)).toHaveLength(0);
  expect(view.queryAllByText(/nano/i)).toHaveLength(0);
});

test('the plan summary is rendered verbatim from the server', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(
    plan({ plan: { name: 'tester', summary: 'A generous allowance while the app is in review' } }),
  );

  const view = await renderScreen();

  await waitFor(() => view.getByText('A generous allowance while the app is in review'));
  view.getByText('Tester');
});

test('the reset date is formatted in the server period, not the device timezone', () => {
  // CI runs in UTC, where the buggy and correct implementations agree — so asserting the date
  // alone is green on CI whether or not the fix is present. Assert the REQUEST instead: the
  // formatter must be told which zone to use.
  const spy = jest.spyOn(Date.prototype, 'toLocaleDateString');
  formatResetDate('2026-09-01T00:00:00+00:00');
  expect(spy).toHaveBeenCalledWith(undefined, expect.objectContaining({ timeZone: 'UTC' }));
  spy.mockRestore();

  expect(formatResetDate('2026-09-01T00:00:00+00:00')).toBe('Resets September 1');
  expect(formatResetDate('2026-09-01T00:00:00+00:00')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(formatResetDate('2026-09-01T00:00:00+00:00')).not.toMatch(/day/i);
  expect(formatResetDate('not a date')).toBeNull();
});

test('the displayed remaining percentage stays truthful at both boundaries', () => {
  expect(formatRemainingPercent(0.0001)).toBe('<1%');
  expect(formatRemainingPercent(0.996)).toBe('>99%');
  expect(formatRemainingPercent(1)).toBe('100%');
  expect(formatRemainingPercent(1.04)).toBe('100%');
  expect(formatRemainingPercent(0)).toBe('0%');
  expect(formatRemainingPercent(Number.NaN)).toBe('0%');
  expect(formatRemainingPercent(0.799)).toBe('80%');
  expect(remainingPercent(0.799)).toBe(80);
  expect(remainingFraction(100, 101)).toBe(0);
  expect(remainingFraction(0, 0)).toBe(0);
});

test('the screen refetches when focus returns to it', async () => {
  // Deleting the whole `useFocusEffect` block left the previous version of this test green: the
  // mock ran the effect alongside the query's own first fetch, so "requests stopped growing" was
  // true either way. Drive a focus transition AFTER the first result and require a new request.
  jest.mocked(api.getPlan)
    .mockResolvedValueOnce(plan({ spent_fraction: 0.18 }))
    .mockResolvedValue(plan({ spent_fraction: 0.42 }));

  const view = await renderScreen();
  await waitFor(() => view.getByText('82%'));

  focusCallbacks.forEach((cb) => cb());
  await waitFor(() => view.getByText('58%'));
});

test('pull to refresh asks the server again', async () => {
  jest.mocked(api.getPlan)
    .mockResolvedValueOnce(plan({ spent_fraction: 0.18 }))
    .mockResolvedValue(plan({ spent_fraction: 0.51 }));

  const view = await renderScreen();
  await waitFor(() => view.getByText('82%'));

  const scroll = view.UNSAFE_getByType(RefreshControl);
  await act(async () => { scroll.props.onRefresh(); });
  await waitFor(() => view.getByText('49%'));
});

test('focus refetching settles rather than looping', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan());

  const view = await renderScreen();
  await waitFor(() => view.getByText('82%'));

  // The request count must STOP growing once the data has arrived. The earlier version of this
  // test asserted ">= 2", which passed happily while an unstable `useFocusEffect` dependency
  // refetched on every render for as long as the screen stayed open. (An exact count is the wrong
  // assertion: the focus refetch fires while the initial fetch is still in flight, and TanStack
  // correctly dedupes the two into one request.)
  const settled = jest.mocked(api.getPlan).mock.calls.length;
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(jest.mocked(api.getPlan).mock.calls.length).toBe(settled);
});

test('what a screen reader hears matches remaining at the boundaries too', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan({ spent_fraction: 0.9999 }));

  const view = await renderScreen();

  await waitFor(() => view.getByText('<1%'));
  view.getByLabelText("Less than 1 percent of this month's allowance remaining.");
  expect(spokenRemainingPercent(0.996)).toBe('More than 99 percent');
  expect(spokenRemainingPercent(0.18)).toBe('18 percent');
  expect(spokenRemainingPercent(1)).toBe('100 percent');
});
