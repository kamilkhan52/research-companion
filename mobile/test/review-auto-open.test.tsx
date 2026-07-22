import { act, renderHookAsync } from '@testing-library/react-native';

import { useReviewAutoOpen } from '@/hooks/useReviewAutoOpen';

type Props = {
  streaming: boolean;
  streamError: boolean;
  proposalKey: number | null;
  conversationKey: string;
};

const base: Props = { streaming: false, streamError: false, proposalKey: null, conversationKey: 'main' };

test('opens when a Finish turn drafts a new proposal', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  expect(hook.result.current.reviewOpen).toBe(false);

  // Finish reading arms, then streams…
  act(() => hook.result.current.armForReview());
  await act(async () => hook.rerenderAsync({ ...base, streaming: true }));
  expect(hook.result.current.reviewOpen).toBe(false);
  // …ends, and the fresh proposal (assistant_index 0) lands — possibly a render later.
  await act(async () => hook.rerenderAsync({ ...base, streaming: false }));
  await act(async () => hook.rerenderAsync({ ...base, streaming: false, proposalKey: 0 }));
  expect(hook.result.current.reviewOpen).toBe(true);
  await hook.unmountAsync();
});

test('a failed Request-changes turn does NOT open the old proposal', async () => {
  const drafted: Props = { ...base, proposalKey: 4 };
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: drafted });

  act(() => hook.result.current.armForReview()); // baseline = existing proposal 4
  await act(async () => hook.rerenderAsync({ ...drafted, streaming: true }));
  // The turn errors; the proposal is unchanged (still 4).
  await act(async () => hook.rerenderAsync({ ...drafted, streaming: true, streamError: true }));
  await act(async () => hook.rerenderAsync({ ...drafted, streaming: false, streamError: true }));
  expect(hook.result.current.reviewOpen).toBe(false); // stale proposal must not open
  await hook.unmountAsync();
});

test('a successful Request-changes revision re-opens the review', async () => {
  const drafted: Props = { ...base, proposalKey: 4 };
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: drafted });

  act(() => hook.result.current.armForReview()); // baseline = 4
  await act(async () => hook.rerenderAsync({ ...drafted, streaming: true }));
  await act(async () => hook.rerenderAsync({ ...drafted, streaming: false, proposalKey: 6 }));
  expect(hook.result.current.reviewOpen).toBe(true); // new proposal 6 opens
  await hook.unmountAsync();
});

test('a plain reply never arms, so it never opens the review', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  // A reply streams and ends WITHOUT arming; even if a proposal identity later appears (e.g. a
  // branch switch), the sheet must not pop.
  await act(async () => hook.rerenderAsync({ ...base, streaming: true }));
  await act(async () => hook.rerenderAsync({ ...base, streaming: false }));
  await act(async () => hook.rerenderAsync({ ...base, streaming: false, proposalKey: 9 }));
  expect(hook.result.current.reviewOpen).toBe(false);
  await hook.unmountAsync();
});

test('does not open on a fresh mount of an already-drafted paper', async () => {
  const hook = await renderHookAsync(
    (p: Props) => useReviewAutoOpen(p),
    { initialProps: { ...base, proposalKey: 3 } },
  );
  expect(hook.result.current.reviewOpen).toBe(false); // never armed
  await hook.unmountAsync();
});

test('switching conversation clears a pending arm and closes the sheet', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  act(() => hook.result.current.armForReview());
  await act(async () => hook.rerenderAsync({ ...base, streaming: true }));
  await act(async () => hook.rerenderAsync({ ...base, streaming: false, proposalKey: 0 }));
  expect(hook.result.current.reviewOpen).toBe(true);

  await act(async () =>
    hook.rerenderAsync({ ...base, proposalKey: 0, conversationKey: 'thread-b' }));
  expect(hook.result.current.reviewOpen).toBe(false);
  await hook.unmountAsync();
});
