import { retrievalSteps } from '@/lib/retrievalSteps';
import type { RetrievalJob } from '@/api/types';

const job = (phase: RetrievalJob['phase'], status: RetrievalJob['status'] = 'running') =>
  ({ phase, status }) as Pick<RetrievalJob, 'status' | 'phase'>;
const states = (...args: Parameters<typeof retrievalSteps>) =>
  retrievalSteps(...args).map((s) => s.state);

test('walks forward through the server\'s own phases', () => {
  expect(states(job('resolving'), false)).toEqual(['active', 'pending', 'pending']);
  expect(states(job('hunting'), false)).toEqual(['done', 'active', 'pending']);
});

test('a retrieved paper reads as finished whatever the job says', () => {
  expect(states(job('hunting'), true)).toEqual(['done', 'done', 'done']);
  expect(states(null, true)).toEqual(['done', 'done', 'done']);
});

test('nothing is active before a fetch has started', () => {
  expect(states(null, false)).toEqual(['pending', 'pending', 'pending']);
});

test('a failed fetch stops spinning instead of looking like work in progress', () => {
  // The failure this guards: a card that keeps a step "active" after the job died reads as
  // "still working", which is the opposite of what the reader needs to know.
  expect(states(job('hunting', 'error'), false)).toEqual(['pending', 'pending', 'pending']);
  expect(states(job('resolving', 'cancelled'), false)).toEqual(['pending', 'pending', 'pending']);
});

test('waiting for the reader to confirm a source still shows the fetch as live', () => {
  // `confirmation` is a question, not a stage — the step stays at "Located" and the detail line
  // carries the question, rather than inventing a fourth step that looks like autonomous progress.
  expect(states(job('confirmation', 'done'), false)).toEqual(['done', 'active', 'pending']);
});

test('labels are stable and in order, so the card does not reshuffle', () => {
  expect(retrievalSteps(job('resolving'), false).map((s) => s.label))
    .toEqual(['Identified', 'Located', 'Ready']);
});
