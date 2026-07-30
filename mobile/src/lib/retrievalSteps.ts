import type { ProgressStepItem, ProgressStepState } from '@/components/ProgressSteps';
import type { RetrievalJob } from '@/api/types';

/**
 * The fetch, as three stages a reader can watch.
 *
 * The screen previously showed one line of `job.detail` — "mapping references", something about
 * figures — which appears, is replaced, and vanishes. Individually those lines are true; together
 * they answer none of the questions actually being asked, which are "how far along is this", "is
 * it stuck", and "how much is left". The graph build already answers them with a staged card, and
 * this is the same answer for the same question.
 *
 * The stages are the server's own phases, not invented ones: `resolving` (identify the paper),
 * `hunting` (find a public PDF), then the text is in hand. `confirmation` is deliberately NOT a
 * stage — it is a question for the reader, so it belongs in the detail line rather than as a step
 * that looks like progress happening on its own.
 */
export function retrievalSteps(
  job: Pick<RetrievalJob, 'status' | 'phase'> | null | undefined,
  isRetrieved: boolean,
): ProgressStepItem[] {
  const at = (index: number): ProgressStepState => {
    if (isRetrieved) return 'done';
    const current = currentIndex(job);
    if (current === null) return 'pending';
    if (index < current) return 'done';
    return index === current ? 'active' : 'pending';
  };
  return [
    { key: 'resolving', label: 'Identified', state: at(0) },
    { key: 'hunting', label: 'Located', state: at(1) },
    { key: 'ready', label: 'Ready', state: isRetrieved ? 'done' : at(2) },
  ];
}

function currentIndex(job: Pick<RetrievalJob, 'status' | 'phase'> | null | undefined): number | null {
  if (!job) return null;
  // A settled-but-unretrieved job (error, cancelled) must not keep a step spinning as though work
  // were still happening — the card should read as stopped, and the detail line says why.
  if (job.status !== 'running' && job.phase !== 'confirmation') return null;
  switch (job.phase) {
    case 'resolving':
      return 0;
    case 'hunting':
    case 'confirmation':
      return 1;
    case 'done':
      return 2;
    default:
      return 0;
  }
}
