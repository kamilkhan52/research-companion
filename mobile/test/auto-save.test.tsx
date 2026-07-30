import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useAutoSave, type AutoSaveState } from '@/hooks/useAutoSave';

jest.useFakeTimers();

const flush = async () => { await act(async () => { jest.advanceTimersByTime(700); }); };

test('does not save on mount — opening the screen must not write settings nobody touched', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  renderHook(() => useAutoSave({ voice: 'alloy' }, save));
  await flush();
  expect(save).not.toHaveBeenCalled();
});

test('saves once after the value settles, coalescing rapid changes', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  const { rerender } = renderHook<AutoSaveState, { v: { voice: string } }>(({ v }) => useAutoSave(v, save), {
    initialProps: { v: { voice: 'alloy' } },
  });
  rerender({ v: { voice: 'echo' } });
  rerender({ v: { voice: 'fable' } });
  rerender({ v: { voice: 'nova' } });
  await flush();
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({ voice: 'nova' });
});

test('does not re-save a value that came back to what was already stored', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  const { rerender } = renderHook<AutoSaveState, { v: { voice: string } }>(({ v }) => useAutoSave(v, save), {
    initialProps: { v: { voice: 'alloy' } },
  });
  rerender({ v: { voice: 'echo' } });
  await flush();
  expect(save).toHaveBeenCalledTimes(1);

  rerender({ v: { voice: 'echo' } });   // same value again
  await flush();
  expect(save).toHaveBeenCalledTimes(1);
});

test('a FAILED save is retried by the next change rather than being skipped', async () => {
  // The bug this guards: recording "last saved" before the request succeeds means a value that
  // failed to save looks already-saved, and the setting is silently lost.
  const save = jest.fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const { rerender, result } = renderHook<AutoSaveState, { v: { voice: string } }>(({ v }) => useAutoSave(v, save), {
    initialProps: { v: { voice: 'alloy' } },
  });

  rerender({ v: { voice: 'echo' } });
  await flush();
  await waitFor(() => expect(result.current).toBe('error'));

  rerender({ v: { voice: 'nova' } });
  await flush();
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith({ voice: 'nova' });
});

test('reports its state so the screen can show saving/saved', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  const { rerender, result } = renderHook<AutoSaveState, { v: { voice: string } }>(({ v }) => useAutoSave(v, save), {
    initialProps: { v: { voice: 'alloy' } },
  });
  expect(result.current).toBe('idle');
  rerender({ v: { voice: 'echo' } });
  await flush();
  await waitFor(() => expect(result.current).toBe('saved'));
});

test('writes nothing at all while disabled', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  const { rerender } = renderHook<AutoSaveState, { v: { voice: string } }>(({ v }) => useAutoSave(v, save, { enabled: false }), {
    initialProps: { v: { voice: 'alloy' } },
  });
  rerender({ v: { voice: 'echo' } });
  await flush();
  expect(save).not.toHaveBeenCalled();
});
