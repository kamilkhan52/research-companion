const BASE_URL = '';

export class ApiError extends Error {
  status: number;
  /** The server's `detail` verbatim when it was structured rather than a plain string. Most
   *  routes raise `HTTPException(detail="…")`, but a few carry a machine-readable payload the
   *  caller has to act on — the cross-project duplicate 409 names the projects that already
   *  hold the paper. `message` stays human-readable either way, so a caller that does not know
   *  about a particular payload still shows a sentence rather than JSON. */
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('rc_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function parseError(res: Response): Promise<never> {
  if (res.status === 401) {
    localStorage.removeItem('rc_token');
    window.dispatchEvent(new Event('rc:auth-required'));
  }
  let message = `Request failed (${res.status})`;
  let detail: unknown;
  try {
    const body = await res.json();
    if (body?.detail) {
      detail = body.detail;
      const carried = (body.detail as { message?: unknown }).message;
      // Prefer the payload's own sentence over stringified JSON: a structured detail is still
      // rendered by every generic `error.message` surface in the app.
      if (typeof body.detail === 'string') message = body.detail;
      else if (typeof carried === 'string' && carried) message = carried;
      else message = JSON.stringify(body.detail);
    }
  } catch { /* non-JSON body */ }
  throw new ApiError(res.status, message, detail);
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(BASE_URL + path, { headers: authHeaders() });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(BASE_URL + path, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}
