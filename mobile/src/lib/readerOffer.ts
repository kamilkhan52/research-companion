// DR-140 — remembers which reading-assistant offers the reader declined ("Not now"), per
// response, so re-entering the discussion does not re-raise an offer they already answered.
//
// Keyed by the RESPONSE's identity (its recorded chat job id), not its position: a retry
// regenerates a response at the same assistant index, and an edit renumbers everything after
// it, so an index-keyed memory would silence an offer a brand-new response never made (Opus
// review of #492). A response with no job id (an older record) falls back to its index.

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'rc.readerOffer.v2';

/** The identity a response's offer is remembered under. */
export function readerOfferKeyFor(entry: { chat_job_id?: string | null; assistant_index: number }): string {
  return entry.chat_job_id ? `job:${entry.chat_job_id}` : `index:${entry.assistant_index}`;
}

function key(pid: string, slug: string, threadId: string, responseKey: string): string {
  return `${PREFIX}:${encodeURIComponent(pid)}:${encodeURIComponent(slug)}:${encodeURIComponent(threadId)}:${encodeURIComponent(responseKey)}`;
}

export async function isReaderOfferDismissed(
  pid: string, slug: string, threadId: string, responseKey: string,
): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(key(pid, slug, threadId, responseKey))) === '1';
  } catch {
    return false;
  }
}

export function dismissReaderOffer(
  pid: string, slug: string, threadId: string, responseKey: string,
): void {
  void AsyncStorage.setItem(key(pid, slug, threadId, responseKey), '1').catch(() => undefined);
}
