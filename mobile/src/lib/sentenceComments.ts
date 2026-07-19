export interface PendingSentenceComment {
  assistantIndex: number;
  quote: string;
  comment: string;
}

export interface SelectedSentence {
  assistantIndex: number;
  quote: string;
}

export function sameSentence(
  left: SelectedSentence,
  right: SelectedSentence,
): boolean {
  return left.assistantIndex === right.assistantIndex && left.quote === right.quote;
}

/** One editable pending comment per sentence. Re-selecting the sentence updates it in place
 *  instead of creating visually identical duplicate chips. */
export function upsertSentenceComment(
  comments: PendingSentenceComment[],
  next: PendingSentenceComment,
): PendingSentenceComment[] {
  const index = comments.findIndex((comment) => sameSentence(comment, next));
  if (index < 0) return [...comments, next];
  const copy = [...comments];
  copy[index] = next;
  return copy;
}

export function removeSentenceComment(
  comments: PendingSentenceComment[],
  target: SelectedSentence,
): PendingSentenceComment[] {
  return comments.filter((comment) => !sameSentence(comment, target));
}
