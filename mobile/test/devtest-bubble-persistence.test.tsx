// DR-065 — Kamil: "The bubble should remember the last state. Such as which item was opened,
// any unfinished message... It should be minimize when collapsed and reappear with full
// resumption of previous state." Closing the sheet used to unmount everything and lose it.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

import { DevTestBubble, ItemCard, NewItemForm } from '@/components/DevTestBubble';
import { draftKey } from '@/hooks/usePersistedDraft';
import type { DevTestItem } from '@/api/endpoints';

jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));

jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn().mockResolvedValue({ items: [] }),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn(),
  createDevTestItem: jest.fn().mockResolvedValue({
    item: {
      id: 'NEW-1', title: 'DUPLICATE_RENDER_PROBE_TITLE', state: 'new — untriaged',
      raised: '2026-08-11', how_to_test: '', feedback_count: 0,
    },
  }),
}));

import * as api from '@/api/endpoints';

const ITEM: DevTestItem = {
  id: 'DR-065', state: 'open', raised: '2026-08-11',
  title: 'Bubble should remember its state', how_to_test: '', feedback_count: 0,
};

test('an in-progress remark survives the card unmounting and remounting', async () => {
  const first = render(<ItemCard item={ITEM} shot={null} route="/discover" />);
  fireEvent.press(first.getByText(ITEM.title));
  const input = await first.findByPlaceholderText('Comment (optional for Pass and Fail)');
  fireEvent.changeText(input, 'The search stopped but the indicator kept spinning.');
  // usePersistedDraft debounces its AsyncStorage write (real setTimeout, no fake timers in this
  // suite) — wait for the write to actually land, not just for the input's own state to update,
  // or unmounting races the debounce and the test would pass by accident on a slow machine and
  // fail on a fast one.
  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(draftKey('devtest-item', ITEM.id));
    expect(raw).toContain('The search stopped but the indicator kept spinning.');
  }, { timeout: 2000 });
  first.unmount();

  const second = render(<ItemCard item={ITEM} shot={null} route="/discover" />);
  // Expanded state resumes on its own — the comment field (and its text) only exist once
  // expanded, so finding it at all proves the expansion was restored, not just the text.
  const restored = await second.findByDisplayValue(
    'The search stopped but the indicator kept spinning.');
  expect(restored).toBeTruthy();
});

test('a fresh item with no prior draft starts collapsed, no leftover text', async () => {
  const screen = render(<ItemCard item={{ ...ITEM, id: 'DR-999' }} shot={null} route="/" />);
  // usePersistedDraft's own load effect still runs (and calls setReady after this test's
  // assertion) even though there's nothing to load — wait for it to settle so it doesn't fire
  // an "update not wrapped in act()" warning against a component the test has already finished.
  await waitFor(() => expect(screen.queryByPlaceholderText(/Comment/)).toBeNull());
});

// Opus review, PR #371: the two places a draft is supposed to be CLEARED — a submitted verdict,
// an explicit Cancel — were untested, which is exactly where a stale draft would linger.

test('a submitted verdict clears the ephemeral fields but keeps the verdict marker (DR-075)', async () => {
  const item = { ...ITEM, id: 'DR-998' };
  const screen = render(<ItemCard item={item} shot={null} route="/discover" />);
  fireEvent.press(screen.getByText(item.title));
  const input = await screen.findByPlaceholderText('Comment (optional for Pass and Fail)');
  fireEvent.changeText(input, 'Confirmed working.');
  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(draftKey('devtest-item', item.id));
    expect(raw).toContain('Confirmed working.');
  });

  fireEvent.press(screen.getByText('Pass'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());

  // DR-075 needs the pass/fail fact to survive close/reopen ("this helps me see what next to
  // test"), so this no longer removes the entry outright (that would drop the verdict on next
  // mount) — it persists a record with the ephemeral fields reset and `verdict: "pass"` kept.
  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(draftKey('devtest-item', item.id));
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!);
    expect(stored.value).toEqual({
      expanded: false, comment: '', attach: false, verdict: 'pass', verdictAt: expect.any(Number),
      // DR-118: the visit stamp is durable state like the verdict beside it, not one of the
      // ephemeral fields a submitted verdict resets — the "Last activity" sort reads it.
      openedAt: expect.any(Number),
    });
  });
});

