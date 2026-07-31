import type { DiscoveryJob } from '@/api/types';
import { discoverProgress } from '@/lib/discoverProgress';

const job = (over: Partial<DiscoveryJob> = {}): DiscoveryJob => ({
  status: 'running', phase: 'queries', goals: '', focus: '', queries: [],
  searched: 0, total_queries: 0, found: 0, library: 0, gathered: 0, screened: 0,
  finds: [], finds_stage: '', result: null, error: null,
  started_at: '', finished_at: null, ...over,
} as DiscoveryJob);

const states = (over: Partial<DiscoveryJob>) =>
  discoverProgress(job(over)).steps.map((s) => s.state);

test('the ten server phases collapse to five steps a reader can follow', () => {
  expect(discoverProgress(job()).steps.map((s) => s.label)).toEqual([
    'Planned', 'Gathered', 'Filtered', 'Read', 'Ranked',
  ]);
});

test('recall phases all sit on the same step instead of flickering between three', () => {
  // `searching`, `library` and `gathered` are three server phases for one user-visible idea.
  for (const phase of ['searching', 'library', 'gathered'] as const) {
    expect(states({ phase })).toEqual(['done', 'active', 'pending', 'pending', 'pending']);
  }
});

test('both cheap screening passes and the citation step read as one "Read" stage', () => {
  for (const phase of ['triage', 'citations', 'scoring'] as const) {
    expect(states({ phase })).toEqual(['done', 'done', 'done', 'active', 'pending']);
  }
});

test('an unknown phase holds position instead of rewinding to the start', () => {
  // An older client against a newer server. `?? 0` put the timeline back on "Planned", which
  // reads as the search having started over. The previous position is passed in as a floor.
  // (An earlier version of this test only asserted "one step is active", which passed with the
  // WRONG step active and hid exactly this bug.)
  const p = discoverProgress(job({ phase: 'made-up' as DiscoveryJob['phase'] }), 3);
  expect(p.steps.find((s) => s.state === 'active')?.label).toBe('Read');
  expect(p.step).toBe(3);
});

test('the timeline never moves backwards even if a snapshot arrives out of order', () => {
  const p = discoverProgress(job({ phase: 'searching' }), 3);
  expect(p.steps.find((s) => s.state === 'active')?.label).toBe('Read');
});

test('a known phase ahead of the floor still advances', () => {
  expect(discoverProgress(job({ phase: 'evidence' }), 1).step).toBe(4);
});

test('a finished job shows every step checked and no trailing detail line', () => {
  const p = discoverProgress(job({ phase: 'done', status: 'done' }));
  expect(p.steps.every((s) => s.state === 'done')).toBe(true);
  expect(p.done).toBe(true);
  expect(p.detail).toBe('');   // a detail line under a complete timeline claims work is ongoing
});

test('a job that errored mid-run does not claim the remaining steps finished', () => {
  const p = discoverProgress(job({ phase: 'triage', status: 'error' }));
  expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'active', 'pending']);
});

test('the detail lines carry real counts once the server has them', () => {
  expect(discoverProgress(job({ phase: 'gathered', gathered: 1204 })).detail)
    .toBe('1,204 papers found');
  expect(discoverProgress(job({ phase: 'gated', screened: 796 })).detail)
    .toMatch(/^796 left after removing/);
});

test('before any count exists the line says what is happening, not nothing', () => {
  // A run spends its first seconds here. An empty detail under a spinning step looks stalled.
  expect(discoverProgress(job({ phase: 'searching' })).detail).toBeTruthy();
  expect(discoverProgress(job({ phase: 'gated' })).detail).toBeTruthy();
});

test('the gathering line names the reader library when there is one', () => {
  expect(discoverProgress(job({ phase: 'library', library: 53 })).detail)
    .toBe('Your 53 papers + scholarly sources');
  // ...and does not invent one for a project with an empty library.
  expect(discoverProgress(job({ phase: 'library' })).detail)
    .toBe('Searching scholarly sources…');
});
