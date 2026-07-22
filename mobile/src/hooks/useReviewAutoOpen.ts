import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Auto-opens the Notes review when a proposal becomes ready (D03).
 *
 * Finish reading — and a later Request changes — run a streaming turn that, on success, drafts
 * a fresh proposal (a new assistant turn carrying a proposed_commit). Without this the reader
 * was told notes were written but had to hunt for the "Review & commit" button — or leave and
 * reopen the chat — to see them.
 *
 * The open is armed EXPLICITLY by the operations that draft a proposal (`armForReview`), never
 * inferred from the streaming flag. Inferring from streaming was wrong two ways (sol review):
 * a *failed* Request changes ends streaming with the OLD proposal still valid, so the sheet
 * would open on stale notes the reader might approve; and a plain reply's arm could persist and
 * pop the sheet on a later branch switch. Instead:
 *   - `armForReview()` captures the current proposal identity as a baseline.
 *   - A stream error while armed disarms (the turn failed → nothing new to review).
 *   - Otherwise the review opens once, when the proposal identity moves to a NEW non-null value
 *     while not streaming — i.e. a genuinely fresh proposal landed. This is lag-tolerant: it
 *     does not matter whether the identity updates in the same render the stream ends or a
 *     render later.
 * A plain reply never arms, a branch switch never arms, and a fresh mount of an already-drafted
 * paper never arms — so none of them pop the sheet.
 *
 * `proposalKey` is a monotonic-ish identity of the latest proposal (e.g. the assistant_index of
 * the most recent proposal-bearing turn), or null when there is none.
 */
export function useReviewAutoOpen(opts: {
  streaming: boolean;
  streamError: boolean;
  proposalKey: number | null;
  conversationKey: string;
}): { reviewOpen: boolean; setReviewOpen: (open: boolean) => void; armForReview: () => void } {
  const { streaming, streamError, proposalKey, conversationKey } = opts;
  const [reviewOpen, setReviewOpen] = useState(false);
  // undefined = disarmed; otherwise the proposal identity captured when the operation began.
  const baseline = useRef<number | null | undefined>(undefined);

  const armForReview = useCallback(() => {
    baseline.current = proposalKey ?? null;
  }, [proposalKey]);

  useEffect(() => {
    if (baseline.current === undefined) return; // not armed
    if (streamError) {
      baseline.current = undefined; // the drafting turn failed → don't open the old proposal
      return;
    }
    if (!streaming && proposalKey != null && proposalKey !== baseline.current) {
      baseline.current = undefined;
      setReviewOpen(true);
    }
  }, [streaming, streamError, proposalKey]);

  useEffect(() => {
    baseline.current = undefined;
    setReviewOpen(false);
  }, [conversationKey]);

  return { reviewOpen, setReviewOpen, armForReview };
}
