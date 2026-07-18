import { act, renderHookAsync, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import type { NotesJob } from '@/api/types';
import { useNotesAgent } from '@/hooks/useNotesAgent';

function proposal(id: string, result: string): NotesJob {
  return {
    id,
    target: 'working',
    instruction: 'Revise the synthesis',
    kind: 'split_destination',
    summary: 'Integrate moved papers',
    base_revision: 'revision',
    status: 'done',
    items: [],
    result,
    error: null,
    started_at: '2026-07-18T00:00:00Z',
    finished_at: '2026-07-18T00:00:01Z',
  };
}

test('project changes synchronously hide the previous proposal', async () => {
  jest.mocked(api.getLatestNotesJob)
    .mockResolvedValueOnce({ job: proposal('job-a', 'Project A proposal') })
    .mockResolvedValueOnce({ job: null });

  const rendered = await renderHookAsync(
    ({ pid }: { pid: string }) => useNotesAgent(pid, 'working'),
    { initialProps: { pid: 'project-a' } },
  );
  await act(async () => rendered.result.current.resume());
  expect(rendered.result.current.proposal).toBe('Project A proposal');

  await rendered.rerenderAsync({ pid: 'project-b' });
  expect(rendered.result.current.proposal).toBeNull();
  expect(rendered.result.current.job).toBeNull();

  await act(async () => rendered.result.current.resume());
  await waitFor(() => expect(rendered.result.current.proposal).toBeNull());
  await rendered.unmountAsync();
});

test('a late latest-job response cannot populate a new project scope', async () => {
  let resolveOld!: (value: { job: NotesJob | null }) => void;
  jest.mocked(api.getLatestNotesJob).mockImplementationOnce(
    () => new Promise((resolve) => { resolveOld = resolve; }),
  );

  const rendered = await renderHookAsync(
    ({ pid }: { pid: string }) => useNotesAgent(pid, 'working'),
    { initialProps: { pid: 'project-a' } },
  );
  void rendered.result.current.resume();
  await rendered.rerenderAsync({ pid: 'project-b' });

  await act(async () => resolveOld({ job: proposal('job-a', 'Late project A proposal') }));
  expect(rendered.result.current.proposal).toBeNull();
  expect(rendered.result.current.job).toBeNull();
  await rendered.unmountAsync();
});

test('a failed discard keeps the proposal and job id available for retry', async () => {
  jest.mocked(api.getLatestNotesJob)
    .mockResolvedValueOnce({ job: proposal('job-a', 'Proposal to retain') });
  jest.mocked(api.discardNotesJob)
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce({ ok: true });

  const rendered = await renderHookAsync(() => useNotesAgent('project-a', 'working'));
  await act(async () => rendered.result.current.resume());

  act(() => rendered.result.current.dismissProposal());
  await waitFor(() => expect(rendered.result.current.error).toBe('connection lost'));
  expect(rendered.result.current.proposal).toBe('Proposal to retain');
  expect(rendered.result.current.job?.id).toBe('job-a');

  act(() => rendered.result.current.dismissProposal());
  await waitFor(() => expect(rendered.result.current.proposal).toBeNull());
  expect(rendered.result.current.job).toBeNull();
  await rendered.unmountAsync();
});

test('resume falls back to the legacy active-job endpoint', async () => {
  const running = {
    ...proposal('job-a', ''),
    status: 'running' as const,
    result: null,
    finished_at: null,
  };
  jest.mocked(api.getLatestNotesJob).mockRejectedValueOnce(new Error('404'));
  jest.mocked(api.getActiveNotesJob).mockResolvedValueOnce({ job: running });

  const rendered = await renderHookAsync(() => useNotesAgent('project-a', 'working'));
  await act(async () => rendered.result.current.resume());

  expect(rendered.result.current.running).toBe(true);
  expect(rendered.result.current.job?.id).toBe('job-a');
  await rendered.unmountAsync();
});
