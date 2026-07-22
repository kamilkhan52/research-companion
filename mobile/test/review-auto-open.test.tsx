import { act, renderHookAsync } from '@testing-library/react-native';

import { useReviewAutoOpen } from '@/hooks/useReviewAutoOpen';

type Props = { readyNonce: number; editing: boolean; conversationKey: string };

const base: Props = { readyNonce: 0, editing: false, conversationKey: 'main' };

test('opens once when a turn signals a fresh proposal (nonce bump)', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  expect(hook.result.current[0]).toBe(false);

  await act(async () => hook.rerenderAsync({ ...base, readyNonce: 1 }));
  expect(hook.result.current[0]).toBe(true);

  // Closing and re-rendering with the same nonce must not reopen it.
  act(() => hook.result.current[1](false));
  await act(async () => hook.rerenderAsync({ ...base, readyNonce: 1 }));
  expect(hook.result.current[0]).toBe(false);
  await hook.unmountAsync();
});

test('a later revision (another bump) opens again', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  await act(async () => hook.rerenderAsync({ ...base, readyNonce: 1 }));
  act(() => hook.result.current[1](false));
  await act(async () => hook.rerenderAsync({ ...base, readyNonce: 2 }));
  expect(hook.result.current[0]).toBe(true);
  await hook.unmountAsync();
});

test('never opens without a bump (plain reply / branch switch / already-drafted mount)', async () => {
  // A non-zero initial nonce (e.g. the screen mounted after a proposal already existed) is the
  // baseline and must not open; further renders at the same nonce stay closed.
  const hook = await renderHookAsync(
    (p: Props) => useReviewAutoOpen(p),
    { initialProps: { ...base, readyNonce: 5 } },
  );
  expect(hook.result.current[0]).toBe(false);
  await act(async () => hook.rerenderAsync({ ...base, readyNonce: 5 }));
  expect(hook.result.current[0]).toBe(false);
  await hook.unmountAsync();
});

test('a bump while editing defers the open until editing ends', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  await act(async () => hook.rerenderAsync({ ...base, readyNonce: 1, editing: true }));
  expect(hook.result.current[0]).toBe(false);
  await act(async () => hook.rerenderAsync({ ...base, readyNonce: 1, editing: false }));
  expect(hook.result.current[0]).toBe(true);
  await hook.unmountAsync();
});

test('switching conversation closes the sheet and a stale bump cannot reopen it', async () => {
  const hook = await renderHookAsync((p: Props) => useReviewAutoOpen(p), { initialProps: base });
  await act(async () => hook.rerenderAsync({ ...base, readyNonce: 1 }));
  expect(hook.result.current[0]).toBe(true);

  // A bump that raced a thread switch: the reset re-baselines to the current nonce.
  await act(async () => hook.rerenderAsync({ ...base, readyNonce: 1, conversationKey: 'thread-b' }));
  expect(hook.result.current[0]).toBe(false);
  await act(async () => hook.rerenderAsync({ ...base, readyNonce: 1, conversationKey: 'thread-b' }));
  expect(hook.result.current[0]).toBe(false);
  await hook.unmountAsync();
});
