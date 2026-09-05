// DR-140 — "Not now" on a reading-assistant offer is remembered per RESPONSE, so re-entering
// the paper does not re-ask; a later response is a new question, and a retried response (same
// index, new job id) is too (Opus review of #492).

import AsyncStorage from '@react-native-async-storage/async-storage';

import { dismissReaderOffer, isReaderOfferDismissed, readerOfferKeyFor } from '@/lib/readerOffer';

afterEach(() => AsyncStorage.clear());

test('a dismissed offer stays dismissed for that response only', async () => {
  const summary = readerOfferKeyFor({ chat_job_id: 'job-a', assistant_index: 0 });
  await expect(isReaderOfferDismissed('p', 'flint', 'main', summary)).resolves.toBe(false);
  dismissReaderOffer('p', 'flint', 'main', summary);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(isReaderOfferDismissed('p', 'flint', 'main', summary)).resolves.toBe(true);
  // The next response, another thread, another paper: each asked afresh.
  const next = readerOfferKeyFor({ chat_job_id: 'job-b', assistant_index: 1 });
  await expect(isReaderOfferDismissed('p', 'flint', 'main', next)).resolves.toBe(false);
  await expect(isReaderOfferDismissed('p', 'flint', 'side', summary)).resolves.toBe(false);
  await expect(isReaderOfferDismissed('p', 'h3', 'main', summary)).resolves.toBe(false);
});

test('a retried response at the same index is a new offer; an older record falls back to its index', () => {
  expect(readerOfferKeyFor({ chat_job_id: 'job-a', assistant_index: 0 }))
    .not.toBe(readerOfferKeyFor({ chat_job_id: 'job-c', assistant_index: 0 }));
  expect(readerOfferKeyFor({ chat_job_id: null, assistant_index: 2 })).toBe('index:2');
});

test('delimiter characters in ids cannot collide', async () => {
  dismissReaderOffer('a:b', 'c', 'main', 'job:x');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(isReaderOfferDismissed('a', 'b:c', 'main', 'job:x')).resolves.toBe(false);
});
