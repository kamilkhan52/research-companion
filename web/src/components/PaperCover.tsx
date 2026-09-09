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
  const [visible, setVisible] = useState(false);
  const frameRef = useRef<HTMLSpanElement>(null);
  const attempts = useRef(0);

  // Ask only for rows the reader can actually see. Asking `/cover` is not free: it calls
  // `cover_jobs.ensure`, which SPAWNS a render for any paper without a cached one, and that
  // render downloads the paper's PDF. A 200-paper library therefore meant up to 200 concurrent
  // arXiv fetches from one address the moment the Library opened — and the damage from being
  // rate-limited lands on RETRIEVAL, the thing that actually needs arXiv, not on thumbnails.
  // Gating on visibility makes the fan-out scroll-paced instead of mount-paced. (Mobile sidesteps
  // this differently: it puts a cover on exactly one card, not on library rows.)
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      // One-way: once seen, keep it. Re-hiding on scroll-away would restart the whole poll the
      // next time the row came back, which is the burst again in slow motion.
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    attempts.current = 0;
    setStatus(null);
    if (!visible) return;

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
  }, [pid, slug, visible]);

  const url = useAuthenticatedImage(status === 'ready' ? paperCoverPath(pid, slug) : null);

  // The frame is always in the DOM and always the same size. Two reasons, and the first is not
  // obvious: an element with `display: contents` generates no box, so an observer would never
  // see it intersect anything and no cover would ever load. The second is that reserving the
  // slot up front is what actually prevents layout shift — a slot that appears when the image
  // arrives moves the row, which is the thing the shift-avoidance was for.
  return (
    <span className="paper-cover-frame" ref={frameRef} aria-hidden="true">
      {url ? <img
      className="paper-cover"
      src={url}
      // The title is already the card's own heading beside this, so announcing it again would
      // make every row read twice. The image adds nothing a screen reader needs.
      alt=""
      aria-hidden="true"
      data-testid={`cover-${slug}`}
      title={title}
      loading="lazy"
    /> : null}
    </span>
  );
}
