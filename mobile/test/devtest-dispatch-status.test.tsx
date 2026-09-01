// The dispatch heartbeat banner (2026-09-01). Before it, the spawn toast was the only feedback
// a dispatch ever gave: a session mid-way through a feature build looked exactly like one that
// had died on its first refused tool call, for tens of minutes at a time.

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null, Chat: () => null, InputToolbar: () => null, MessageText: () => null,
}));
jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));

jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn().mockResolvedValue({ items: [] }),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn().mockResolvedValue({ entries: [] }),
  dispatchToClaude: jest.fn(),
  getDispatchStatus: jest.fn().mockResolvedValue({ dispatch: null }),
  resumeDispatch: jest.fn().mockResolvedValue({ dispatch: {} }),
}));

import { render } from '@testing-library/react-native';

import { DispatchBanner } from '@/components/DevTestBubble';
import type { DispatchStatus } from '@/api/endpoints';

const base: DispatchStatus = {
  id: 'dispatch-1', model: 'opus', item_id: 'DR-115', state: 'running',
  started_at: '2026-09-01T08:01:31-0700', elapsed_s: 1340, ended_reason: null,
  steps: 47, last_step: 'Edit: mobile/src/components/ChatNavRail.tsx',
  last_summary: 'wiring the rail into the chat screen', result: null,
  rate_limit: null, resumable: false,
};

const status = (over: Partial<DispatchStatus>): DispatchStatus => ({ ...base, ...over });

test('a running session shows what it is doing, that it is moving, and for how long', () => {
  const { getByText } = render(<DispatchBanner status={base} />);
  getByText('opus is on DR-115');
  getByText('22m');                                    // 1340s, read at a glance
  // The turn summary reads as a sentence, so it wins over the raw tool call.
  getByText('wiring the rail into the chat screen');
  getByText(/47 steps/);
});

test('with no turn summary yet it falls back to the raw tool call', () => {
  const { getByText } = render(
    <DispatchBanner status={status({ last_summary: null })} />);
  getByText('Edit: mobile/src/components/ChatNavRail.tsx');
});

test('a finished session says so and points at the reply', () => {
  const { getByText } = render(<DispatchBanner status={status({
    state: 'finished', elapsed_s: 930, last_summary: null,
    result: { is_error: false, subtype: 'success', text: 'Opened PR #467', cost_usd: 1.25,
              num_turns: 42, denials: 0, duration_ms: 930000 },
  })} />);
  getByText('opus finished DR-115');
  getByText('Opened PR #467');
  getByText(/42 turns/);
  getByText(/check the item below for its reply/);
});

test('a failed session surfaces its refused steps', () => {
  // The DR-092 failure mode: a headless session cannot ask, so a denial is final and the
  // session sits there looking idle rather than blocked. The count has to reach the phone.
  const { getByText } = render(<DispatchBanner status={status({
    state: 'failed', last_summary: null,
    result: { is_error: true, subtype: 'error_during_execution', text: 'hit the turn limit',
              cost_usd: 0.5, num_turns: 3, denials: 6, duration_ms: 1000 },
  })} />);
  getByText('opus failed on DR-115');
  getByText('hit the turn limit');
  getByText(/6 refused/);
});

test('a session that wrote nothing says no reply is coming', () => {
  // `gone` is the state that most needs saying out loud — waiting longer will not help.
  const { getByText } = render(<DispatchBanner status={status({
    state: 'gone', ended_reason: 'process gone', steps: 0, last_summary: null, last_step: null,
  })} />);
  getByText('opus stopped without replying (process gone)');
  getByText(/no step detail/);
});

test('a batch dispatch names the batch rather than an item id', () => {
  const { getByText } = render(<DispatchBanner status={status({ item_id: null })} />);
  getByText('opus is on all pending issues');
});

test('an elapsed time the server could not date degrades instead of showing 0s', () => {
  const { getByText } = render(<DispatchBanner status={status({ elapsed_s: null })} />);
  getByText('just started');
});

test('an hour-plus session reads in hours and minutes', () => {
  const { getByText } = render(<DispatchBanner status={status({ elapsed_s: 3900 })} />);
  getByText('1h 05m');
});

test('a session stopped by the usage limit says so, and offers to pick it up', () => {
  // Not a failure and not styled as one: nothing is wrong with the work, the account ran out
  // of window. What matters is when it reopens and that resuming keeps the context.
  const { getByText, getByTestId } = render(<DispatchBanner status={status({
    state: 'rate_limited', last_summary: null, resumable: true,
    rate_limit: { status: 'rejected', scope: 'five_hour', resets_at: Date.now() / 1000 + 3600 },
    result: null,
  })} />);
  getByText('opus hit the usage limit on DR-115');
  getByText(/window reopens in 1h 00m/);
  getByText(/Resuming keeps everything it had worked out/);
  // Not "check the item for its reply" — there is no reply, and there will not be one until
  // it resumes.
  expect(() => getByText(/check the item below for its reply/)).toThrow();
  getByTestId('devtest-dispatch-resume');
});

test('resume is held back until the window has actually reopened', () => {
  const { getByText } = render(<DispatchBanner status={status({
    state: 'rate_limited', last_summary: null, resumable: true,
    rate_limit: { status: 'rejected', scope: 'five_hour', resets_at: Date.now() / 1000 + 1800 },
    result: null,
  })} />);
  getByText('Resume in 30m');           // pressing early would only earn another refusal
});

test('an already-reopened window offers resume immediately', () => {
  const { getByText } = render(<DispatchBanner status={status({
    state: 'rate_limited', last_summary: null, resumable: true,
    rate_limit: { status: 'rejected', scope: 'five_hour', resets_at: Date.now() / 1000 - 60 },
    result: null,
  })} />);
  getByText('Resume where it stopped');
});

test('no resume offer on the endings that are not resumable', () => {
  // A finished session has nothing to continue; a failed one should be READ, not carried on.
  for (const state of ['finished', 'failed', 'gone'] as const) {
    const { queryByTestId } = render(
      <DispatchBanner status={status({ state, last_summary: null, resumable: false })} />);
    expect(queryByTestId('devtest-dispatch-resume')).toBeNull();
  }
});
