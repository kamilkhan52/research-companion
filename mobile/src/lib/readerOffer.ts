// DR-140 — remembers which reading-assistant offers the reader declined ("Not now"), per
// response, so re-entering the discussion does not re-raise an offer they already answered.
// Keyed by the response's assistant index within the conversation: a later response that
// cites other unread papers is a new offer and is asked afresh.

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'rc.readerOffer.v1';

function key(pid: string, slug: string, threadId: string, assistantIndex: number): string {
  return `${PREFIX}:${encodeURIComponent(pid)}:${encodeURIComponent(slug)}:${encodeURIComponent(threadId)}:${assistantIndex}`;
}

export async function isReaderOfferDismissed(
  pid: string, slug: string, threadId: string, assistantIndex: number,
): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(key(pid, slug, threadId, assistantIndex))) === '1';
  } catch {
    return false;
  }
}

export function dismissReaderOffer(
  pid: string, slug: string, threadId: string, assistantIndex: number,
): void {
  void AsyncStorage.setItem(key(pid, slug, threadId, assistantIndex), '1').catch(() => undefined);
}
