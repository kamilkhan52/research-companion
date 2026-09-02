// The dispatch heartbeat banner (2026-09-01). Before it, the spawn toast was the only feedback
// a dispatch ever gave: a session mid-way through a feature build looked exactly like one that
// had died on its first refused tool call, for tens of minutes at a time.
//
// DR-121 (2026-09-02) added the collapse and the dismissal, which is why every assertion here is
// now awaited: the banner reads its persisted dismissal before it renders anything, so a
// synchronous `getByText` would look at the frame before that load resolved.

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

import { fireEvent, render, waitFor } from '@testing-library/react-native';

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

/** Render and wait for the persisted-dismissal read to resolve, so the banner is on screen. */
async function show(s: DispatchStatus) {
  const view = render(<DispatchBanner status={s} />);
  await view.findByTestId('devtest-dispatch-status');
  return view;
}

/** As above, then open the details — what an ENDED dispatch needs, since it starts collapsed. */
async function showOpen(s: DispatchStatus) {
  const view = await show(s);
  fireEvent.press(view.getByTestId('devtest-dispatch-status-toggle'));
  return view;
}

test('a running session shows what it is doing, that it is moving, and for how long', async () => {
  // Running is ACTIVE, so it opens itself: this is the case DR-121 deliberately did not collapse.
  const { getByText } = await show(base);
  getByText('opus is on DR-115');
  getByText('22m');                                    // 1340s, read at a glance
  // The turn summary reads as a sentence, so it wins over the raw tool call.
  getByText('wiring the rail into the chat screen');
  getByText(/47 steps/);
});

test('with no turn summary yet it falls back to the raw tool call', async () => {
  const { getByText } = await show(status({ last_summary: null }));
  getByText('Edit: mobile/src/components/ChatNavRail.tsx');
});

test('a finished session says so and points at the reply', async () => {
  const { getByText } = await showOpen(status({
    state: 'finished', elapsed_s: 930, last_summary: null,
    result: { is_error: false, subtype: 'success', text: 'Opened PR #467', cost_usd: 1.25,
              num_turns: 42, denials: 0, duration_ms: 930000 },
  }));
  getByText('opus finished DR-115');
  getByText('Opened PR #467');
  getByText(/42 turns/);
  getByText(/check the item below for its reply/);
});

test('a failed session surfaces its refused steps', async () => {
  // The DR-092 failure mode: a headless session cannot ask, so a denial is final and the
  // session sits there looking idle rather than blocked. The count has to reach the phone.
  const { getByText } = await showOpen(status({
    state: 'failed', last_summary: null,
    result: { is_error: true, subtype: 'error_during_execution', text: 'hit the turn limit',
              cost_usd: 0.5, num_turns: 3, denials: 6, duration_ms: 1000 },
  }));
  getByText('opus failed on DR-115');
  getByText('hit the turn limit');
  getByText(/6 refused/);
});

test('a session that wrote nothing says no reply is coming', async () => {
  // `gone` is the state that most needs saying out loud — waiting longer will not help.
  const { getByText } = await showOpen(status({
    state: 'gone', ended_reason: 'process gone', steps: 0, last_summary: null, last_step: null,
  }));
  getByText('opus stopped without replying (process gone)');
  getByText(/no step detail/);
});

test('a batch dispatch names the batch rather than an item id', async () => {
  const { getByText } = await show(status({ item_id: null }));
  getByText('opus is on all pending issues');
});

test('an elapsed time the server could not date degrades instead of showing 0s', async () => {
  const { getByText } = await show(status({ elapsed_s: null }));
  getByText('just started');
});

test('an hour-plus session reads in hours and minutes', async () => {
  const { getByText } = await show(status({ elapsed_s: 3900 }));
  getByText('1h 05m');
});

test('a session stopped by the usage limit says so, and offers to pick it up', async () => {
  // Not a failure and not styled as one: nothing is wrong with the work, the account ran out
  // of window. What matters is when it reopens and that resuming keeps the context.
  // Rate-limited counts as ACTIVE for DR-121: there is a decision outstanding, so it opens
  // itself rather than hiding the reopening time behind a tap.
  const { getByText, getByTestId } = await show(status({
    state: 'rate_limited', last_summary: null, resumable: true,
    rate_limit: { status: 'rejected', scope: 'five_hour', resets_at: Date.now() / 1000 + 3600 },
    result: null,
  }));
  getByText('opus hit the usage limit on DR-115');
  getByText(/window reopens in 1h 00m/);
  getByText(/Resuming keeps everything it had worked out/);
  // Not "check the item for its reply" — there is no reply, and there will not be one until
  // it resumes.
  expect(() => getByText(/check the item below for its reply/)).toThrow();
  getByTestId('devtest-dispatch-resume');
});

test('resume is held back until the window has actually reopened', async () => {
  const { getByText } = await show(status({
    state: 'rate_limited', last_summary: null, resumable: true,
    rate_limit: { status: 'rejected', scope: 'five_hour', resets_at: Date.now() / 1000 + 1800 },
    result: null,
  }));
  getByText('Resume in 30m');           // pressing early would only earn another refusal
});

