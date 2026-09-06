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

  const steps: ProgressStepItem[] = [{ key: 'text', label: 'Full text', state: fetchState }];
  // The context stage is shown only when there is something real to say about it. With no job in
  // hand — pruned after a restart, or a paper retrieved long ago — we know nothing about whether
  // enrichment ran, and a green check would be an assertion we cannot support. Omitting the stage
  // is honest; inventing a state is not.
  if (job) {
    // This warm is useful for later relationship/Map surfaces, but it is not on the reading
    // critical path. Calling it simply "Paper context" in a connected progress rail made it look
    // like Start reading was waiting for the second step, even though full text was already ready
    // and the action below was enabled. Keep its real status visible while naming the distinction.
    steps.push({
      key: 'context',
      label: 'Background context',
      state: contextStateFor(job, isRetrieved),
    });
  }

  return { steps, detail: detailFor(job, isRetrieved, awaitingChoice) };
}

function contextStateFor(
  job: NonNullable<Pick<RetrievalJob, 'status' | 'phase' | 'detail' | 'enrichment'>>,
  isRetrieved: boolean,
): ProgressStepState {
  const status = job.enrichment?.status;
  if (status === 'running') return 'active';
  // `error`/`cancelled` are real states this can be in, and neither is "still working". They stay
  // un-ticked with the reason in the detail line — a stage sitting on `pending` forever with no
  // explanation is the same unanswered question the card exists to fix.
  if (status === 'error' || status === 'cancelled') return 'pending';
  if (status === 'done') return 'done';
  // No enrichment reported yet: finished only once the text is actually in hand.
  return isRetrieved ? 'done' : 'pending';
}

function detailFor(
  job: Pick<RetrievalJob, 'status' | 'phase' | 'detail' | 'enrichment'> | null | undefined,
  isRetrieved: boolean,
  awaitingChoice: boolean,
): string | null {
  if (awaitingChoice) return 'Waiting for you to confirm the source.';
  // Enrichment wins once the text is in: it is the part still moving, and naming it is the whole
  // point — "Mapping references…" as a labelled stage rather than a line that appears and goes.
  if (job?.enrichment?.status === 'running') {
    const step = job.enrichment.step || 'Preparing paper context…';
    // canonical_jobs publishes this final detail just before the parent retrieval snapshot
    // settles. Do not describe already-ready work as something that "continues" in that gap.
    if (step === 'Paper context ready.') return 'Background context is ready.';
    return isRetrieved
      ? `${step} You can start reading while this continues.`
      : step;
  }
  if (job?.enrichment?.status === 'error') return 'Background context could not be prepared.';
  if (job?.enrichment?.status === 'cancelled') return 'Background context preparation was stopped.';
  if (job?.status === 'running') return job.detail || 'This continues if you leave the screen.';
  if (isRetrieved) return null;
  return null;
}
