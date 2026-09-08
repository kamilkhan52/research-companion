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

/** Turn a FastAPI `detail` into one human sentence. Mirrors the mobile client's reader of the
 *  same field (DR-155), which this deliberately keeps in step, because the two shapes that are
 *  not plain strings both reach a person:
 *
 *  * a 422 validation detail, a LIST of `{loc, msg, type, input}`. The `msg` fields are the
 *    only human part, so they are what survives. `input` is dropped on purpose — it is the
 *    payload the app just sent, which belongs in a log rather than on screen.
 *  * our own structured refusals, which carry a human `message` beside their machine fields
 *    (`routers/notes.py` answers a cross-project duplicate with `{code, message, matches}`).
 *
 *  With nothing human in either, the generic status line still beats raw JSON.
 */
function describeDetail(value: unknown, status: number): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    const messages = value
      .map((entry) => (entry && typeof entry === 'object' ? (entry as { msg?: unknown }).msg : null))
      .filter((msg): msg is string => typeof msg === 'string' && msg.trim().length > 0)
      .map((msg) => msg.trim());
    const unique = [...new Set(messages)];
    if (unique.length) return unique.map((msg) => (/[.!?]$/.test(msg) ? msg : `${msg}.`)).join(' ');
  } else if (value && typeof value === 'object') {
    const written = value as { message?: unknown; detail?: unknown };
    for (const candidate of [written.message, written.detail]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return `Request failed (${status})`;
}

async function parseError(res: Response): Promise<never> {
  if (res.status === 401) {
    localStorage.removeItem('rc_token');
    window.dispatchEvent(new Event('rc:auth-required'));
  }
  let detail: unknown;
  try {
    const body = await res.json();
    if (body?.detail) detail = body.detail;
  } catch { /* non-JSON body */ }
  throw new ApiError(res.status, describeDetail(detail, res.status), detail);
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

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE_URL + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

/** Multipart POST. The `Content-Type` header is deliberately NOT set: the browser has to write
 *  it itself so it can name the boundary it generated, and setting it here produces a body the
 *  server cannot parse. */
export async function apiForm<T>(path: string, body: FormData): Promise<T> {
  const res = await fetch(BASE_URL + path, { method: 'POST', headers: authHeaders(), body });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

/** Fetch a byte payload behind auth. `<img src>` cannot carry an Authorization header, so
 *  anything the app must authenticate to read has to come through here and be handed to the DOM
 *  as an object URL — which the CALLER owns and must revoke, or every image leaks for the life
 *  of the page. `useAuthenticatedImage` does that bookkeeping; prefer it to calling this. */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(BASE_URL + path, { headers: authHeaders() });
  if (!res.ok) throw await parseError(res);
  return res.blob();
}
