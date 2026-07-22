import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHookAsync, waitFor } from '@testing-library/react-native';

import {
  DEFAULT_SORT,
  DEFAULT_SORT_DIRECTION,
  usePaperSortPreference,
} from '@/hooks/usePaperSortPreference';

afterEach(() => AsyncStorage.clear());

test('defaults to Last Interacted, most recent first', async () => {
  const hook = await renderHookAsync(() => usePaperSortPreference('project-a'));
  expect(hook.result.current.sort).toBe('interacted');
  expect(hook.result.current.sortDirection).toBe('desc');
  expect(DEFAULT_SORT).toBe('interacted');
  expect(DEFAULT_SORT_DIRECTION).toBe('desc');
  await hook.unmountAsync();
});

test('persists the selection per project and restores it on remount', async () => {
  const first = await renderHookAsync(() => usePaperSortPreference('project-a'));
  act(() => first.result.current.setSort('name', 'asc'));
  await waitFor(async () => {
    expect(await AsyncStorage.getItem('rc.paperSort.v1:project-a')).toContain('name');
  });
  await first.unmountAsync();

  const restored = await renderHookAsync(() => usePaperSortPreference('project-a'));
  await waitFor(() => expect(restored.result.current.sort).toBe('name'));
  expect(restored.result.current.sortDirection).toBe('asc');
  await restored.unmountAsync();

  // A different project is untouched by project-a's saved selection.
  const other = await renderHookAsync(() => usePaperSortPreference('project-b'));
  expect(other.result.current.sort).toBe(DEFAULT_SORT);
  expect(other.result.current.sortDirection).toBe(DEFAULT_SORT_DIRECTION);
  await other.unmountAsync();
});

test('switching projects swaps to that project stored selection', async () => {
  await AsyncStorage.setItem(
    'rc.paperSort.v1:project-b',
    JSON.stringify({ key: 'pubdate', direction: 'desc' }),
  );
  const hook = await renderHookAsync(
    ({ pid }: { pid: string }) => usePaperSortPreference(pid),
    { initialProps: { pid: 'project-a' } },
  );
  expect(hook.result.current.sort).toBe(DEFAULT_SORT);

  await act(async () => hook.rerenderAsync({ pid: 'project-b' }));
  await waitFor(() => expect(hook.result.current.sort).toBe('pubdate'));
  expect(hook.result.current.sortDirection).toBe('desc');
  await hook.unmountAsync();
});

test('an unknown or corrupt stored value falls back to the default', async () => {
  await AsyncStorage.setItem(
    'rc.paperSort.v1:project-a',
    JSON.stringify({ key: 'garbage', direction: 'sideways' }),
  );
  const hook = await renderHookAsync(() => usePaperSortPreference('project-a'));
  await waitFor(() => expect(hook.result.current.sort).toBe(DEFAULT_SORT));
  expect(hook.result.current.sortDirection).toBe(DEFAULT_SORT_DIRECTION);
  await hook.unmountAsync();

  // A valid key with an invalid direction repairs to that sort's own default direction.
  await AsyncStorage.setItem(
    'rc.paperSort.v1:project-c',
    JSON.stringify({ key: 'interacted', direction: 'sideways' }),
  );
  const repaired = await renderHookAsync(() => usePaperSortPreference('project-c'));
  await waitFor(() => expect(repaired.result.current.sort).toBe('interacted'));
  expect(repaired.result.current.sortDirection).toBe('desc');
  await repaired.unmountAsync();
});

test('a selection made while a stale load is in flight wins', async () => {
  // Keep the storage read genuinely pending (the default mock resolves immediately, which
  // would let the restore land BEFORE the selection and pass even without the version guard).
  let resolveLoad: (value: string | null) => void = () => undefined;
  const pending = new Promise<string | null>((resolve) => {
    resolveLoad = resolve;
  });
  const getItem = jest
    .spyOn(AsyncStorage, 'getItem')
    .mockReturnValueOnce(pending as Promise<string | null>);

  const hook = await renderHookAsync(() => usePaperSortPreference('project-a'));
  act(() => hook.result.current.setSort('name', 'desc'));
  // The stale stored value arrives AFTER the user's selection — it must be discarded.
  await act(async () => {
    resolveLoad(JSON.stringify({ key: 'pubdate', direction: 'asc' }));
    await pending;
  });
  expect(hook.result.current.sort).toBe('name');
  expect(hook.result.current.sortDirection).toBe('desc');
  getItem.mockRestore();
  await hook.unmountAsync();
});
