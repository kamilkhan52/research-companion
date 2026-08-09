import { apiGet, ApiError } from '@/api/client';
import { setBaseUrl } from '@/api/config';

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    json: jest.fn(async () => body),
  } as unknown as Response;
}

test('ApiError preserves spend-refusal fields and Retry-After', async () => {
  await setBaseUrl('https://api.example');
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(429, {
    detail: 'Your other tasks are still running.',
    code: 'holds_outstanding',
    used_nanousd: 125,
    settled_nanousd: 100,
    requested_nanousd: 50,
    limit_nanousd: 150,
  }, { 'Retry-After': '15' }));

  await expect(apiGet('/api/example')).rejects.toMatchObject({
    name: 'ApiError',
    status: 429,
    message: 'Your other tasks are still running.',
    code: 'holds_outstanding',
    used_nanousd: 125,
    settled_nanousd: 100,
    requested_nanousd: 50,
    limit_nanousd: 150,
    retryAfterSeconds: 15,
  });
});

test('ApiError safely defaults absent or invalid structured fields', async () => {
  const error = new ApiError(0, 'offline');
  expect(error).toMatchObject({
    code: null,
    used_nanousd: null,
    settled_nanousd: null,
    requested_nanousd: null,
    limit_nanousd: null,
    retryAfterSeconds: null,
  });

  await setBaseUrl('https://api.example');
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(402, {
    detail: 'No room',
    code: 42,
    requested_nanousd: '50',
  }, { 'retry-after': 'soon' }));

  await expect(apiGet('/api/example')).rejects.toMatchObject({
    code: null,
    requested_nanousd: null,
    retryAfterSeconds: null,
  });
});
