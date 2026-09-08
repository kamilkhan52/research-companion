// Thin JSON fetch wrapper around the backend. Adds the auth header, builds URLs from the
// configured base, and turns non-2xx responses into a typed ApiError carrying the backend's
// structured error body. Long operations use start-job + poll helpers; audio URLs live in audio.ts.

import { getBaseUrl, getMediaCacheNamespace, getToken } from './config';

export class ApiError extends Error {
  status: number;
  code: string | null;
  used_nanousd: number | null;
  settled_nanousd: number | null;
  requested_nanousd: number | null;
  limit_nanousd: number | null;
  retryAfterSeconds: number | null;

  constructor(
    status: number,
    message: string,
    details: {
      code?: string | null;
      used_nanousd?: number | null;
      settled_nanousd?: number | null;
      requested_nanousd?: number | null;
      limit_nanousd?: number | null;
      retryAfterSeconds?: number | null;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = details.code ?? null;
    this.used_nanousd = details.used_nanousd ?? null;
    this.settled_nanousd = details.settled_nanousd ?? null;
    this.requested_nanousd = details.requested_nanousd ?? null;
    this.limit_nanousd = details.limit_nanousd ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }
}

function numericField(body: unknown, key: string): number | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** Build an absolute URL for an API path (e.g. "/api/projects"). */
export function apiUrl(path: string): string {
  const base = getBaseUrl();
  if (!base) throw new ApiError(0, 'No server URL set. Open Settings to configure it.');
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** React Native / Expo image source for protected backend media.
 *
 * Keep the bearer credential in the Authorization header, never in the URL. URLs are routinely
 * written to proxy and application access logs; headers remain outside the request target.
 */
export function authenticatedMediaSource(path: string): {
  uri: string;
  headers: Record<string, string>;
  cacheKey: string;
} {
  const uri = apiUrl(path);
  return {
    uri,
    headers: authHeaders(),
    // Explicit because iOS and Android image caches do not consistently include request headers
    // in their cache identity. The namespace is a Supabase user id, never a bearer credential.
    cacheKey: `${uri}::${getMediaCacheNamespace()}`,
  };
}

/**
 * What to show a reader for an error body's `detail`.
 *
 * Ours is always a string — every domain layer raises `HTTPException(detail="a sentence")`.
 * FastAPI's own request-validation failures are not: `detail` is a LIST of pydantic error
 * objects, and stringifying one put
 * `[{"type":"too_long","loc":["body","targets"],"msg":…,"input":[…17 slugs…]}]` on Kamil's
 * phone, under the buttons, in place of an answer to "is there a limit?" (DR-155).
 *
 * The `msg` fields are the only human part, so they are what survives. `input` is dropped on
 * purpose: it is the payload the app just sent — here a slug list, elsewhere the reader's own
 * prose — and it belongs in a log, not on a card. With no usable `msg` the generic status line
 * is still better than JSON.
 */
function describeDetail(value: unknown, status: number): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const messages = value
      .map((entry) => (entry && typeof entry === 'object'
        ? (entry as { msg?: unknown }).msg : null))
      .filter((msg): msg is string => typeof msg === 'string' && msg.trim().length > 0)
      .map((msg) => msg.trim());
    const unique = [...new Set(messages)];
    if (unique.length) {
      return unique.map((msg) => (/[.!?]$/.test(msg) ? msg : `${msg}.`)).join(' ');
    }
  }
  return `Request failed (${status})`;
}

async function parseError(res: Response): Promise<never> {
  let detail = `Request failed (${res.status})`;
  let body: unknown = null;
  try {
    body = await res.json();
    if (body && typeof body === 'object' && 'detail' in body) {
      const value = (body as { detail?: unknown }).detail;
      if (value) detail = describeDetail(value, res.status);
    }
  } catch {
    // non-JSON error body; keep the generic message
  }
  const code = body && typeof body === 'object'
    && typeof (body as { code?: unknown }).code === 'string'
    ? (body as { code: string }).code
    : null;
  throw new ApiError(res.status, detail, {
    code,
    used_nanousd: numericField(body, 'used_nanousd'),
    settled_nanousd: numericField(body, 'settled_nanousd'),
    requested_nanousd: numericField(body, 'requested_nanousd'),
    limit_nanousd: numericField(body, 'limit_nanousd'),
    retryAfterSeconds: retryAfterSeconds(res),
  });
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { headers: { ...authHeaders() } });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<T>;
}

export async function apiSend<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<T>;
}

/** Multipart POST for native file uploads. Do not set Content-Type: fetch adds the boundary. */
export async function apiForm<T>(path: string, body: FormData): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { ...authHeaders() },
    body,
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<T>;
}

export const apiPost = <T>(path: string, body?: unknown) => apiSend<T>(path, 'POST', body);
export const apiPatch = <T>(path: string, body?: unknown) => apiSend<T>(path, 'PATCH', body);
export const apiDelete = <T>(path: string) => apiSend<T>(path, 'DELETE');
