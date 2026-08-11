// DR-056 — the Finish wait as its real phases. `notes` still reads as drafting (the paper's
// notes are part of the draft); `synthesis` flips the working-notes stage active; the review
// step stays pending until the stream ends and the auto-open takes over. Lives outside the
// paper screen so tests (and the review sheet) import it without the chat library.

export interface FinishStep {
  key: string;
  label: string;
  state: 'done' | 'active' | 'pending';
}

export function finishSteps(phase: string): FinishStep[] {
  const synthesis = phase === 'synthesis';
  return [
    { key: 'notes', label: 'Drafting notes', state: synthesis ? 'done' : 'active' },
    { key: 'synthesis', label: 'Updating working notes', state: synthesis ? 'active' : 'pending' },
    { key: 'review', label: 'Opening review', state: 'pending' },
  ];
}
