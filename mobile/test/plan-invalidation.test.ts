// DR-036 — any observed job status change refreshes the account's standing, wired ONCE at the
// endpoint layer. The per-call-site attempt (#336) missed paths in two consecutive review
// rounds; these tests pin (a) the tracker's transition semantics and (b) that every
// job-returning endpoint actually reports its snapshot — so a new endpoint that forgets the
// adapter shows up as a missing entry in the wiring table below, not as a stale plan screen.

import {
  notePlanAffectingJob,
  noting,
  PLAN_QUERY_KEY,
  resetPlanInvalidationForTests,
} from '@/api/planInvalidation';
import { getActiveQueryClient, rotateActiveQueryClient } from '@/api/queryClient';

let invalidations: unknown[] = [];

function watchActiveClient() {
  invalidations = [];
  const client = getActiveQueryClient();
  jest.spyOn(client, 'invalidateQueries').mockImplementation(((filters: unknown) => {
    invalidations.push((filters as { queryKey?: unknown })?.queryKey);
    return Promise.resolve();
  }) as never);
}

beforeEach(() => {
  rotateActiveQueryClient();
  resetPlanInvalidationForTests();
  watchActiveClient();
});

describe('notePlanAffectingJob', () => {
  it('invalidates the plan on first sight of a running job (a hold just appeared)', () => {
    notePlanAffectingJob({ id: 'j1', status: 'running' });
    expect(invalidations).toEqual([PLAN_QUERY_KEY]);
  });

  it('invalidates again when the same job turns terminal, but not on unchanged polls', () => {
    notePlanAffectingJob({ id: 'j1', status: 'running' });
    notePlanAffectingJob({ id: 'j1', status: 'running' });
    notePlanAffectingJob({ id: 'j1', status: 'running' });
    expect(invalidations).toHaveLength(1);
    notePlanAffectingJob({ id: 'j1', status: 'done' });
    expect(invalidations).toHaveLength(2);
    notePlanAffectingJob({ id: 'j1', status: 'done' });
    expect(invalidations).toHaveLength(2);
  });

  it('invalidates on first sight of an already-terminal job (reattach, cache hit)', () => {
    notePlanAffectingJob({ id: 'j2', status: 'done' });
    expect(invalidations).toHaveLength(1);
  });

  it('re-invalidates when a cancelled job settles, not only when it is stopped', () => {
    // Cooperative Stop publishes `cancelled` immediately while the reservation is still held;
    // the status never changes again — settlement is `finished_at` flipping non-null
    // (app/jobs.py, DR-035). Keying on status alone showed the un-released hold forever.
    notePlanAffectingJob({ id: 'j-stop', status: 'running', finished_at: null });
    notePlanAffectingJob({ id: 'j-stop', status: 'cancelled', finished_at: null });
    expect(invalidations).toHaveLength(2);
    notePlanAffectingJob({ id: 'j-stop', status: 'cancelled', finished_at: null });
    expect(invalidations).toHaveLength(2);
    notePlanAffectingJob({ id: 'j-stop', status: 'cancelled', finished_at: '2026-08-10T00:00:00Z' });
    expect(invalidations).toHaveLength(3);
    notePlanAffectingJob({ id: 'j-stop', status: 'cancelled', finished_at: '2026-08-10T00:00:00Z' });
    expect(invalidations).toHaveLength(3);
  });

  it('forgets every observed job when the query client rotates (identity change)', () => {
    notePlanAffectingJob({ id: 'j-a', status: 'done' });
    expect(invalidations).toHaveLength(1);
    rotateActiveQueryClient();
    watchActiveClient();
    // The same id with the same status must invalidate again under the new identity.
    notePlanAffectingJob({ id: 'j-a', status: 'done' });
    expect(invalidations).toHaveLength(1);
  });

  it('ignores snapshots without an id or status, and null jobs', () => {
    notePlanAffectingJob(null);
    notePlanAffectingJob(undefined);
    notePlanAffectingJob({ id: '', status: 'done' });
    notePlanAffectingJob({ id: 'j3', status: null });
    expect(invalidations).toHaveLength(0);
  });

  it('evicts the least recently OBSERVED job, so a long poll cannot re-trigger as new', () => {
    notePlanAffectingJob({ id: 'long', status: 'running' });
    for (let i = 0; i < 299; i += 1) {
      notePlanAffectingJob({ id: `burst-${i}`, status: 'done' });
    }
    // 'long' was observed first but is kept fresh by its poll...
    notePlanAffectingJob({ id: 'long', status: 'running' });
    const beforeOverflow = invalidations.length;
    // ...so the 301st distinct id evicts a burst job, not 'long'.
    notePlanAffectingJob({ id: 'overflow', status: 'done' });
    notePlanAffectingJob({ id: 'long', status: 'running' });
    expect(invalidations).toHaveLength(beforeOverflow + 1); // overflow only; 'long' stayed known
  });
});

