// DR-102 — Copy/Move waits out a busy-project 409 instead of dead-ending on it.

import { ApiError } from '@/api/client';
import { MoveWaitAborted, busyJobName, moveWhenIdle, waitMessage } from '@/api/moveQueue';

const busy = (side = 'the destination') =>
  new ApiError(409, `A background job (paper-references) is running for ${side} — wait, then move.`);

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
  };
}

describe('busyJobName', () => {
  it('extracts the job name from the server busy 409', () => {
    expect(busyJobName(busy())).toBe('paper-references');
  });
  it('ignores other 409s, other statuses and plain errors', () => {
    expect(busyJobName(new ApiError(409, 'This project is already being modified.'))).toBeNull();
    expect(busyJobName(new ApiError(400, 'A background job (x) is running for this project'))).toBeNull();
    expect(busyJobName(new Error('A background job (x) is running for this project'))).toBeNull();
  });
});

describe('moveWhenIdle', () => {
  it('retries the busy 409 until the move succeeds and reports the wait', async () => {
    const c = clock();
    const attempt = jest.fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce({ moved: 1 });
    const onWaiting = jest.fn();
    const res = await moveWhenIdle(attempt, { ...c, onWaiting, retryMs: 1000, deadlineMs: 10_000 });
    expect(res).toEqual({ moved: 1 });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onWaiting).toHaveBeenCalledTimes(2);
    expect(onWaiting).toHaveBeenLastCalledWith({ jobName: 'paper-references', side: 'the destination' });
  });

  it('names the busy side in the waiting message', () => {
    expect(waitMessage({ jobName: 'paper-references', side: 'the destination' }, 'copy'))
      .toBe('Waiting for the destination’s background job (paper-references) to finish — the copy will run automatically.');
    expect(waitMessage({ jobName: 'chat', side: 'this project' }, 'move'))
      .toMatch(/^Waiting for this project’s background job \(chat\)/);
  });

  it('rethrows any other error immediately', async () => {
    const c = clock();
    const attempt = jest.fn().mockRejectedValue(new ApiError(400, 'Choose a different project to move into.'));
    await expect(moveWhenIdle(attempt, { ...c, retryMs: 1000 })).rejects.toThrow('Choose a different');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up with the server wording once the deadline is reached', async () => {
    const c = clock();
    const attempt = jest.fn().mockRejectedValue(busy());
    await expect(moveWhenIdle(attempt, { ...c, retryMs: 1000, deadlineMs: 3500 }))
      .rejects.toThrow('A background job (paper-references)');
    // started at 0; retries at 1000, 2000, 3000 would each finish within 3500; the 4th would not.
    expect(attempt).toHaveBeenCalledTimes(4);
  });

  it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController();
    const attempt = jest.fn().mockRejectedValue(busy());
    const p = moveWhenIdle(attempt, { signal: controller.signal, retryMs: 60_000 });
    controller.abort();
    await expect(p).rejects.toBeInstanceOf(MoveWaitAborted);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
