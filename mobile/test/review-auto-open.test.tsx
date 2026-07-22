import { act, renderHookAsync } from '@testing-library/react-native';

import type { SessionState } from '@/api/types';
import { useReviewAutoOpen } from '@/hooks/useReviewAutoOpen';

type Props = {
  streaming: boolean;
  state: SessionState;
  editing: boolean;
  conversationKey: string;
};

const base: Props = { streaming: false, state: 'in_discussion', editing: false, conversationKey: 'main' };

test('opens the review when a finish turn settles into notes_drafted', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  expect(hook.result.current[0]).toBe(false);

  // Finish reading starts streaming…
  await act(async () => hook.rerenderAsync({ ...base, streaming: true }));
  expect(hook.result.current[0]).toBe(false);
  // …ends, and a render later the state settles into notes_drafted.
  await act(async () => hook.rerenderAsync({ ...base, streaming: false }));
  await act(async () => hook.rerenderAsync({ ...base, streaming: false, state: 'notes_drafted' }));
  expect(hook.result.current[0]).toBe(true);
  await hook.unmountAsync();
});

test('does not open on a fresh mount of an already-drafted paper', async () => {
  const hook = await renderHookAsync(
    (p: Props) => useReviewAutoOpen(p),
    { initialProps: { ...base, state: 'notes_drafted' as SessionState } },
  );
  expect(hook.result.current[0]).toBe(false); // never armed → stays closed
  await hook.unmountAsync();
});

test('an ordinary reply that ends in discussion never opens the review', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  await act(async () => hook.rerenderAsync({ ...base, streaming: true }));
  await act(async () => hook.rerenderAsync({ ...base, streaming: false, state: 'in_discussion' }));
  expect(hook.result.current[0]).toBe(false); // stays in discussion → never opens
  await hook.unmountAsync();
});

test('editing suppresses the auto-open until editing ends', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  await act(async () => hook.rerenderAsync({ ...base, streaming: true }));
  await act(async () =>
    hook.rerenderAsync({ ...base, streaming: false, state: 'notes_drafted', editing: true }));
  expect(hook.result.current[0]).toBe(false); // held while editing
  await act(async () =>
    hook.rerenderAsync({ ...base, streaming: false, state: 'notes_drafted', editing: false }));
  expect(hook.result.current[0]).toBe(true);
  await hook.unmountAsync();
});

test('a request-changes revision re-opens the review', async () => {
  const drafted: Props = { ...base, state: 'notes_drafted' };
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: drafted });
  // The user closes the sheet, then requests changes (a new streaming turn).
  act(() => hook.result.current[1](false));
  await act(async () => hook.rerenderAsync({ ...drafted, streaming: true }));
  await act(async () => hook.rerenderAsync({ ...drafted, streaming: false }));
  expect(hook.result.current[0]).toBe(true); // revised proposal auto-opens
  await hook.unmountAsync();
});

test('switching conversation clears a pending auto-open and closes the sheet', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  await act(async () => hook.rerenderAsync({ ...base, streaming: true }));
  await act(async () => hook.rerenderAsync({ ...base, streaming: false, state: 'notes_drafted' }));
  expect(hook.result.current[0]).toBe(true);
  // Switch threads: the sheet closes and the arm is cleared.
  await act(async () =>
    hook.rerenderAsync({ ...base, state: 'notes_drafted', conversationKey: 'thread-b' }));
  expect(hook.result.current[0]).toBe(false);
  await hook.unmountAsync();
});
