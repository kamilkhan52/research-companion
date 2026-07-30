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
  const { rerender } = renderHook<ReturnType<typeof useAutoSave<{ voice: string }>>, { v: { voice: string } }>(({ v }) => useAutoSave(v, save), {
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
  const { rerender } = renderHook<ReturnType<typeof useAutoSave<{ voice: string }>>, { v: { voice: string } }>(({ v }) => useAutoSave(v, save), {
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
  const { rerender, result } = renderHook<ReturnType<typeof useAutoSave<{ voice: string }>>, { v: { voice: string } }>(({ v }) => useAutoSave(v, save), {
    initialProps: { v: { voice: 'alloy' } },
  });

  rerender({ v: { voice: 'echo' } });
  await flush();
  await waitFor(() => expect(result.current.state).toBe('error'));

  rerender({ v: { voice: 'nova' } });
  await flush();
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith({ voice: 'nova' });
});

test('reports its state so the screen can show saving/saved', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  const { rerender, result } = renderHook<ReturnType<typeof useAutoSave<{ voice: string }>>, { v: { voice: string } }>(({ v }) => useAutoSave(v, save), {
    initialProps: { v: { voice: 'alloy' } },
  });
  expect(result.current.state).toBe('idle');
  rerender({ v: { voice: 'echo' } });
  await flush();
  await waitFor(() => expect(result.current.state).toBe('saved'));
});

test('writes nothing at all while disabled', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  const { rerender } = renderHook<ReturnType<typeof useAutoSave<{ voice: string }>>, { v: { voice: string } }>(({ v }) => useAutoSave(v, save, { enabled: false }), {
    initialProps: { v: { voice: 'alloy' } },
  });
  rerender({ v: { voice: 'echo' } });
  await flush();
  expect(save).not.toHaveBeenCalled();
});


test('a slow save cannot overwrite a newer one — writes are serialized', async () => {
  // Debouncing alone does not prevent this: if B is slow and C is fast, C lands first and B lands
  // second, so the SERVER keeps the older value while the screen says "Saved".
  const order: string[] = [];
  let releaseFirst!: () => void;
  const save = jest.fn()
    .mockImplementationOnce((v: { voice: string }) => new Promise<void>((resolve) => {
      releaseFirst = () => { order.push(v.voice); resolve(); };
    }))
    .mockImplementation(async (v: { voice: string }) => { order.push(v.voice); });

  const { rerender } = renderHook<ReturnType<typeof useAutoSave<{ voice: string }>>, { v: { voice: string } }>(
    ({ v }) => useAutoSave(v, save), { initialProps: { v: { voice: 'alloy' } } },
  );

  rerender({ v: { voice: 'echo' } });
  await flush();                       // 'echo' starts and hangs
  rerender({ v: { voice: 'nova' } });
  await flush();                       // must NOT start while 'echo' is in flight
  expect(save).toHaveBeenCalledTimes(1);

  await act(async () => { releaseFirst(); });
  await flush();

  expect(order).toEqual(['echo', 'nova']);   // newest value lands last
});

test('re-choosing the SAME option after a failure retries it', async () => {
  // Picking the same chip again is not a state change, so nothing re-triggers the effect. Without
  // a retry the preference is stuck until some unrelated setting changes.
  const save = jest.fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const { rerender, result } = renderHook<ReturnType<typeof useAutoSave<{ voice: string }>>, { v: { voice: string } }>(
    ({ v }) => useAutoSave(v, save), { initialProps: { v: { voice: 'alloy' } } },
  );

  rerender({ v: { voice: 'echo' } });
  await flush();
  await waitFor(() => expect(result.current.state).toBe('error'));

  await act(async () => { result.current.retry(); });
  await waitFor(() => expect(result.current.state).toBe('saved'));
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith({ voice: 'echo' });
});
