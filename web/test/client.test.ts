import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiPost } from '@/api/client';

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

  it('falls back to JSON for a structured detail with no sentence', async () => {
    // FastAPI's 422 validation detail is a list; there is nothing better to show than itself.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(422, { detail: [{ loc: ['body', 'title'], msg: 'field required' }] }));
    const caught: unknown = await apiPost('/api/x').catch((e: unknown) => e);
    expect((caught as ApiError).message).toContain('field required');
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
