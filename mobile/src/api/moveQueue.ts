// DR-102 — a client-side queue for Copy/Move into a busy project.
//
// `POST /move` refuses with 409 while a background job has a live worker on either side
// (a worker writing `projects/<pid>` mid-relocation would split its output between the old
// and new directories). The commonest case is `paper-references`, the first-read bibliography
// extraction that starts the moment a paper's full text lands — so "Add to A, then Copy into
// A" reliably hits a window of about a minute. Rather than surface that as a dead-end error,
// the sheets keep the request queued here and retry until the project is idle.

import { ApiError } from './client';

export const MOVE_RETRY_MS = 4_000;
export const MOVE_WAIT_DEADLINE_MS = 4 * 60_000;

/** The job name from the server's "A background job (<name>) is running for …" detail. */
export function busyJobName(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const m = /background job \(([^)]+)\)/.exec(e.message);
  return m ? m[1] : null;
}

export interface MoveWait {
  jobName: string;
  /** Which side is busy, as the server phrased it ("this project" / "the destination"). */
  side: string;
}

export function waitMessage(wait: MoveWait, verb: 'copy' | 'move'): string {
  const side = wait.side === 'the destination' ? 'the destination’s' : 'this project’s';
  return `Waiting for ${side} background job (${wait.jobName}) to finish — the ${verb} will run automatically.`;
}

function busySide(e: ApiError): string {
  const m = /running for (this project|the destination)/.exec(e.message);
  return m ? m[1] : 'the destination';
}

/**
 * Run `attempt` until it succeeds, retrying only on the busy-project 409. Any other error
 * rethrows immediately; the deadline rethrows the last busy error so the caller's existing
 * error line shows the server's own wording. `signal` aborts a pending wait (rejects with
 * the abort reason), so closing the sheet stops the queue.
 */
export async function moveWhenIdle<T>(
  attempt: () => Promise<T>,
  opts: {
    onWaiting?: (wait: MoveWait) => void;
    signal?: AbortSignal;
    retryMs?: number;
    deadlineMs?: number;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<T> {
  const retryMs = opts.retryMs ?? MOVE_RETRY_MS;
  const deadlineMs = opts.deadlineMs ?? MOVE_WAIT_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const started = now();
  for (;;) {
    try {
      return await attempt();
    } catch (e) {
      const jobName = busyJobName(e);
      if (!jobName || now() - started + retryMs > deadlineMs) throw e;
      opts.onWaiting?.({ jobName, side: busySide(e as ApiError) });
      await sleep(retryMs, opts.signal);
    }
  }
}

export class MoveWaitAborted extends Error {
  constructor() {
    super('Move cancelled while waiting.');
    this.name = 'MoveWaitAborted';
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MoveWaitAborted());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new MoveWaitAborted());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
