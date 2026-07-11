const BASE_URL = '';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
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
  let detail = `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
  } catch { /* non-JSON body */ }
  throw new ApiError(res.status, detail);
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
