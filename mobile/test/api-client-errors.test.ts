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

test('a request-validation body reaches the reader as words, not pydantic JSON', async () => {
  // DR-155 — Kamil ticked 17 papers where a pass reads 8, and this exact body was rendered
  // verbatim under the offer's buttons in place of an answer.
  await setBaseUrl('https://api.example');
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(422, {
    detail: [{
      type: 'too_long',
      loc: ['body', 'targets'],
      msg: 'List should have at most 8 items after validation, not 17',
      input: ['flashaccel', 'flint', 'h3', 'compair', 'tokenstack'],
      ctx: { field_type: 'List', max_length: 8, actual_length: 17 },
    }],
  }));

  const error = (await apiGet('/api/example').catch((e: unknown) => e)) as ApiError;
  expect(error).toBeInstanceOf(ApiError);
  expect(error.message).toBe('List should have at most 8 items after validation, not 17.');
  // The three things that made it unreadable: the JSON scaffolding, the internal field path,
  // and the payload the app had just sent.
  expect(error.message).not.toContain('{');
  expect(error.message).not.toContain('too_long');
  expect(error.message).not.toContain('flashaccel');
});

test('an unreadable validation body falls back to the status, still never JSON', async () => {
  await setBaseUrl('https://api.example');
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(422, {
    detail: [{ type: 'missing', loc: ['body', 'slug'] }, 'not an object'],
  }));
  await expect(apiGet('/api/example')).rejects.toMatchObject({
    status: 422,
    message: 'Request failed (422)',
  });

  // A dict-shaped detail with nothing written in it takes the same route out.
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(400, { detail: { why: 'nope' } }));
  await expect(apiGet('/api/example')).rejects.toMatchObject({
    status: 400,
    message: 'Request failed (400)',
  });
});

test('a structured refusal keeps the sentence it was written with', async () => {
  // `routers/notes.py` answers a cross-project duplicate with {code, message, matches}. The
  // sentence is the point of the payload — reducing it to "Request failed (409)" would be the
  // same defect as DR-155 in the other direction (Opus review of #507).
  await setBaseUrl('https://api.example');
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(409, {
    detail: {
      code: 'paper_exists_elsewhere',
      message: 'This paper already exists in another project.',
      matches: [{ pid: 'other', title: 'H3' }],
    },
  }));
  await expect(apiGet('/api/example')).rejects.toMatchObject({
    status: 409,
    message: 'This paper already exists in another project.',
  });
});

test('two distinct validation messages are joined; a repeat is said once', async () => {
  await setBaseUrl('https://api.example');
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(422, {
    detail: [
      { msg: 'Field required' },
      { msg: 'Field required' },
      { msg: 'Input should be a valid string.' },
    ],
  }));
  await expect(apiGet('/api/example')).rejects.toMatchObject({
    message: 'Field required. Input should be a valid string.',
  });
});
