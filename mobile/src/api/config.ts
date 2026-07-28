// Runtime config: the backend base URL and the auth token.
// - Base URL is not secret -> AsyncStorage. Defaults can be baked via app.json `extra.apiBaseUrl`.
// - Auth token is sensitive -> expo-secure-store (Keychain / Keystore).
// Both are cached in memory after loadConfig() so the fetch client can read them synchronously.

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

const BASE_URL_KEY = 'rc.baseUrl';
const TOKEN_KEY = 'rc.authToken';

const BAKED_BASE_URL: string =
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined)?.trim() || '';

let baseUrl = BAKED_BASE_URL;
let token: string | null = null;
// Protected image caches must not use the URL alone as their key: two users can own projects with
// the same ids/slugs on one device, and a URI-keyed disk cache would then show user A's cover to
// user B without asking the backend. AuthProvider supplies Supabase's stable, non-secret user id.
// It is used only inside the native image-cache key and is never added to the request URL.
let mediaCacheNamespace = 'signed-out';
let loaded = false;

// Reactive notification so screens/queries re-render when the base URL changes (e.g. the user
// saves a server URL in Settings) instead of only after a full app restart.
const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((l) => l());
}
/** Bumped every time the base URL changes. Anything that writes to a shared cache OUTSIDE
 *  TanStack Query's own cancellation — a manual `setQueryData`, say — must capture this before its
 *  request and re-check it before writing, or a late response can repopulate the previous server's
 *  data after the cache was cleared. */
let serverGeneration = 0;

export function getServerGeneration(): number {
  return serverGeneration;
}

/** Subscribe to base-URL changes (for useSyncExternalStore). Returns an unsubscribe fn. */
export function subscribeBaseUrl(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Load persisted config into memory. Call once at app boot before any request. */
export async function loadConfig(): Promise<void> {
  if (loaded) return;
  try {
    const stored = await AsyncStorage.getItem(BASE_URL_KEY);
    if (stored) baseUrl = stored;
  } catch {
    // ignore; fall back to baked/default
  }
  try {
    token = await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    token = null;
  }
  loaded = true;
  notify();
}

/** Normalize a user-entered URL: trim, add https:// if missing, strip trailing slash. */
export function normalizeBaseUrl(raw: string): string {
  let u = raw.trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, '');
}

export function getBaseUrl(): string {
  return baseUrl;
}

export async function setBaseUrl(raw: string): Promise<void> {
  const next = normalizeBaseUrl(raw);
  // A save that does not change the URL must not count as a server switch. Subscribers respond by
  // clearing the token, wiping the query cache and re-bootstrapping auth, so treating "Save &
  // connect" on an unchanged address as a switch would throw away every cached page and all
  // in-flight work for nothing.
  if (next === baseUrl) return;
  baseUrl = next;
  // Both of these happen SYNCHRONOUSLY with the URL change, before the await below. A different
  // server means a different Supabase project, and a token minted by the old one is both useless
  // there and a bearer credential that server has no business receiving. Persisting first would
  // leave a window in which `getBaseUrl()` returns the new host while `getToken()` still returns
  // the old token — and audio polling and query timers are firing throughout that window.
  token = null;
  setMediaCacheNamespace(null);
  serverGeneration += 1;
  notify();
  await AsyncStorage.setItem(BASE_URL_KEY, baseUrl);
  // Best-effort, and after the fact: the in-memory clear above is what protects the token.
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
}

export function hasBaseUrl(): boolean {
  return baseUrl.length > 0;
}

export function getToken(): string | null {
  return token;
}

export function getMediaCacheNamespace(): string {
  return mediaCacheNamespace;
}

export function setMediaCacheNamespace(userId: string | null | undefined): void {
  mediaCacheNamespace = userId ? `user:${userId}` : 'signed-out';
}

export async function setToken(value: string | null): Promise<void> {
  // In-memory first and unconditionally: this is what `client.ts` reads on every request, and it
  // must change even if persistence fails.
  token = value;
  if (!value) setMediaCacheNamespace(null);
  try {
    if (value) await SecureStore.setItemAsync(TOKEN_KEY, value);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Best-effort. SecureStore rejects values over roughly 2048 bytes, and an access JWT with
    // enough claims can reach that — letting it throw would propagate out of the auth provider's
    // session adoption and fail the whole sign-in over a cache write. The session itself is
    // persisted separately (and chunked) by `auth/secureSessionStore.ts`, so the worst case here
    // is that a cold start has no token until Supabase restores the session, which is exactly
    // what the auth gate waits for anyway.
  }
}
