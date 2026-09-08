import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiForm, apiPatch, apiPost } from '@/api/client';

function respond(status: number, body: unknown): Response {
  return { ok: false, status, json: () => Promise.resolve(body) } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('parseError', () => {
  it('uses a plain string detail as the message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(409, { detail: 'Already on the reading list.' }));
    await expect(apiPost('/api/x')).rejects.toMatchObject({
      status: 409, message: 'Already on the reading list.',
    });
  });

  it('reads a structured detail\'s own sentence rather than showing JSON', async () => {
    const detail = {
      code: 'paper_exists_elsewhere',
      message: 'This paper already exists in another project.',
      matches: [{ slug: 'attention', project_name: 'Transformers' }],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(409, { detail }));

    const caught: unknown = await apiPost('/api/x').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).toBe('This paper already exists in another project.');
    expect((caught as ApiError).detail).toEqual(detail);
  });

  it('reduces a 422 validation list to its messages, and keeps the payload out of the message', async () => {
    // DR-155: `input` echoes what the app just sent — a slug list here, the reader's own prose
    // elsewhere — and belongs in a log, not on screen.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(422, {
      detail: [
        { loc: ['body', 'title'], msg: 'Field required', type: 'missing', input: { secret: 'draft' } },
        { loc: ['body', 'slug'], msg: 'Field required', type: 'missing', input: { secret: 'draft' } },
        { loc: ['body', 'year'], msg: 'Input should be a valid integer', type: 'int_type' },
      ],
    }));

    const caught = await apiPost('/api/x').catch((e: unknown) => e) as ApiError;
    // Repeats collapse; each message is punctuated so they read as prose together.
    expect(caught.message).toBe('Field required. Input should be a valid integer.');
    expect(caught.message).not.toContain('secret');
    expect(caught.message).not.toContain('loc');
  });

  it('falls back to the status line when a structured detail says nothing human', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(500, { detail: { code: 'oops', trace: [1, 2] } }));
    const caught = await apiPost('/api/x').catch((e: unknown) => e) as ApiError;
    expect(caught.message).toBe('Request failed (500)');
    expect(caught.detail).toEqual({ code: 'oops', trace: [1, 2] });
  });

  it('never renders JSON at the reader, whatever the detail shape', async () => {
    for (const detail of [[{ loc: ['body'] }], { code: 'x' }, [1, 2, 3], { message: 42 }]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(400, { detail }));
      const caught = await apiPost('/api/x').catch((e: unknown) => e) as ApiError;
      expect(caught.message).toBe('Request failed (400)');
    }
  });

  it('reports the status when the body is not JSON at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 502, json: () => Promise.reject(new Error('not json')),
    } as unknown as Response);
    await expect(apiPost('/api/x')).rejects.toMatchObject({ status: 502, message: 'Request failed (502)' });
  });

  it('re-gates the app on a 401 and drops the stored token', async () => {
    localStorage.setItem('rc_token', 'stale');
    const regate = vi.fn();
    window.addEventListener('rc:auth-required', regate);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(401, { detail: 'Not authenticated' }));

    await expect(apiPost('/api/x')).rejects.toBeInstanceOf(ApiError);
    expect(localStorage.getItem('rc_token')).toBeNull();
    expect(regate).toHaveBeenCalled();
    window.removeEventListener('rc:auth-required', regate);
  });
});

describe('apiPatch', () => {
  it('sends a real PATCH with a JSON body — the only writer of a title decision', async () => {
    // Component tests mock the endpoint module, so nothing else exercises the wire method; the
    // backend route is `@project_router.patch`, and a POST here would be a 405 in production.
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ paper: {} }) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    await apiPatch('/api/projects/p1/papers/attention', { title: 'X', title_confirmed: true });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/projects/p1/papers/attention');
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ title: 'X', title_confirmed: true });
  });

  it('reports a refusal the same way every other verb does', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(409, { detail: 'Project is being split.' }));
    await expect(apiPatch('/api/x', {})).rejects.toMatchObject({ status: 409, message: 'Project is being split.' });
  });
});

describe('apiForm', () => {
  it('lets the browser write Content-Type, so the multipart boundary is named', async () => {
    // Setting it here produces a body FastAPI cannot parse — every upload 422s, and only in
    // production, because component tests mock the endpoint rather than reaching the wire.
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ job: {} }) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const body = new FormData();
    body.append('slug', 'attention');
    body.append('file', new File(['%PDF'], 'p.pdf', { type: 'application/pdf' }));
    await apiForm('/api/projects/p1/upload_paper', body);

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/projects/p1/upload_paper');
    expect(init.method).toBe('POST');
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain('Content-Type');
    expect(init.body).toBe(body);
    expect((init.body as FormData).get('slug')).toBe('attention');
    expect(((init.body as FormData).get('file') as File).name).toBe('p.pdf');
  });

  it('still carries the bearer token', async () => {
    localStorage.setItem('rc_token', 'tok');
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    await apiForm('/api/x', new FormData());

    expect((fetch.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('reads a refusal the same way every other verb does', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(413, { detail: 'PDF is larger than the 40 MB limit.' }));
    await expect(apiForm('/api/x', new FormData()))
      .rejects.toMatchObject({ status: 413, message: 'PDF is larger than the 40 MB limit.' });
  });
});
