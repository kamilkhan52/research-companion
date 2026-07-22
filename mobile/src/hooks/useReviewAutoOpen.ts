import { useEffect, useRef, useState } from 'react';

/**
 * Auto-opens the Notes review when a proposal becomes ready (D03).
 *
 * Finish reading — and a later Request changes — run a streaming turn that resolves into the
 * `notes_drafted` state with a fresh proposal. Without this the reader was told notes were
 * written but had to hunt for the "Review & commit" button (or leave and reopen the chat) to
 * see them. The hook arms when a turn starts streaming and opens the review once the turn has
 * both stopped streaming AND settled into `notes_drafted` — robust to the session-state query
 * lagging the stream end by a render.
 *
 * The arm is set when a turn starts streaming and consumed only when the review opens (or on a
 * conversation change). We deliberately do NOT disarm when a turn ends in `in_discussion`: a
 * reply ending there simply never satisfies the open condition, and reaching `notes_drafted`
 * always requires a fresh streaming turn (which re-arms), so a plain reply cannot pop the
 * sheet. Eagerly disarming instead broke the common case, because the session-state query lags
 * the stream end by a render — the turn is briefly `(streaming: false, in_discussion)` before
 * it settles into `notes_drafted`. A fresh mount of an already-drafted paper never armed, so it
 * does not pop the sheet unbidden.
 */
export function useReviewAutoOpen(opts: {
  streaming: boolean;
  /** The session's lifecycle state (`string | null` as the screen carries it). */
  state: string | null;
  editing: boolean;
  conversationKey: string;
}): [boolean, (open: boolean) => void] {
  const { streaming, state, editing, conversationKey } = opts;
  const [reviewOpen, setReviewOpen] = useState(false);
  const awaiting = useRef(false);

  useEffect(() => {
    if (streaming) awaiting.current = true;
  }, [streaming]);

  useEffect(() => {
    if (streaming || editing) return;
    if (awaiting.current && state === 'notes_drafted') {
      awaiting.current = false;
      setReviewOpen(true);
    }
  }, [streaming, state, editing]);

  useEffect(() => {
    awaiting.current = false;
    setReviewOpen(false);
  }, [conversationKey]);

  return [reviewOpen, setReviewOpen];
}