test('Cancel on the new-issue form clears its draft', async () => {
  const onDone = jest.fn();
  const first = render(<NewItemForm onDone={onDone} />);
  const titleInput = first.getByPlaceholderText("What's wrong / what's the idea?");
  fireEvent.changeText(titleInput, 'A half-typed issue title');
  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(draftKey('devtest-new-item'));
    expect(raw).toContain('A half-typed issue title');
  });

  fireEvent.press(first.getByText('Cancel'));
  expect(onDone).toHaveBeenCalledWith(null);
  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(draftKey('devtest-new-item'));
    expect(raw).toBeNull();
  });

  // A fresh mount afterward must not resurrect the cancelled draft.
  const second = render(<NewItemForm onDone={jest.fn()} />);
  await waitFor(() => expect(second.getByPlaceholderText("What's wrong / what's the idea?").props.value).toBe(''));
});

test('a just-created item renders exactly once, not once pinned and once in Open', async () => {
  // Opus review, PR #371: DR-063's "Just added" section pins a new item at the top AND it used
  // to also render again via its normal section below (sectionItems doesn't exclude it) — two
  // separately mounted ItemCards for the same item.id, both now reading/writing the SAME
  // AsyncStorage draft key (this PR's change). Typing a remark in one and submitting could
  // resurrect it via the other's stale in-memory state on its next debounced write.
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  // DR-123: the header action is icon-only now — its label is what names it.
  await waitFor(() => expect(screen.getByLabelText('New issue')).toBeTruthy());

  fireEvent.press(screen.getByLabelText('New issue'));
  fireEvent.changeText(
    screen.getByPlaceholderText("What's wrong / what's the idea?"), 'A duplicate-render bug',
  );
  fireEvent.press(screen.getByText('Create'));

  await waitFor(() => expect(api.createDevTestItem).toHaveBeenCalled());
  await waitFor(() => expect(screen.getAllByText('DUPLICATE_RENDER_PROBE_TITLE').length).toBe(1));
});

// DR-074 — Kamil: "the scrolled position should also be in the state. In a long list, I
// shouldn't be needing to scroll over and over again."

test('scrolling the list persists the offset once the gesture settles', async () => {
  // Opus review, PR #380: persisting on every raw `scroll` event puts a `setState` on
  // `DevTestBubble` per throttled frame, which re-renders every unmemoized `ItemCard` below it —
  // a real cost on the 75-row list DR-074 exists for. The fix tracks the live offset in a ref
  // (no re-render) and only commits it at the natural pause points, so a bare `scroll` event
  // must NOT persist anything — only `onScrollEndDrag`/`onMomentumScrollEnd` do.
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByLabelText('New issue')).toBeTruthy());

  const list = screen.getByTestId('devtest-scroll');
  const event = {
    nativeEvent: { contentOffset: { y: 640 }, contentSize: { height: 2000, width: 400 }, layoutMeasurement: { height: 600, width: 400 } },
  };
  fireEvent.scroll(list, event);
  // Opus review round 2: without this wait, the assertion below is trivially true on the OLD
  // (unfixed) code too — it's still inside the 300ms write debounce either way, so it wasn't
  // actually distinguishing "never persisted" from "not persisted yet". Outlasting the debounce
  // here means a bare `scroll` event genuinely writes nothing under the real fix.
  await new Promise((r) => setTimeout(r, 500));
  expect(await AsyncStorage.getItem(draftKey('devtest-scroll'))).toBeNull();

  fireEvent(list, 'scrollEndDrag', event);
  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(draftKey('devtest-scroll'));
    expect(raw).toContain('"value":640');
  });
});