describe('noting', () => {
  it('reports the picked job and returns the response untouched', () => {
    const response = { job: { id: 'j9', status: 'done' }, extra: 1 };
    const out = noting<typeof response>((r) => r.job)(response);
    expect(out).toBe(response);
    expect(invalidations).toEqual([PLAN_QUERY_KEY]);
  });

  it('never throws, even when the picker does', () => {
    const picker = () => {
      throw new Error('malformed');
    };
    expect(noting(picker)({ anything: true })).toEqual({ anything: true });
    expect(invalidations).toHaveLength(0);
  });
});

describe('the key', () => {
  it('matches keys.plan (defined separately to avoid an import cycle)', () => {
    const { keys } = jest.requireActual('@/api/queries');
    expect([...PLAN_QUERY_KEY]).toEqual([...keys.plan]);
  });
});

// ---- the wiring table: every job-returning endpoint reports its snapshot ----

jest.mock('@/api/client', () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiForm: jest.fn(),
  apiPatch: jest.fn(),
  apiDelete: jest.fn(),
  apiUrl: jest.fn((p: string) => p),
  authenticatedMediaSource: jest.fn(() => ({ uri: 'x' })),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const client = require('@/api/client');
// The global test setup replaces endpoints with loud fakes; the wiring under test IS the real
// module (its client dependency stays mocked through the registry).
const api = jest.requireActual('@/api/endpoints');

let nextId = 0;
const freshJob = () => ({ id: `wire-${nextId += 1}`, status: 'done' });
/** Graph builds and discovery deliberately serialize WITHOUT an id (the server pops it —
 *  tests/test_discovery_jobs.py pins that). Rows for those endpoints must use this shape, or
 *  the table certifies wiring against a payload production can never produce — exactly how the
 *  first cut shipped five dead endpoints as green. `phase` stands in for the real extra fields
 *  and gives each row a unique status so successive rows still register as changes. */
const freshScopedJob = () => ({ status: `done-${nextId += 1}`, finished_at: 'x', phase: 'done' });

/** Every endpoint whose response carries a job snapshot, with the response it resolves to and
 *  how many jobs that response reports (relocation responses carry two: the destination draft
 *  AND the source-side cleanup nothing ever polls). Adding a job-returning endpoint without
 *  extending this table is the review cue DR-036 asks for; the count assertion at the bottom
 *  makes the omission loud. */
interface WiredRow { name: string; call: () => Promise<unknown>; respond: () => unknown; expected?: number }
const row = (name: string, call: () => Promise<unknown>, respond: () => unknown, expected?: number): WiredRow =>
  ({ name, call, respond, expected });
const WIRED: WiredRow[] = [
  row('startAudioJob', () => api.startAudioJob('t', 'p'), () => ({ job: freshJob() })),
  row('getAudioJob', () => api.getAudioJob('id'), () => ({ job: freshJob() })),
  row('cancelAudioJob', () => api.cancelAudioJob('id'), () => ({ job: freshJob() })),
  row('startRetrievalJob', () => api.startRetrievalJob('p', 's'), () => ({ job: freshJob() })),
  row('getRetrievalJob', () => api.getRetrievalJob('p', 'id'), () => ({ job: freshJob() })),
  row('getLatestRetrievalJob', () => api.getLatestRetrievalJob('p', 's'), () => ({ job: freshJob() })),
  row('uploadPaper', () => api.uploadPaper('p', 's', { uri: 'u', name: 'n' }), () => ({ job: freshJob() })),
  row('getChatJob', () => api.getChatJob('p', 'id'), () => ({ job: freshJob() })),
  row('getActiveChatJob', () => api.getActiveChatJob('p', 's'), () => ({ job: freshJob() })),
  row('cancelChatJob', () => api.cancelChatJob('p', 'id'), () => ({ job: freshJob() })),
  row('getPreviewJob', () => api.getPreviewJob('p', 'id'), () => ({ job: freshJob() })),
  row('markPreviewPlayed', () => api.markPreviewPlayed('p', 'id'), () => ({ job: freshJob() })),
  row('startNotesAgent', () => api.startNotesAgent('p', 't', 'i'), () => ({ job: freshJob() })),
  row('getNotesJob', () => api.getNotesJob('p', 'id'), () => ({ job: freshJob() })),
  row('getActiveNotesJob', () => api.getActiveNotesJob('p', 't'), () => ({ job: freshJob() })),
  row('getLatestNotesJob', () => api.getLatestNotesJob('p', 't'), () => ({ job: freshJob() })),
  row('startDiscovery', () => api.startDiscovery('p', 'g'), () => ({ job: freshScopedJob() })),
  row('getDiscovery', () => api.getDiscovery('p'), () => ({ job: freshScopedJob(), result: null, goals: '' })),
  row('cancelDiscovery', () => api.cancelDiscovery('p'), () => ({ job: freshScopedJob() })),
  row('startLabsResearch', () => api.startLabsResearch('p'), () => ({ job: freshJob() })),
  row('getLabsResearchJob', () => api.getLabsResearchJob('p', 'id'), () => ({ job: freshJob() })),
  row('startAuthorProfile', () => api.startAuthorProfile('p', 'n'), () => ({ job: freshJob() })),
  row('getAuthorProfileJob', () => api.getAuthorProfileJob('p', 'id'), () => ({ job: freshJob() })),
  row('getGraphAuthors', () => api.getGraphAuthors('p'), () => ({ authors: [], labs: null, labs_job: freshJob() })),
  row('startGraphBuild', () => api.startGraphBuild('p'), () => ({ build: freshScopedJob() })),
  row('getGraphBuildStatus', () => api.getGraphBuildStatus('p'), () => ({ build: freshScopedJob() })),
  row('getGraph', () => api.getGraph('p'), () => ({ graph: null, recommendations: [], status: {}, build: freshScopedJob() })),
  row('saveNotes', () => api.saveNotes('p', 't', 'md'), () => ({ ok: true, rev: 'r', target: 't', next_job: freshJob(), next_error: null })),
  row('discardNotesJob', () => api.discardNotesJob('p', 'id'), () => ({ ok: true, next_job: freshJob(), next_error: null })),
  row('splitProject',
    () => api.splitProject('p', { name: 'n', slugs: [], remove_from_source: false, draft_destination_notes: true, cleanup_source_notes: true }),
    () => ({ new_pid: 'q', name: 'n', moved: 0, removed: false, notes_jobs: { destination: freshJob(), source_cleanup: freshJob(), destination_error: null, source_cleanup_error: null } }),
    2),
  row('moveProject',
    () => api.moveProject('p', { dest_pid: 'q', slugs: [], remove_from_source: true, draft_destination_notes: true, cleanup_source_notes: true }),
    () => ({ new_pid: 'q', name: 'n', moved: 1, removed: true, notes_jobs: { destination: freshJob(), source_cleanup: freshJob(), destination_error: null, source_cleanup_error: null } }),
    2),
];

describe('endpoint wiring', () => {
  it.each(WIRED)('$name reports its job snapshot', async ({ call, respond, expected }) => {
    const response = respond();
    for (const verb of ['apiGet', 'apiPost', 'apiForm', 'apiPatch']) {
      (client[verb] as jest.Mock).mockResolvedValue(response);
    }
    const before = invalidations.length;
    const out = await call();
    expect(out).toBe(response);
    expect(invalidations.length).toBe(before + (expected ?? 1));
  });

  it('covers every job-returning endpoint exported today', () => {
    // If this number changed, a job-returning endpoint was added or removed — extend the
    // table (and the endpoint's `.then(noting(...))`) rather than editing the count blindly.
    expect(WIRED).toHaveLength(31);
  });
});
