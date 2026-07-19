export interface PendingSentenceComment {
  assistantIndex: number;
  quote: string;
  comment: string;
}

export interface SelectedSentence {
  assistantIndex: number;
  quote: string;
}

export interface SentenceCommentPayload {
  quote: string;
  comment: string;
}

export function sentenceCommentsDraftKey(
  pid: string,
  slug: string,
  threadId: string,
): string {
  // Preserve the pre-thread main annotation draft while isolating every additional
  // discussion so pending comments cannot surface or send in another thread.
  return threadId === 'main'
    ? draftKey(pid, 'comments', slug)
    : draftKey(pid, 'comments', slug, threadId);
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

export function sentenceCommentPayload(
  comments: PendingSentenceComment[],
): SentenceCommentPayload[] {
  return comments.map(({ quote, comment }) => ({ quote, comment }));
}

/** Optimistic user bubble matching the server's deterministic durable formatting. */
export function composeSentenceReply(
  comments: PendingSentenceComment[],
  freeText: string,
): string {
  if (comments.length === 0) return freeText;
  const parts = ['Regarding specific passages of your last response:'];
  for (const item of comments) {
    const quote = item.quote.trim();
    const comment = item.comment.trim();
    const quoted = `“${quote}”`.split('\n').map((line) => `> ${line}`).join('\n');
    const noted = `— ${comment}`.split('\n').map((line) => `> ${line}`).join('\n');
    parts.push(`${quoted}\n>\n${noted}`);
  }
  if (freeText.trim()) parts.push(freeText.trim());
  return parts.join('\n\n');
}
import { draftKey } from '@/hooks/usePersistedDraft';
