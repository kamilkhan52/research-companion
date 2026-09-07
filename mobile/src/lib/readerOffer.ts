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