test('reopening the bubble restores the persisted scroll offset', async () => {
  await AsyncStorage.setItem(
    draftKey('devtest-scroll'),
    JSON.stringify({ version: 1, value: 640, submitted: false, acceptedBaseline: null }),
  );
  jest.mocked(api.getDevTestItems).mockResolvedValueOnce({ items: [ITEM] } as never);
  // RNTL's rendered ScrollView has no real scroll physics to assert a resulting position
  // against; spy on the imperative call the component makes instead.
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});

  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText(ITEM.title)).toBeTruthy());

  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ y: 640, animated: false }));
  scrollTo.mockRestore();
});

// DR-075 — Kamil: "besides the 'Notes' [count], Pass and Fail feedback too should have some
// indication... this helps me see what next to test." A comment already shows via the count of
// his own entries; a pass/fail verdict given this session gets the same visibility, and it must
// survive the card unmounting and remounting the same way DR-065's other state does.
//
// DR-123 moved all of that from five bordered chips into ONE muted line — `Open · Passed` — so
// these match within the line rather than expecting a standalone chip.

test('a passed verdict is still visible after the card unmounts and remounts', async () => {
  const item = { ...ITEM, id: 'DR-997' };
  const first = render(<ItemCard item={item} shot={null} route="/discover" />);
  fireEvent.press(first.getByText(item.title));
  await waitFor(() => expect(first.queryByText(/Passed/)).toBeNull());
  fireEvent.press(first.getByText('Pass'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  // usePersistedDraft debounces its write (real setTimeout, no fake timers in this suite) —
  // wait for the write to actually reach AsyncStorage, not just for the in-memory chip to show,
  // or unmounting races the debounce.
  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(draftKey('devtest-item', item.id));
    expect(raw).toContain('"verdict":"pass"');
  });
  first.unmount();

  const second = render(<ItemCard item={item} shot={null} route="/discover" />);
  await waitFor(() => expect(second.getByText(/· Passed/)).toBeTruthy());
});

// Opus review, PR #380: `setValue`'s write is debounced 300ms, and closing the sheet unmounts
// `ItemCard` outright (the Modal renders no children while hidden) — cancelling any pending
// write. A verdict tapped and then closed within that window used to vanish, which is exactly
// what DR-075 exists to prevent. `send()` now follows `setValue` with `markSubmitted()`, which
// writes to AsyncStorage immediately rather than on a timer — so this asserts the storage write
// landed with NO wait at all, unlike the sibling test above which deliberately waits first.
test('a verdict is persisted immediately, before the write-debounce would otherwise fire', async () => {
  const item = { ...ITEM, id: 'DR-995' };
  const first = render(<ItemCard item={item} shot={null} route="/discover" />);
  fireEvent.press(first.getByText(item.title));
  fireEvent.press(first.getByText('Pass'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  // No waitFor/debounce delay here on purpose — simulates the sheet closing (unmount) the
  // instant the API call resolves, before the 300ms debounce timer would have fired.
  first.unmount();

  const raw = await AsyncStorage.getItem(draftKey('devtest-item', item.id));
  expect(raw).toContain('"verdict":"pass"');

  const second = render(<ItemCard item={item} shot={null} route="/discover" />);
  await waitFor(() => expect(second.getByText(/· Passed/)).toBeTruthy());
});

test('a fail verdict, then a separate remark, keeps the Failed indication', async () => {
  const item = { ...ITEM, id: 'DR-996' };
  const screen = render(<ItemCard item={item} shot={null} route="/discover" />);
  fireEvent.press(screen.getByText(item.title));
  fireEvent.press(screen.getByText('Fail'));
  await waitFor(() => expect(screen.getByText(/· Failed/)).toBeTruthy());

  // A later comment on the same item is not a new verdict — it must not clear or overwrite the
  // Failed marker.
  fireEvent.press(screen.getByText(item.title));
  const input = await screen.findByPlaceholderText('Comment (optional for Pass and Fail)');
  fireEvent.changeText(input, 'Adding more context.');
  fireEvent.press(screen.getByText('Comment'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/· Failed/)).toBeTruthy();
});
