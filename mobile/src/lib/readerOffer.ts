// DR-140/145 — remembers which reading-assistant offers the reader has already been SHOWN, per
// response, so re-entering the discussion never raises the window at them a second time.
//
// DR-145 (Kamil): "I should be able to just dismiss it and come back to it later, using a little
// indicator at the bottom of the message… This way the user isn't forced to see it or make a
// decision." So closing the window is a DEFERRAL, not an answer: the offer itself stays reachable
// from the indicator under the response for as long as it is the latest one. What this memory
// records is only that the window has had its one chance to present itself.
//
// Keyed by the RESPONSE's identity (its recorded chat job id), not its position: a retry
// regenerates a response at the same assistant index, and an edit renumbers everything after
// it, so an index-keyed memory would silence an offer a brand-new response never made (Opus
// review of #492). A response with no job id (an older record) falls back to its index.
//
// The storage key and its `'1'` value are unchanged from the "Not now" memory they replace: a
// reader who declined an offer before this shipped has already seen that window, which is
// exactly what the flag now means.

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'rc.readerOffer.v2';

/** The identity a response's offer is remembered under. */
export function readerOfferKeyFor(entry: { chat_job_id?: string | null; assistant_index: number }): string {
  return entry.chat_job_id ? `job:${entry.chat_job_id}` : `index:${entry.assistant_index}`;
}

function key(pid: string, slug: string, threadId: string, responseKey: string): string {
  return `${PREFIX}:${encodeURIComponent(pid)}:${encodeURIComponent(slug)}:${encodeURIComponent(threadId)}:${encodeURIComponent(responseKey)}`;
}

/** Has this response's offer already presented itself? */
export async function isReaderOfferDeferred(
  pid: string, slug: string, threadId: string, responseKey: string,
): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(key(pid, slug, threadId, responseKey))) === '1';
  } catch {
    return false;
  }
}

export function deferReaderOffer(
  pid: string, slug: string, threadId: string, responseKey: string,
): void {
  void AsyncStorage.setItem(key(pid, slug, threadId, responseKey), '1').catch(() => undefined);
}

// ---------------------------------------------------------------- DR-145 auto-fetch attempts
//
// "if fetch is needed, the agent should just automatically try. It doesn't cost anything in most
// cases" (Kamil). In MOST cases. A paper whose PDF cannot be resolved escalates to the agentic
// hunt, which costs around $0.10 — and the in-memory attempt set only lives as long as the
// screen does, so re-entering the paper bought that hunt again, every time, for a paper that
// will never resolve. Opus review of #503.
//
// Keyed by (project, paper) rather than by the response that cited it: the same unfetchable
// paper cited from three discussions is still one paper, and it should be hunted for once. This
// records only what was tried AUTOMATICALLY — the explicit Fetch button is never gated by it,
// because a reader pressing it is asking again on purpose.

const AUTO_PREFIX = 'rc.readerAutoFetch.v1';

function autoKey(pid: string, paperSlug: string): string {
  return `${AUTO_PREFIX}:${encodeURIComponent(pid)}:${encodeURIComponent(paperSlug)}`;
}

/** Which of `slugs` an automatic fetch has already been spent on. */
export async function readerAutoFetchAttempted(pid: string, slugs: string[]): Promise<Set<string>> {
  if (!slugs.length) return new Set();
  try {
    const pairs = await AsyncStorage.multiGet(slugs.map((s) => autoKey(pid, s)));
    const attempted = new Set<string>();
    pairs.forEach(([, value], i) => {
      if (value === '1') attempted.add(slugs[i]);
    });
    return attempted;
  } catch {
    // Storage is unreadable. Treating that as "nothing attempted" would re-run the hunts this
    // exists to prevent, so it reads as "all attempted" instead: the reader keeps the explicit
    // Fetch button either way, and the failure mode is a button press rather than a bill.
    return new Set(slugs);
  }
}

export function markReaderAutoFetchAttempted(pid: string, paperSlug: string): void {
  void AsyncStorage.setItem(autoKey(pid, paperSlug), '1').catch(() => undefined);
}
