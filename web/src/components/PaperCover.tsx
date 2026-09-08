// A paper's first page, beside its card. Decorative on purpose: it never blocks the row, never
// shifts it, and disappears entirely rather than leaving a broken frame — a library that
// rearranges itself as thumbnails arrive is worse than one with no thumbnails.

import { useEffect, useRef, useState } from 'react';
import { getPaperCover, paperCoverPath } from '@/api/endpoints';
import { useAuthenticatedImage } from '@/hooks/useAuthenticatedImage';

/** How long to keep asking about a paper whose render is still running. The server does not
 *  retry a failed render, so `unavailable` is terminal and polling stops immediately; this
 *  bound is for the other case — a render that never resolves must not have the whole library
 *  asking after it forever. */
export const COVER_POLL_INTERVAL_MS = 3000;
export const COVER_POLL_MAX_ATTEMPTS = 10;

interface Props { pid: string; slug: string; title: string; }

export function PaperCover({ pid, slug, title }: Props) {
  const [status, setStatus] = useState<'ready' | 'pending' | 'unavailable' | null>(null);
  const attempts = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    attempts.current = 0;
    setStatus(null);

    // Schedule the next ask only after this one settles: an interval would let slow responses
    // overlap and a stale `pending` overwrite a `ready`.
    const poll = async () => {
      try {
        const { status: next } = await getPaperCover(pid, slug);
        if (cancelled) return;
        setStatus(next);
        if (next !== 'pending') return;
      } catch {
        // A cover is decoration. A failed status read is not worth a message, and retrying
        // forever is not worth the requests either — it falls under the same attempt bound.
        if (cancelled) return;
      }
      attempts.current += 1;
      if (attempts.current >= COVER_POLL_MAX_ATTEMPTS) return;
      timer = setTimeout(() => { void poll(); }, COVER_POLL_INTERVAL_MS);
    };
    void poll();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [pid, slug]);

  const url = useAuthenticatedImage(status === 'ready' ? paperCoverPath(pid, slug) : null);
  if (!url) return null;

  return (
    <img
      className="paper-cover"
      src={url}
      // The title is already the card's own heading beside this, so announcing it again would
      // make every row read twice. The image adds nothing a screen reader needs.
      alt=""
      aria-hidden="true"
      data-testid={`cover-${slug}`}
      title={title}
      loading="lazy"
    />
  );
}
