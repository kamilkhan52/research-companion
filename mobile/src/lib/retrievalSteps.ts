import type { ProgressStepItem, ProgressStepState } from '@/components/ProgressSteps';
import type { RetrievalJob } from '@/api/types';

/** What the card shows under the steps — the only part that changes. */
export interface RetrievalProgress {
  steps: ProgressStepItem[];
  detail: string | null;
}

/**
 * Getting a paper ready, as stages a reader can watch.
 *
 * The screen used to show one changing line and nothing else, so it never answered the questions
 * being asked: how far along is this, is it stuck, how much is left.
 *
 * The stages are deliberately COARSE, because the server's are. A normal successful retrieval sits
 * in `phase: "resolving"` through source resolution, download, extraction, persistence and cover
 * rendering, and only then jumps to `done`; `hunting` happens solely when that whole path fails and
 * the agentic fallback starts. So a finer-grained ladder ("Identified → Located → Ready") would
 * spend the common case showing one step spinning and the rest pending, and then jump to complete —
 * which looks stalled and is not more informative. Two honest stages beat three invented ones.
 *
 * The second stage is the one the complaint was actually about. "Mapping references…" and "Finding
 * figures…" come from a SEPARATE canonical job, surfaced on this snapshot as `enrichment` — so
 * before this they were unlabelled text appearing and vanishing after the fetch already looked
 * finished.
 */
export function retrievalProgress(
  job: Pick<RetrievalJob, 'status' | 'phase' | 'detail' | 'enrichment'> | null | undefined,
  isRetrieved: boolean,
): RetrievalProgress {
  const enrichment = job?.enrichment ?? null;
  // `confirmation` means the job has FINISHED and is waiting for the reader to choose a source.
  // Nothing may be 'active' here: that state renders a spinner, which is exactly the
  // "work is happening on its own" signal that would be a lie while it waits on a person.
  const awaitingChoice = job?.phase === 'confirmation';
  const fetching = job?.status === 'running' && !awaitingChoice;

  const fetchState: ProgressStepState = isRetrieved ? 'done' : fetching ? 'active' : 'pending';
  const contextState: ProgressStepState = enrichment?.status === 'running'
    ? 'active'
    // With the text in hand and no enrichment reported, there is nothing further to wait for.
    : (isRetrieved && (!enrichment || enrichment.status === 'done')) ? 'done' : 'pending';

  return {
    steps: [
      { key: 'text', label: 'Full text', state: fetchState },
      { key: 'context', label: 'Paper context', state: contextState },
    ],
    detail: detailFor(job, isRetrieved, awaitingChoice),
  };
}

function detailFor(
  job: Pick<RetrievalJob, 'status' | 'phase' | 'detail' | 'enrichment'> | null | undefined,
  isRetrieved: boolean,
  awaitingChoice: boolean,
): string | null {
  if (awaitingChoice) return 'Waiting for you to confirm the source.';
  // Enrichment wins once the text is in: it is the part still moving, and naming it is the whole
  // point — "Mapping references…" as a labelled stage rather than a line that appears and goes.
  if (job?.enrichment?.status === 'running' && job.enrichment.step) return job.enrichment.step;
  if (job?.status === 'running') return job.detail || 'This continues if you leave the screen.';
  if (isRetrieved) return null;
  return null;
}
