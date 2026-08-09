// Plan & usage surface (`docs/plan-usage-surface-spec.md`).
//
// The properties asserted here are the ones the spec calls load-bearing, and each corresponds to a
// way the screen could mislead someone about money: showing holds as spend, showing a confident
// zero when nothing is known, or showing an allowance on a deployment that applies none.

import { QueryClientProvider } from '@tanstack/react-query';
import { renderAsync, waitFor } from '@testing-library/react-native';

import PlanScreen, { formatResetDate, formatSpentPercent, spentPercent } from '@/app/plan';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { Plan } from '@/api/types';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { createTestQueryClient } from './queryClient';

const mockBack = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, replace: mockReplace, push: jest.fn(), canGoBack: () => true }),
  // Runs the effect once, like a focused screen.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const { useEffect } = require('react');
    useEffect(() => cb(), [cb]);
  },
}));

function plan(
  overrides: Omit<Partial<Plan>, 'plan'> & { plan?: Partial<Plan['plan']> } = {},
): Plan {
  const { plan: planOverrides, ...rest } = overrides;
  return {
    plan: {
      name: 'basic',
      summary: '20 papers a month, 45 minutes of studio narration',
      premium_audio: true,
      monthly_credits: 2500,
      ...planOverrides,
    },
    limit_nanousd: 2_500_000_000,
    spent_nanousd: 450_000_000,
    held_nanousd: 0,
    remaining_nanousd: 2_050_000_000,
    spent_fraction: 0.18,
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
  // The plan query is gated on a configured server, same as every other app-global query.
  await setBaseUrl('https://api.test');
});

test('the bar and its accessibility label report spend alone, never spend plus holds', async () => {
  // 18% spent with a large hold in flight. Adding them would read 50% — the false "nearly out"
  // alarm the separate fields exist to prevent.
  jest.mocked(api.getPlan).mockResolvedValue(
    plan({ spent_fraction: 0.18, held_nanousd: 800_000_000 }),
  );

  const view = await renderScreen();

  await waitFor(() => view.getByText('18%'));
  view.getByLabelText("18 percent of this month's allowance used.");
  expect(view.queryByText('50%')).toBeNull();

  // The BAR itself, not just the caption beside it. Asserting only the text let the bar be
  // switched to spend+held with every test still green — the one rule the spec calls
  // load-bearing, unguarded. 32% of the allowance is held here; the fill must ignore it.
  const fill = view.getByTestId('plan-spend-bar');
  expect(fill.props.style.width).toBe('18%');
});

test('a live hold gets its own card, with no percentage of its own', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan({ held_nanousd: 800_000_000 }));

  const view = await renderScreen();

  await waitFor(() => view.getByText('IN PROGRESS NOW'));
  view.getByText('Some work is finishing');
  view.getByLabelText(
    'Work in progress. Some allowance is temporarily set aside and returns when the work finishes.',
  );
});

test('no hold means no live-work card at all', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan({ held_nanousd: 0 }));

  const view = await renderScreen();

  await waitFor(() => view.getByText('18%'));
  expect(view.queryByText('IN PROGRESS NOW')).toBeNull();
});

test('the approaching card keys off SPEND, so holds alone never trigger it', async () => {
  // Exactly the case the server's `warn` flag fires on — spend under the line, spend+holds over
  // it. The detail screen must stay quiet, because the month is not nearly gone.
  jest.mocked(api.getPlan).mockResolvedValue(
    plan({ spent_fraction: 0.76, held_nanousd: 810_000_000, warn: true, at_capacity: true }),
  );

  const view = await renderScreen();

  await waitFor(() => view.getByText('76%'));
  expect(view.queryByText("You're getting close")).toBeNull();
});

test('spend past the warning line does show the approaching card, and blocks nothing', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan({ spent_fraction: 0.86, warn: true }));

  const view = await renderScreen();

  await waitFor(() => view.getByText("You're getting close"));
  view.getByText(
    "Nothing is blocked. Scholiast will keep working until this month's allowance is used.",
  );
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

  await waitFor(() => view.getByText(/Usage isn't available right now/));
  expect(view.queryByText('0%')).toBeNull();
});

test('neither credits nor dollars reach the reader', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan({ held_nanousd: 800_000_000 }));

  const view = await renderScreen();

  await waitFor(() => view.getByText('18%'));
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

test('the reset date is the server period, not the device timezone', () => {
  // The exact date, not just the prefix. Asserting `/^Resets /` passed happily while every user
  // west of Greenwich was told "Resets August 31" — a date on which nothing resets.
  expect(formatResetDate('2026-09-01T00:00:00+00:00')).toBe('Resets September 1');
  expect(formatResetDate('2026-09-01T00:00:00+00:00')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(formatResetDate('2026-09-01T00:00:00+00:00')).not.toMatch(/day/i);
  expect(formatResetDate('not a date')).toBeNull();
});

test('the displayed percentage never flatters, at either end', () => {
  // Real spend must never read as a flat 0%, and a limit that has not been reached must never
  // read as 100%. Both are claims about money that the number cannot support.
  expect(formatSpentPercent(0.0001)).toBe('<1%');
  expect(formatSpentPercent(0.996)).toBe('>99%');
  expect(formatSpentPercent(1)).toBe('100%');
  expect(formatSpentPercent(1.04)).toBe('100%');
  expect(formatSpentPercent(0)).toBe('0%');
  expect(formatSpentPercent(Number.NaN)).toBe('0%');
  // The interior rounds rather than floors, so 79.9% is not reported as 79%.
  expect(formatSpentPercent(0.799)).toBe('80%');
  expect(spentPercent(0.799)).toBe(80);
});

test('focusing the screen refetches, since window focus does not exist in React Native', async () => {
  jest.mocked(api.getPlan).mockResolvedValue(plan());

  const view = await renderScreen();
  await waitFor(() => view.getByText('18%'));

  // Two: the query's own initial fetch, plus the focus refetch. Returning from a paid turn to a
  // stale figure was the failure this guards.
  expect(jest.mocked(api.getPlan).mock.calls.length).toBeGreaterThanOrEqual(2);
});
