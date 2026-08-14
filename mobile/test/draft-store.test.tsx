import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHookAsync, waitFor } from '@testing-library/react-native';

import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';

test('debounces authored drafts and restores submission reconciliation metadata', async () => {
  const key = draftKey('project-a', 'discussion', 'paper-a', 'reply');
  const first = await renderHookAsync(() => usePersistedDraft(key, ''));
  await waitFor(() => expect(first.result.current.ready).toBe(true));

  act(() => first.result.current.setValue('A careful question'));
  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(key);
    expect(raw).toContain('A careful question');
  });

  await act(async () => first.result.current.markSubmitted(3));
  await first.unmountAsync();

  const restored = await renderHookAsync(() => usePersistedDraft(key, ''));
  await waitFor(() => expect(restored.result.current.ready).toBe(true));
  expect(restored.result.current.value).toBe('A careful question');
  expect(restored.result.current.submitted).toBe(true);
  expect(restored.result.current.acceptedBaseline).toBe(3);

  await act(async () => restored.result.current.clear(''));
  await expect(AsyncStorage.getItem(key)).resolves.toBeNull();
  await restored.unmountAsync();
});

test('a local edit made during storage loading is never overwritten by stale data', async () => {
  const key = draftKey('project-a', 'notes', 'working', 'manual-edit');
  await AsyncStorage.setItem(key, JSON.stringify({
    version: 1,
    value: 'Older persisted text',
    submitted: false,
    acceptedBaseline: null,
  }));

  const hook = await renderHookAsync(() => usePersistedDraft(key, 'Server text'));
  act(() => hook.result.current.setValue('New local text'));

  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(hook.result.current.value).toBe('New local text');
  await hook.unmountAsync();
});

test('an edit-first notes draft restores its proposal conflict metadata', async () => {
  const key = draftKey('project-a', 'notes', 'working', 'manual-edit');
  const value = {
    markdown: '# Project Notes\n\nEdited proposal.',
    proposal: {
      baseRevision: 'base-revision',
      jobId: 'notes-job',
      summary: 'Integrate moved papers',
    },
  };
  const first = await renderHookAsync(() => usePersistedDraft(key, null as typeof value | null));
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  act(() => first.result.current.setValue(value));
  await act(async () => first.result.current.markSubmitted());
  await first.unmountAsync();

  const restored = await renderHookAsync(
    () => usePersistedDraft(key, null as typeof value | null),
  );
  await waitFor(() => expect(restored.result.current.ready).toBe(true));
  expect(restored.result.current.value).toEqual(value);
  await restored.unmountAsync();
});

test('equivalent inline collection fallbacks do not trigger a render loop', async () => {
  const key = draftKey('project-a', 'discussion', 'paper-a', 'sentence-comments');
  let renders = 0;
  const hook = await renderHookAsync(() => {
    renders += 1;
    return usePersistedDraft<string[]>(key, []);
  });

  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  const settledRenderCount = renders;
  await hook.rerenderAsync({});
  await hook.rerenderAsync({});

  expect(hook.result.current.value).toEqual([]);
  expect(renders - settledRenderCount).toBe(2);
  await hook.unmountAsync();
});
