// Maps a discovery job's server phase onto the five steps the Discover screen shows.
//
// The server has ten phases because they are implementation stages of the funnel ("gathered",
// "gated"). A reader only needs to know that we widened, narrowed, read, and ranked. Keeping the
// mapping here — pure, and separate from the screen — is what makes it testable, and mirrors
// `retrievalSteps` for the paper-fetch flow.

import type { DiscoveryJob } from '@/api/types';

export type StepState = 'pending' | 'active' | 'done';

export interface DiscoverStep {
  key: string;
  label: string;
  detail: string;
  state: StepState;
}

// Explicit rather than an ordered list of phase names: a new server phase should land here
// deliberately, not silently fall through to `indexOf` returning -1 and resetting the timeline
// to step 0 — which reads to the user as the search starting over.
const STEP_OF_PHASE: Record<DiscoveryJob['phase'], number> = {
  queries: 0,
  searching: 1,
  library: 1,
  gathered: 1,
  gated: 2,
  triage: 3,
  citations: 3,
  scoring: 3,
  evidence: 4,
  done: 4,
};

const n = (v: number) => v.toLocaleString();

/**
 * `floor` is the furthest step already shown for this run. The timeline must never move
 * backwards: an unknown phase — an older client against a newer server — would otherwise land on
 * `?? 0` and rewind to "Planned", which reads as the search having started over. Passing the
 * previous position keeps the display honest without the mapping having to know every future
 * phase name. It also absorbs an out-of-order snapshot, which polling can produce.
 */
export function discoverProgress(job: DiscoveryJob, floor = 0): {
  steps: DiscoverStep[];
  detail: string;
  done: boolean;
  step: number;
} {
  const done = job.phase === 'done' || job.status === 'done';
  const known = STEP_OF_PHASE[job.phase];
  const current = Math.max(known ?? floor, floor);

  const labels: Array<{ key: string; label: string; detail: string }> = [
    { key: 'plan', label: 'Planned', detail: job.focus || 'Planning the search…' },
    {
      key: 'gather',
      label: 'Gathered',
      detail: job.gathered
        ? `${n(job.gathered)} papers found`
        : job.library
          ? `Your ${n(job.library)} papers + scholarly sources`
          : 'Searching scholarly sources…',
    },
    {
      key: 'filter',
      label: 'Filtered',
      detail: job.screened
        ? `${n(job.screened)} left after removing what you already have`
        : 'Removing papers already in your library…',
    },
    { key: 'read', label: 'Read', detail: 'Reading titles and abstracts' },
    { key: 'rank', label: 'Ranked', detail: 'Ranking by fit and evidence' },
  ];

  const steps = labels.map((step, i) => ({
    ...step,
    state: (done || i < current ? 'done' : i === current ? 'active' : 'pending') as StepState,
  }));

  return { steps, detail: done ? '' : (steps[current]?.detail ?? ''), done, step: current };
}
