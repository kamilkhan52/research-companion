// Thin JSON fetch wrapper around the backend. Adds the auth header, builds URLs from the
// configured base, and turns non-2xx responses into a typed ApiError carrying the backend's
// {detail} message. Long operations use start-job + poll helpers; audio URLs live in audio.ts.

import { getBaseUrl, getMediaCacheNamespace, getToken } from './config';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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

async function parseError(res: Response): Promise<never> {
  let detail = `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
  } catch {
    // non-JSON error body; keep the generic message
  }
  throw new ApiError(res.status, detail);
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
