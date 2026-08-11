// DR-056 — the Finish wait staged from the server's notes_phase. The working-notes stage
// must never show done before the stream ends, and the review step stays pending until the
// auto-open takes over.

import { finishSteps } from '@/lib/finishSteps';

test.each([
  ['drafting', ['active', 'pending', 'pending']],
  ['notes', ['active', 'pending', 'pending']],
  ['synthesis', ['done', 'active', 'pending']],
])('phase %s renders the honest stages', (phase, states) => {
  expect(finishSteps(phase).map((s) => s.state)).toEqual(states);
});

test('labels match the decided copy', () => {
  expect(finishSteps('drafting').map((s) => s.label)).toEqual([
    'Drafting notes', 'Updating working notes', 'Opening review',
  ]);
});
