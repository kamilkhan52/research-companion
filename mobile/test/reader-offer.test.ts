// DR-140 — "Not now" on a reading-assistant offer is remembered per response, so re-entering
// the paper does not re-ask; a later response is a new question.

import AsyncStorage from '@react-native-async-storage/async-storage';

import { dismissReaderOffer, isReaderOfferDismissed } from '@/lib/readerOffer';

afterEach(() => AsyncStorage.clear());

test('a dismissed offer stays dismissed for that response only', async () => {
  await expect(isReaderOfferDismissed('p', 'flint', 'main', 0)).resolves.toBe(false);
  dismissReaderOffer('p', 'flint', 'main', 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(isReaderOfferDismissed('p', 'flint', 'main', 0)).resolves.toBe(true);
  // The next response, another thread, another paper: each asked afresh.
  await expect(isReaderOfferDismissed('p', 'flint', 'main', 1)).resolves.toBe(false);
  await expect(isReaderOfferDismissed('p', 'flint', 'side', 0)).resolves.toBe(false);
  await expect(isReaderOfferDismissed('p', 'h3', 'main', 0)).resolves.toBe(false);
});

test('delimiter characters in ids cannot collide', async () => {
  dismissReaderOffer('a:b', 'c', 'main', 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(isReaderOfferDismissed('a', 'b:c', 'main', 0)).resolves.toBe(false);
});
