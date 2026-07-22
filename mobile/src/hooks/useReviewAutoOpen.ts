import { useEffect, useRef, useState } from 'react';

/**
 * Auto-opens the Notes review when a proposal becomes ready (D03).
 *
 * Finish reading — and a later Request changes — draft a fresh Notes proposal. Without this the
 * reader was told notes were written but had to hunt for the "Review & commit" button — or
 * leave and reopen the chat — to see them.
 *
 * The trigger is the AUTHORITATIVE terminal signal, not an inference from streaming/error state
 * (sol review). The screen's turn-completion handler bumps `readyNonce` exactly when a turn
 * settles as done AND its parsed result carries a `proposed_commit` in the `notes_drafted`
 * state — i.e. a genuine new proposal. Nothing else moves the nonce, so a plain reply, a Stop
 * or proposal-less completion, a failed/errored job, a transient poll loss, a post-success
 * audio error, or a branch switch can never open the sheet. This hook simply opens once per
 * new nonce (deferring while a user message is being edited), and resets on a conversation
 * change so a bump that raced a thread switch cannot reopen it.
 */
export function useReviewAutoOpen(opts: {
  readyNonce: number;
  editing: boolean;
  conversationKey: string;
}): [boolean, (open: boolean) => void] {
  const { readyNonce, editing, conversationKey } = opts;
  const [reviewOpen, setReviewOpen] = useState(false);
  const seen = useRef(readyNonce);
  const pending = useRef(false);

  useEffect(() => {
    if (readyNonce > seen.current) {
      seen.current = readyNonce;
      pending.current = true;
    }
    if (pending.current && !editing) {
      pending.current = false;
      setReviewOpen(true);
    }
  }, [readyNonce, editing]);

  useEffect(() => {
    pending.current = false;
    seen.current = readyNonce;
    setReviewOpen(false);
    // conversationKey is the only intended trigger; readyNonce is read, not depended on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey]);

  return [reviewOpen, setReviewOpen];
}
