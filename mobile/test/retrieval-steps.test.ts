import { retrievalProgress } from '@/lib/retrievalSteps';
import type { RetrievalJob } from '@/api/types';

type Job = Parameters<typeof retrievalProgress>[0];
const job = (over: Partial<NonNullable<Job>> = {}): Job => ({
  status: 'running', phase: 'resolving', detail: '', enrichment: null, ...over,
} as NonNullable<Job>);

const states = (...args: Parameters<typeof retrievalProgress>) =>
  retrievalProgress(...args).steps.map((s) => s.state);

test('fetching shows the first stage moving and the second waiting', () => {
  expect(states(job(), false)).toEqual(['active', 'pending']);
});

test('the common successful path is not misrepresented as finer-grained than it is', () => {
  // A normal retrieval sits in `resolving` through download AND extraction, then jumps to done.
  // Three stages would spend that whole time showing step 1 spinning and steps 2-3 pending,
  // which looks stalled. Two stages tell the truth.
  expect(retrievalProgress(job({ phase: 'resolving' }), false).steps).toHaveLength(2);
});

test('waiting for the reader to confirm a source shows NOTHING active', () => {
  // `active` renders a spinner. The job has finished and is waiting on a person, so a spinner
  // would claim work is happening on its own.
  const p = retrievalProgress(job({ phase: 'confirmation', status: 'done' }), false);
  expect(p.steps.map((s) => s.state)).toEqual(['pending', 'pending']);
  expect(p.detail).toMatch(/confirm the source/i);
});

test('enrichment is a named stage, not text that appears and vanishes', () => {
  // The actual complaint: "Mapping references" showed up as bare text after the fetch already
  // looked done. It comes from a separate canonical job surfaced as `enrichment`.
  const p = retrievalProgress(
    job({ status: 'done', phase: 'done', enrichment: { status: 'running', step: 'Mapping references…' } }),
    true,
  );
  expect(p.steps.map((s) => s.state)).toEqual(['done', 'active']);
  expect(p.steps[1].label).toBe('Background context');
  expect(p.detail).toBe('Mapping references… You can start reading while this continues.');
});

test('background context never tells an unfetched paper that it is ready to read', () => {
  const p = retrievalProgress(
    job({ enrichment: { status: 'running', step: 'Mapping references…' } }),
    false,
  );
  expect(p.detail).toBe('Mapping references…');
});

test('the final enrichment snapshot does not say ready work is still continuing', () => {
  const p = retrievalProgress(
    job({ enrichment: { status: 'running', step: 'Paper context ready.' } }),
    true,
  );
  expect(p.detail).toBe('Background context is ready.');
});

test('a retrieved paper with no enrichment reported is finished, not waiting forever', () => {
  expect(states(job({ status: 'done', phase: 'done' }), true)).toEqual(['done', 'done']);
});

test('with no job at all the context stage is omitted rather than guessed', () => {
  // A job pruned after a restart, or a paper fetched long ago, tells us nothing about whether
  // enrichment ever ran. A green check would assert something we cannot support.
  const p = retrievalProgress(null, true);
  expect(p.steps.map((s) => s.key)).toEqual(['text']);
  expect(p.steps[0].state).toBe('done');
});

test('a FAILED enrichment does not sit silently on pending', () => {
  // `enrichment.status` can be error or cancelled. Leaving the stage un-ticked with no reason is
  // the same unanswered question this card exists to fix.
  const failed = retrievalProgress(
    job({ status: 'done', phase: 'done', enrichment: { status: 'error', step: '' } }), true,
  );
  expect(failed.steps[1].state).toBe('pending');
  expect(failed.detail).toMatch(/could not be prepared/i);

  const stopped = retrievalProgress(
    job({ status: 'done', phase: 'done', enrichment: { status: 'cancelled', step: '' } }), true,
  );
  expect(stopped.detail).toMatch(/was stopped/i);
});

test('a failed fetch stops moving instead of looking like work in progress', () => {
  expect(states(job({ status: 'error' }), false)).toEqual(['pending', 'pending']);
  expect(states(job({ status: 'cancelled' }), false)).toEqual(['pending', 'pending']);
});

test('nothing has started before a fetch begins', () => {
  expect(states(null, false)).toEqual(['pending']);
});
