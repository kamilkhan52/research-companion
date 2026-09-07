// DR-140/145 — a reading-assistant offer presents its window once per RESPONSE, and that is
// remembered, so re-entering the paper leaves only the indicator; a later response is a new
// question, and a retried response (same index, new job id) is too (Opus review of #492).

import AsyncStorage from '@react-native-async-storage/async-storage';

import { deferReaderOffer, isReaderOfferDeferred, readerOfferKeyFor } from '@/lib/readerOffer';

afterEach(() => AsyncStorage.clear());

test('a window that has presented itself stays deferred for that response only', async () => {
  const summary = readerOfferKeyFor({ chat_job_id: 'job-a', assistant_index: 0 });
  await expect(isReaderOfferDeferred('p', 'flint', 'main', summary)).resolves.toBe(false);
  deferReaderOffer('p', 'flint', 'main', summary);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(isReaderOfferDeferred('p', 'flint', 'main', summary)).resolves.toBe(true);
  // The next response, another thread, another paper: each gets its own window.
  const next = readerOfferKeyFor({ chat_job_id: 'job-b', assistant_index: 1 });
  await expect(isReaderOfferDeferred('p', 'flint', 'main', next)).resolves.toBe(false);
  await expect(isReaderOfferDeferred('p', 'flint', 'side', summary)).resolves.toBe(false);
  await expect(isReaderOfferDeferred('p', 'h3', 'main', summary)).resolves.toBe(false);
});

test('a retried response at the same index is a new offer; an older record falls back to its index', () => {
  expect(readerOfferKeyFor({ chat_job_id: 'job-a', assistant_index: 0 }))
    .not.toBe(readerOfferKeyFor({ chat_job_id: 'job-c', assistant_index: 0 }));
  expect(readerOfferKeyFor({ chat_job_id: null, assistant_index: 2 })).toBe('index:2');
});

test('delimiter characters in ids cannot collide', async () => {
  deferReaderOffer('a:b', 'c', 'main', 'job:x');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(isReaderOfferDeferred('a', 'b:c', 'main', 'job:x')).resolves.toBe(false);
});