test('an already-reopened window offers resume immediately', async () => {
  const { getByText } = await show(status({
    state: 'rate_limited', last_summary: null, resumable: true,
    rate_limit: { status: 'rejected', scope: 'five_hour', resets_at: Date.now() / 1000 - 60 },
    result: null,
  }));
  getByText('Resume where it stopped');
});

test('no resume offer on the endings that are not resumable', async () => {
  // A finished session has nothing to continue; a failed one should be READ, not carried on.
  for (const state of ['finished', 'failed', 'gone'] as const) {
    const { queryByTestId } = await show(status({ state, last_summary: null, resumable: false }));
    expect(queryByTestId('devtest-dispatch-resume')).toBeNull();
  }
});

// ---------- DR-121: "the dispatch status takes up too much space" ----------

test('an ended dispatch is one line until you ask for the rest', async () => {
  // The complaint's core: this banner sits in the sheet's FIXED header, so a session that
  // finished days ago was costing four-plus lines above every list of items, permanently.
  const ended = status({
    state: 'finished', last_summary: null,
    result: { is_error: false, subtype: 'success', text: 'Opened PR #467', cost_usd: 1,
              num_turns: 42, denials: 0, duration_ms: 1000 },
  });
  const { getByText, queryByText, getByTestId } = await show(ended);
  getByText('opus finished DR-115');                   // the headline always survives
  expect(queryByText('Opened PR #467')).toBeNull();    // the detail does not
  expect(queryByText(/42 turns/)).toBeNull();

  fireEvent.press(getByTestId('devtest-dispatch-status-toggle'));
  getByText('Opened PR #467');
  fireEvent.press(getByTestId('devtest-dispatch-status-toggle'));
  expect(queryByText('Opened PR #467')).toBeNull();    // and it collapses again
});

test('a running dispatch can be collapsed by hand but is never collapsed for you', async () => {
  const { getByText, queryByText, getByTestId } = await show(base);
  getByText('wiring the rail into the chat screen');
  fireEvent.press(getByTestId('devtest-dispatch-status-toggle'));
  expect(queryByText('wiring the rail into the chat screen')).toBeNull();
});

test('an ended dispatch can be dismissed to nothing, and stays dismissed', async () => {
  // "When dispatch is not active, ideally we should be able to see no status."
  const ended = status({ state: 'finished', last_summary: null });
  const { getByTestId, queryByTestId } = await show(ended);
  fireEvent.press(getByTestId('devtest-dispatch-status-dismiss'));
  await waitFor(() => expect(queryByTestId('devtest-dispatch-status')).toBeNull());

  // Re-mounting is what happens every time he reopens the sheet — the Modal renders no children
  // while hidden. The dismissal is persisted precisely so that does not bring it back.
  const again = render(<DispatchBanner status={ended} />);
  await waitFor(() => expect(again.queryByTestId('devtest-dispatch-status')).toBeNull());
  // Give the load every chance to resolve into a visible banner before trusting the null.
  await new Promise((r) => setTimeout(r, 0));
  expect(again.queryByTestId('devtest-dispatch-status')).toBeNull();
});

test('a dismissal does not hide the NEXT dispatch, or this one changing state', async () => {
  const ended = status({ state: 'finished', last_summary: null });
  const { getByTestId, queryByTestId } = await show(ended);
  fireEvent.press(getByTestId('devtest-dispatch-status-dismiss'));
  await waitFor(() => expect(queryByTestId('devtest-dispatch-status')).toBeNull());

  // A different session — the whole point of the banner is that this one is visible.
  const next = await show(status({ id: 'dispatch-2', state: 'running' }));
  next.getByText('opus is on DR-115');

  // And the same session in a different state: a dismissed `running` (were it ever dismissable)
  // must not swallow the `failed` that follows it.
  const changed = await show(status({ state: 'failed', last_summary: null }));
  changed.getByText('opus failed on DR-115');
});

test('a live dispatch cannot be dismissed, and neither can one waiting to resume', async () => {
  // Dismissing a running session would hide the heartbeat while it is still spending; dismissing
  // a rate-limited one would hide the Resume button that is the only way to pick it back up.
  const live = await show(base);
  expect(live.queryByTestId('devtest-dispatch-status-dismiss')).toBeNull();

  const limited = await show(status({
    state: 'rate_limited', last_summary: null, resumable: true,
    rate_limit: { status: 'rejected', scope: 'five_hour', resets_at: Date.now() / 1000 - 60 },
    result: null,
  }));
  expect(limited.queryByTestId('devtest-dispatch-status-dismiss')).toBeNull();
});

test('collapsing never hides Resume, the one action the banner carries', async () => {
  const limited = await show(status({
    state: 'rate_limited', last_summary: null, resumable: true,
    rate_limit: { status: 'rejected', scope: 'five_hour', resets_at: Date.now() / 1000 - 60 },
    result: null,
  }));
  fireEvent.press(limited.getByTestId('devtest-dispatch-status-toggle'));
  expect(limited.queryByText(/Resuming keeps everything/)).toBeNull();   // details did collapse
  limited.getByTestId('devtest-dispatch-resume');                        // the action did not
});
