// Mobile authentication (P0-15). The Android client previously had none at all: `setToken` in
// `src/api/config.ts` had no caller, so the token could never be set and the app could only ever
// talk to an unauthenticated backend. Staging and production both refuse to boot without Supabase
// auth, so this is what lets the app point at either.
//
// Mirrors `web/src/components/AuthGate.tsx` in behaviour, but not in mechanism — the web version
// leans on the browser (`localStorage`, `detectSessionInUrl` reading the callback fragment), and
// none of that exists here.

// Statically imported, unlike the web client's dynamic `await import()`. There is no route-level
// code splitting in a React Native bundle for it to buy, and a dynamic import is one more way
// for this path to fail at runtime for reasons unrelated to auth.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { stopPlaybackForSessionEnd } from '@/audio/AudioProvider';
import { getAuthConfig } from '@/api/endpoints';
import { setMediaCacheNamespace, setToken, subscribeBaseUrl } from '@/api/config';
import { rotateActiveQueryClient } from '@/api/queryClient';
import type { AuthConfig } from '@/api/types';

import {
  clearAccountDeleted,
  clearAccountDeletionIntent,
  clearAccountScopedStorage,
  clearDeletedAccountStorage,
  hasAccountDeleted,
  hasAccountDeletionIntent,
  markAccountDeleted,
  markAccountDeletionIntent,
} from './accountCleanup';
import { secureSessionStore } from './secureSessionStore';

/** `unknown` until /api/auth/config answers — the app must not decide it is signed out while it
 *  still does not know whether auth is even on. */
export type AuthStatus =
  | 'unknown'
  | 'disabled'
  | 'signed-out'
  | 'signed-in'
  | 'unreachable'
  | 'cleanup-required';

export type PasswordSignUpResult =
  'signed-in' | 'confirm-email' | 'already-registered' | 'failed';

/** Supabase's own floor is 6. Eight is enforced here so the rejection is a clear message next to
 *  the field rather than a provider error after the round trip. */
export const MIN_PASSWORD_LENGTH = 8;

interface AuthState {
  status: AuthStatus;
  /** Non-null only in supabase mode once config has loaded. */
  mode: AuthConfig['mode'] | null;
  /** Stable Supabase subject used to isolate user-scoped client caches. */
  userId: string | null;
  email: string | null;
  error: string | null;
  signInWithGoogle: () => Promise<void>;
  /** True when Supabase accepted the email and the UI may advance to "check your inbox". */
  signInWithMagicLink: (email: string) => Promise<boolean>;
  /** True once the session exists. Does not leave the app, so there is no inbox step. */
  signInWithPassword: (email: string, password: string) => Promise<boolean>;
  /** `confirm-email` means the account was created but is inert until the address is confirmed. */
  signUpWithPassword: (email: string, password: string) => Promise<PasswordSignUpResult>;
  /** True when Supabase accepted the request; it deliberately says nothing about whether the
   *  address has an account, so the UI must not either. */
  sendPasswordReset: (email: string) => Promise<boolean>;
  /** Establish recent user presence before the first irreversible deletion request. */
  reauthenticateForDeletion: () => Promise<'authenticated' | 'email-sent' | 'cancelled'>;
  /** Remove the deleted identity's session and account-linked device state without a server call. */
  finishAccountDeletion: () => Promise<void>;
  /** True until the user acknowledges that their account was deleted. */
  accountDeleted: boolean;
  dismissAccountDeleted: () => void;
  signOut: () => Promise<void>;
  retry: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** Where Supabase sends the browser back to: `researchcompanion://auth`, built by `expo-linking`
 *  from the scheme in app.json. The same string must be in the Supabase project's Redirect URLs
 *  allowlist, or Supabase silently redirects to its default instead.
 *
 *  Computed on demand rather than at module scope: `createURL` THROWS when it cannot reach the
 *  expo-constants manifest, so evaluating it at import time makes merely importing this module —
 *  or anything that imports it, such as the settings screen — fail outright. The scheme is only
 *  needed when a sign-in actually starts. */
export function redirectUri(): string {
  return Linking.createURL('auth');
}

/** Whether a deep link is OUR auth callback, compared structurally against `redirectUri()`.
 *
 *  Not a path check. `researchcompanion://auth` parses to **hostname `"auth"` and path `null`** —
 *  the authority slot, not the path — so testing `parsed.path` rejects every genuine callback and
 *  the whole sign-in silently does nothing. Equally, testing loosely lets
 *  `researchcompanion://auth.evil/auth` through, and that hostname belongs to someone else.
 *  So: same scheme, same hostname, same normalized path as the URI we actually registered. */
export function isAuthCallback(url: string): boolean {
  try {
    const target = new URL(redirectUri());
    const candidate = new URL(url);
    const normalize = (value: string) => value.replace(/^\/+|\/+$/g, '');
    return (
      candidate.protocol === target.protocol &&
      candidate.hostname === target.hostname &&
      normalize(candidate.pathname) === normalize(target.pathname)
    );
  } catch {
    return false;
  }
}

/** Persisted marker that THIS app started a sign-in and is waiting for its callback.
 *
 *  Persisted rather than held in memory because a magic link is tapped after the app has been
 *  closed, so an in-memory flag would reject exactly the flow it exists to protect. It narrows the
 *  window in which a hostile app can burn our PKCE verifier from "always" to "while the user is
 *  mid-sign-in", without touching the redirect URL — which Supabase controls, and which cannot be
 *  changed here without a device test to confirm extra params survive the round trip. */
const PENDING_SIGN_IN_KEY = 'rc.auth.pending';

async function markSignInPending(): Promise<void> {
  await SecureStore.setItemAsync(PENDING_SIGN_IN_KEY, String(Date.now())).catch(() => {});
}

/** True if a sign-in was outstanding; clears it either way, so one callback consumes one attempt. */
async function consumePendingSignIn(): Promise<boolean> {
  const pending = await SecureStore.getItemAsync(PENDING_SIGN_IN_KEY).catch(() => null);
  if (pending) await SecureStore.deleteItemAsync(PENDING_SIGN_IN_KEY).catch(() => {});
  return Boolean(pending);
}

async function clearPendingSignIn(): Promise<void> {
  await SecureStore.deleteItemAsync(PENDING_SIGN_IN_KEY).catch(() => {});
}

/** A storage key unique per Supabase project, by construction.
 *
 *  Two reasons this is hand-rolled rather than a one-liner.
 *
 *  It is base64url and not `replace(/[^a-zA-Z0-9]/g, '-')`, because that substitution is NOT
 *  injective: `https://auth-a.example.com` and `https://auth.a-example.com` collapse to the same
 *  key, and two projects sharing a key means one's session can be restored under the other and its
 *  bearer token sent to the wrong backend.
 *
 *  And it does not call `btoa`, because **React Native does not define one**. TypeScript accepts
 *  `btoa` from the DOM lib and Node provides it, so a Jest test passes — but on Hermes the call
 *  throws, and a `try/catch` fallback would quietly restore the non-injective behaviour on the one
 *  runtime that matters. Encoding here removes the environment dependence entirely.
 *
 *  The output alphabet sits inside what `secureSessionStore`'s key normaliser accepts, so nothing
 *  downstream rewrites the key. */
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** UTF-8 bytes of a string. Written out because masking code points to a byte (`& 0xff`) is
 *  LOSSY — `\u0101` and `\u0201` share a low byte, so two distinct URLs would produce one key. */
function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f),
      );
    }
  }
  return bytes;
}

/** Lowercase the parts that are case-INSENSITIVE (scheme and host) and leave the rest alone. A
 *  blanket `toLowerCase()` merges two case-sensitive proxy paths into one key. */
function canonicalSupabaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed;
  }
}

export function sessionStorageKey(supabaseUrl: string): string {
  const bytes = utf8Bytes(canonicalSupabaseUrl(supabaseUrl));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : NaN;
    const c = i + 2 < bytes.length ? bytes[i + 2] : NaN;
    out += BASE64URL[a >> 2];
    out += BASE64URL[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    if (Number.isNaN(b)) break;
    out += BASE64URL[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    if (Number.isNaN(c)) break;
    out += BASE64URL[c & 63];
  }
  return `sb-${out}-auth`;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('unknown');
  /** Mirrors `status` for comparisons that must not live inside a setState updater. */
  const statusRef = useRef<AuthStatus>('unknown');
  const [mode, setMode] = useState<AuthConfig['mode'] | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const client = useRef<SupabaseClient | null>(null);
  /** A callback URL that arrived before the Supabase client existed (cold start). */
  const [accountDeleted, setAccountDeleted] = useState(false);
  const pendingUrl = useRef<string | null>(null);
  /** Bumped when a client becomes available, so the deep-link effect can replay. */
  const [clientReady, setClientReady] = useState(0);
  /** Bumped on every bootstrap. An auth callback captures the generation it belongs to, so a
   *  refresh completing on a REPLACED client cannot write its token back after we cleared it —
   *  which, on a server switch, would send the old project's JWT to the new host. */
  const generation = useRef(0);
  /** Newest auth event wins within a server generation. Supabase callbacks are fire-and-forget,
   *  so B sign-in cleanup can overlap a later sign-out unless every async continuation checks a
   *  per-adoption epoch before publishing token/user/status. */
  const adoptionEpoch = useRef(0);
  /** `undefined` means no session has been adopted in this process yet. That distinction preserves
   *  the remembered project on an ordinary cold restore of the SAME persisted session; every
   *  subsequent null/user or user/user change is a real identity boundary and is purged. */
  const identity = useRef<string | null | undefined>(undefined);

  /** Local deletion recovery must not depend on a restorable Supabase session or reachable API. */
  const recoverLocalDeletion = useCallback(async (
    playbackAlreadyStopped = false,
  ): Promise<'none' | 'cleared' | 'failed'> => {
    // Read before the early return: a cold start on a device whose deletion already completed has
    // no intent marker left, and must still show the acknowledgement.
    if (await hasAccountDeleted().catch(() => false)) setAccountDeleted(true);
    if (!(await hasAccountDeletionIntent().catch(() => false))) return 'none';
    rotateActiveQueryClient();
    let failed = false;
    if (!playbackAlreadyStopped) {
      try {
        await stopPlaybackForSessionEnd({ failClosed: true });
      } catch {
        failed = true;
      }
    }
    try {
      await clearDeletedAccountStorage();
    } catch {
      failed = true;
    }
    if (failed) {
      // Keep the marker so the next launch retries. The signed-out UI also carries a warning.
      setError(
        'Some deleted-account data could not be cleared from this device. '
        + 'Clear the app’s data before another person uses it.',
      );
      return 'failed';
    }
    try {
      await clearAccountDeletionIntent();
    } catch {
      setError(
        'Some deleted-account data could not be cleared from this device. '
        + 'Clear the app’s data before another person uses it.',
      );
      return 'failed';
    }
    return 'cleared';
  }, []);

  /** The one place a session becomes an API token. Every path that changes the session — restore,
   *  sign-in, refresh, sign-out — goes through here, because `src/api/client.ts` reads the token
   *  synchronously from module state and would otherwise keep sending a stale one. An expired
   *  access token is a silent 401 an hour after sign-in, which looks like the backend breaking. */
  const adoptSession = useCallback(async (session: Session | null, forGeneration?: number) => {
    // A callback from a superseded client must not win. React runs effect cleanup asynchronously,
    // so the old client stays subscribed for a moment after the base URL changes; if its refresh
    // lands in that window it would restore the old token on top of the clear.
    if (forGeneration !== undefined && forGeneration !== generation.current) return;
    const myAdoption = ++adoptionEpoch.current;
    const isCurrentAdoption = () => (
      myAdoption === adoptionEpoch.current
      && (forGeneration === undefined || forGeneration === generation.current)
    );
    const nextIdentity = session?.user?.id ?? (session?.access_token ? '__signed-in__' : null);
    const previousIdentity = identity.current;
    const identityChanged = previousIdentity !== undefined && previousIdentity !== nextIdentity;
    let identityPlaybackStopped = false;
    if (identityChanged) {
      // Gate the old account's provider tree before changing its bearer token. The cache rotation
      // is synchronous, so an uncancellable A continuation can only ever write into A's retired
      // object. Playback teardown increments its epoch synchronously before its first await, so a
      // queued A track cannot restart while persisted cleanup runs. Both halves are fail-closed.
      setStatus('unknown');
      rotateActiveQueryClient();
      const [playback, storage] = await Promise.allSettled([
        stopPlaybackForSessionEnd({ failClosed: true }),
        clearAccountScopedStorage(),
      ]);
      if (!isCurrentAdoption()) return;
      if (playback.status === 'rejected' || storage.status === 'rejected') {
        setMediaCacheNamespace(undefined);
        await setToken(null);
        if (!isCurrentAdoption()) return;
        setUserId(null);
        setEmail(null);
        setError(
          'Account-linked data could not be cleared from this device. '
          + 'Clear the app’s data before another person uses it.',
        );
        statusRef.current = 'cleanup-required';
        setStatus('cleanup-required');
        return;
      }
      identityPlaybackStopped = true;
    }
    identity.current = nextIdentity;
    // Change both in-memory request identities before SecureStore yields. Otherwise an account
    // switch has a window where requests carry B's token but protected images use A's cache key,
    // placing B's media where a later A session can read it locally.
    setMediaCacheNamespace(session?.user?.id);
    await setToken(session?.access_token ?? null);
    // Checked AGAIN after the await. `setToken` touches SecureStore, so a callback can pass the
    // first check, pause here, and resume after the base-URL subscriber has retired its client —
    // then flip the app to `signed-in` for the OLD server, mounting every API consumer against the
    // new one before its session exists, which caches 401s the user has to restart to clear.
    if (!isCurrentAdoption()) return;
    let playbackAlreadyStopped = false;
    if (!session) {
      // Auth identity deletion can make refresh impossible before the app next opens. The local
      // intent is therefore an independent recovery signal: purge private device state even when
      // no JWT remains with which to observe the server's completed tombstone.
      const recovery = await recoverLocalDeletion(identityPlaybackStopped);
      if (!isCurrentAdoption()) return;
      playbackAlreadyStopped = recovery !== 'none';
      if (recovery === 'failed') {
        setUserId(null);
        setEmail(null);
        statusRef.current = 'cleanup-required';
        setStatus('cleanup-required');
        return;
      }
    }
    if (!isCurrentAdoption()) return;
    setUserId(session?.user?.id ?? null);
    setEmail(session?.user?.email ?? null);
    const next = session?.access_token ? 'signed-in' : 'signed-out';
    // Compared against a ref, not inside the setState updater. React may invoke an updater more
    // than once (Strict Mode, a discarded concurrent render), and an updater must stay pure — a
    // side effect in there can fire for a render that never commits.
    //
    // Covers every way a session ends, not just the Settings button: an expiring token and a
    // failed refresh both land here, and neither goes near that button.
    if (
      !playbackAlreadyStopped
      && statusRef.current === 'signed-in'
      && (next !== 'signed-in' || identityChanged)
    ) {
      void stopPlaybackForSessionEnd();
    }
    statusRef.current = next;
    setStatus(next);
  }, [recoverLocalDeletion]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    setStatus('unknown');
    setError(null);

    // The subscriber above may already have bumped this; take the next one either way so a
    // bootstrap always owns a generation no earlier callback can match.
    generation.current += 1;
    const mine = generation.current;
    adoptionEpoch.current += 1;

    void (async () => {
      let config: AuthConfig;
      try {
        config = await getAuthConfig();
      } catch {
        // Distinct from signed-out: the server may be down or the URL wrong. Telling the user to
        // sign in would be a lie, and would hide the actual problem behind a login form.
        if (!cancelled) {
          const recovery = await recoverLocalDeletion();
          setStatus(recovery === 'failed' ? 'cleanup-required' : 'unreachable');
        }
        return;
      }
      if (cancelled) return;
      setMode(config.mode);

      if (!config.enabled) {
        // A server switch can land here after an ambiguous deletion POST on the previous server.
        // The non-identifying intent is device-global and must win before this early return mounts
        // an auth-disabled app around account-linked drafts or protected media caches.
        const recovery = await recoverLocalDeletion();
        if (recovery === 'failed') {
          if (!cancelled) setStatus('cleanup-required');
          return;
        }
        await setToken(null);
        if (!cancelled) setStatus('disabled');
        return;
      }
      // Both values are required: mode() keys off the URL alone server-side, so a missing anon key
      // still reports "supabase" while leaving the client unable to construct anything.
      if (config.mode !== 'supabase' || !config.supabase_url || !config.supabase_anon_key) {
        const recovery = await recoverLocalDeletion();
        if (recovery === 'failed') {
          if (!cancelled) setStatus('cleanup-required');
          return;
        }
        if (!cancelled) setStatus('signed-out');
        return;
      }

      const supabase = createClient(config.supabase_url, config.supabase_anon_key, {
        auth: {
          storage: secureSessionStore,
          persistSession: true,
          autoRefreshToken: true,
          // Explicit: supabase-js still defaults to the implicit flow, which returns tokens in the
          // URL fragment. PKCE keeps them out of the redirect URL entirely and is the right choice
          // on a device, where that URL crosses the OS. It also gives ONE callback shape to handle
          // for both Google and magic link — the verifier persists through `storage` above.
          flowType: 'pkce',
          // Web-only: there is no URL fragment to read on a native launch, and leaving it on makes
          // supabase-js poke at browser globals that do not exist here.
          detectSessionInUrl: false,
          // Scoped to the project explicitly. Supabase's default key derives from only the FIRST
          // DNS LABEL of the URL, so two backends are not guaranteed distinct storage — and after
          // a server switch a session restored from the previous project would be adopted and its
          // token sent to the new host.
          storageKey: sessionStorageKey(config.supabase_url),
        },
      });
      client.current = supabase;

      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        void adoptSession(session, mine);
      });
      unsubscribe = () => data.subscription.unsubscribe();

      const restored = (await supabase.auth.getSession()).data.session;
      if (cancelled) return;
      await adoptSession(restored ?? null, mine);
      setClientReady((n) => n + 1);
      const parked = pendingUrl.current;
      if (parked) {
        pendingUrl.current = null;
        const message = await completeFromUrl(parked);
        if (!cancelled && message) setError(message);
      }
    })().catch(async (caught) => {
      // Without this the app sits on the loading spinner forever with no message: `status` never
      // leaves 'unknown', and an unhandled rejection in a fire-and-forget async IIFE is invisible.
      if (cancelled) return;
      const recovery = await recoverLocalDeletion();
      if (recovery === 'none') {
        setError(caught instanceof Error ? caught.message : 'Could not start sign-in.');
      }
      setStatus(
        recovery === 'failed'
          ? 'cleanup-required'
          : recovery === 'cleared' ? 'signed-out' : 'unreachable',
      );
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      // Stop the replaced client's refresh timer explicitly: it holds the old project's session
      // and would otherwise keep ticking against a server we have already left.
      client.current?.auth.stopAutoRefresh();
      client.current = null;
    };
  }, [adoptSession, attempt, recoverLocalDeletion]);

  // Pointing the app at a different server means a different Supabase project, and a JWT minted
  // by the old project is meaningless to the new one — worse, sending it there hands a bearer
  // credential to a server that has no business seeing it. Re-bootstrap from scratch.
  useEffect(() => subscribeBaseUrl(() => {
    // Retire the old client SYNCHRONOUSLY, here — not in the bootstrap effect. `setAttempt` only
    // *schedules* that effect, and until React runs it the old client's generation is still
    // current, so a refresh landing in the gap passes the generation check and restores the token
    // we just cleared. The new server's very first request could then carry the old project's JWT.
    generation.current += 1;
    const mine = generation.current;
    statusRef.current = 'unknown';
    setStatus('unknown');
    client.current?.auth.stopAutoRefresh();
    client.current = null;
    void setToken(null);

    // Server identity is an account boundary too. Replace the object, because a late manual cache
    // write can survive `clear()`, and forget which account the retired server had adopted.
    rotateActiveQueryClient();
    identity.current = null;
    // Do not let the replacement auth bootstrap mount until both private singleton playback and
    // account-scoped persistence are gone. Unmounting AudioProvider cannot stop TrackPlayer.
    void Promise.allSettled([
      stopPlaybackForSessionEnd({ failClosed: true }),
      clearAccountScopedStorage(),
    ]).then(([playback, storage]) => {
      if (mine !== generation.current) return;
      if (playback.status === 'rejected' || storage.status === 'rejected') {
        setUserId(null);
        setEmail(null);
        setError(
          'Account-linked data could not be cleared from this device. '
          + 'Clear the app’s data before another person uses it.',
        );
        statusRef.current = 'cleanup-required';
        setStatus('cleanup-required');
        return;
      }
      setAttempt((n) => n + 1);
    });
  }), []);

  // supabase-js refreshes on a timer, and a backgrounded RN app has its timers throttled or
  // stopped. Without this, a phone left locked overnight wakes with an expired access token and
  // every request 401s until something happens to trigger a refresh.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') client.current?.auth.startAutoRefresh();
      else client.current?.auth.stopAutoRefresh();
    });
    return () => subscription.remove();
  }, []);

  /** Turn a callback URL into a session. Returns an error message, or null on nothing-to-do.
   *
   *  Shared because the callback arrives two ways: Google returns in-process through
   *  `openAuthSessionAsync`, while a **magic link is tapped in a mail app** and arrives as an OS
   *  deep link, cold start or warm resume.
   *
   *  **Neither source is trusted, and there is no longer a `trusted` flag.** A custom URL scheme is
   *  not exclusive — any installed app can fire `researchcompanion://auth#access_token=…`. An
   *  earlier version accepted fragment tokens from the in-process result on the theory that we
   *  opened that browser ourselves, but Expo's Android implementation matches the returned URL by
   *  PREFIX, so `researchcompanion://auth.evil/auth#access_token=…` comes back as a "successful"
   *  browser result too. Since `flowType` is pinned to `pkce`, a legitimate callback NEVER carries
   *  fragment tokens, so the branch that adopted them is deleted rather than guarded.
   */
  const completeFromUrl = useCallback(async (url: string): Promise<string | null> => {
    const supabase = client.current;
    if (!supabase) return null;
    if (!isAuthCallback(url)) return null;

    const { queryParams } = Linking.parse(url);
    const code = queryParams?.code;
    if (typeof code === 'string') {
      // Only ever a PKCE code — and only while a sign-in this app started is outstanding. A code
      // is worthless to an attacker without the verifier in our own storage, but presenting one
      // still CONSUMES that verifier, which would let any installed app kill every legitimate
      // attempt on demand. The pending flag is persisted, because a magic link is tapped after the
      // app has closed.
      if (!(await consumePendingSignIn())) return null;
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      return exchangeError?.message ?? null;
    }
    // Supabase reports an expired or already-used link in params rather than by throwing. Safe to
    // surface: it establishes no session, it only explains a failure the user is already seeing.
    if (typeof queryParams?.error_description === 'string') return queryParams.error_description;
    if (typeof queryParams?.error === 'string') return String(queryParams.error);
    return null;
  }, []);

  // The magic link's only route home, and the cold-start race with it: `getInitialURL` usually
  // resolves BEFORE `/api/auth/config` has answered, so `client.current` is still null and a
  // one-shot URL would simply be dropped — the user taps their link, the app opens, and nothing
  // happens. So an unhandled URL is parked and replayed once a client exists.
  useEffect(() => {
    let cancelled = false;
    const handle = (url: string | null) => {
      if (cancelled || !url) return;
      if (!client.current) {
        pendingUrl.current = url;
        return;
      }
      void completeFromUrl(url).then((message) => {
        if (!cancelled && message) setError(message);
      });
    };
    void Linking.getInitialURL().then(handle).catch(() => {});
    const subscription = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [completeFromUrl, clientReady]);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    const supabase = client.current;
    if (!supabase) return;
    await markSignInPending();
    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      // skipBrowserRedirect: we open the URL ourselves so the result comes back through
      // WebBrowser rather than kicking the user out to an external browser they must return from.
      options: { redirectTo: redirectUri(), skipBrowserRedirect: true },
    });
    if (oauthError || !data?.url) {
      await clearPendingSignIn();
      setError(oauthError?.message ?? 'Could not start Google sign-in.');
      return;
    }
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectUri());
    if (result.type !== 'success') {
      await clearPendingSignIn();
      return;  // user dismissed; not an error worth showing
    }
    const message = await completeFromUrl(result.url);
    if (message) setError(message);
  }, [completeFromUrl]);

  const signInWithMagicLink = useCallback(async (address: string) => {
    setError(null);
    const supabase = client.current;
    if (!supabase || !address.trim()) return false;
    await markSignInPending();
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: address.trim(),
      options: { emailRedirectTo: redirectUri() },
    });
    if (otpError) {
      setError(otpError.message);
      return false;
    }
    return true;
  }, []);

  // Password auth exists for RELIABILITY, not parity. A magic link can land in spam, expire before
  // it is opened, or be opened in a browser that is not the one holding the pending sign-in — and
  // during the closed test a tester who cannot get in resets their own 14-continuous-day clock,
  // which is the longest-lead item in the launch plan. A password has no delivery step.
  //
  // Neither of these leaves the app, so unlike the OAuth and magic-link paths there is no pending
  // sign-in marker to set: that marker exists to survive a round trip through an external browser.
  // The session arrives synchronously and `onAuthStateChange` adopts it.
  const signInWithPassword = useCallback(async (address: string, password: string) => {
    setError(null);
    const supabase = client.current;
    if (!supabase) return false;
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: address.trim(),
      password,
    });
    if (signInError) {
      setError(signInError.message);
      return false;
    }
    return true;
  }, []);

  const signUpWithPassword = useCallback(
    async (address: string, password: string): Promise<PasswordSignUpResult> => {
      setError(null);
      const supabase = client.current;
      if (!supabase) return 'failed';
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
        return 'failed';
      }
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: address.trim(),
        password,
        options: { emailRedirectTo: redirectUri() },
      });
      if (signUpError) {
        setError(signUpError.message);
        return 'failed';
      }
      // An address that ALREADY has a confirmed account does not come back as an error. Supabase
      // returns an obfuscated user with an EMPTY `identities` array and sends no mail at all, so
      // as not to confirm to a stranger that the address is registered. Treating that as
      // `confirm-email` tells the user to watch an inbox nothing is coming to — which is exactly
      // how the first production sign-up attempt failed on 2026-07-29, silently and with no way
      // forward. Check it BEFORE the session check: this response has no session either.
      //
      // Surfacing it does not weaken the obfuscation. The empty array is already in the response
      // body, so anyone able to call `signUp` can read it; hiding it in the UI protects nobody and
      // costs a real user their only route in.
      if (data.user && (data.user.identities?.length ?? 0) === 0) return 'already-registered';
      // Supabase returns a session only when email confirmation is OFF. With it on — which is the
      // safer project setting and the one to expect — `session` is null and the account is inert
      // until the address is confirmed. Reporting that as success would strand the user on a
      // sign-in screen that keeps rejecting a password they just chose.
      return data.session ? 'signed-in' : 'confirm-email';
    },
    [],
  );

  const sendPasswordReset = useCallback(async (address: string) => {
    setError(null);
    const supabase = client.current;
    if (!supabase || !address.trim()) return false;
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(address.trim(), {
      redirectTo: redirectUri(),
    });
    if (resetError) {
      setError(resetError.message);
      return false;
    }
    return true;
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    let failure: string | null = null;
    try {
      await client.current?.auth.signOut();
    } catch (caught) {
      // `secureSessionStore.removeItem` now throws when it cannot purge the stored session, which
      // is the right call — a silent failure there is a sign-out that un-does itself on the next
      // launch. But it must not abort the rest of THIS sign-out: letting it propagate would skip
      // `adoptSession` below, leaving the app looking signed in with a live API token.
      failure = caught instanceof Error ? caught.message : 'Could not fully sign out.';
    }
    // Unconditional, and not left to onAuthStateChange: if the client was never built (auth
    // disabled, or an unreachable server) there is no listener to fire at all.
    await adoptSession(null);
    if (failure) {
      // Surfaced rather than swallowed. The user is signed out here, but a credential may still be
      // on the device, and that is worth them knowing on a shared or lost phone.
      setError(`${failure} Signed out on this device; clear the app's data if it was shared.`);
    }
  }, [adoptSession]);

  const reauthenticateForDeletion = useCallback(async () => {
    setError(null);
    const supabase = client.current;
    const mine = generation.current;
    if (!supabase) throw new Error('Your sign-in session is unavailable.');

    const current = (await supabase.auth.getSession()).data.session;
    if (!current || current.user.id !== userId) {
      throw new Error('Your sign-in session changed. Return to Settings and try again.');
    }
    const lastSignIn = Date.parse(current.user.last_sign_in_at ?? '');
    const signInAge = Date.now() - lastSignIn;
    // Stay comfortably inside the backend's five-minute AMR window so network/UI latency cannot
    // turn a client-approved destructive action into a confusing 401.
    if (Number.isFinite(lastSignIn) && signInAge >= -60_000 && signInAge < 4 * 60 * 1000) {
      await adoptSession(current, mine);
      return 'authenticated';
    }

    const providers = current.user.app_metadata?.providers;
    const provider = current.user.app_metadata?.provider;
    const usesGoogle = provider === 'google'
      || (Array.isArray(providers) && providers.includes('google'));
    if (!usesGoogle) {
      if (!current.user.email) throw new Error('This account has no verified email address.');
      await markSignInPending();
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: current.user.email,
        options: { emailRedirectTo: redirectUri() },
      });
      if (otpError) {
        await clearPendingSignIn();
        throw new Error(otpError.message);
      }
      return 'email-sent';
    }

    await markSignInPending();
    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUri(),
        skipBrowserRedirect: true,
        // Google documents select_account as an explicit authentication prompt. It prevents an
        // automatic refresh/cookie redirect from being mistaken for recent user presence.
        queryParams: { prompt: 'select_account' },
      },
    });
    if (oauthError || !data?.url) {
      await clearPendingSignIn();
      throw new Error(oauthError?.message ?? 'Could not confirm your Google account.');
    }
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectUri());
    if (result.type !== 'success') {
      await clearPendingSignIn();
      return 'cancelled';
    }
    const message = await completeFromUrl(result.url);
    if (message) throw new Error(message);
    const verified = (await supabase.auth.getSession()).data.session;
    if (!verified || verified.user.id !== userId) {
      // The provider chooser may select another Google account. Never reinterpret confirmation
      // for account A as authorization to delete B.
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      await adoptSession(null, mine);
      throw new Error('Choose the same Google account that is signed in to Seminar.');
    }
    const verifiedSignInAge = Date.now() - Date.parse(verified.user.last_sign_in_at ?? '');
    if (
      !Number.isFinite(verifiedSignInAge)
      || verifiedSignInAge < -60_000
      || verifiedSignInAge >= 4 * 60 * 1000
    ) {
      throw new Error('Google did not confirm a recent sign-in. Try again.');
    }
    await adoptSession(verified, mine);
    return 'authenticated';
  }, [adoptSession, completeFromUrl, userId]);

  const finishAccountDeletion = useCallback(async () => {
    setError(null);
    let failure: string | null = null;
    // Write the marker HERE too, not only on the device that tapped delete. The whole fail-closed
    // design downstream — keep the marker, retry on the next launch, block the app if cleanup is
    // still owed — rests on it existing, and `delete-account.tsx` was the only writer. A SECOND
    // signed-in device learns about the deletion by polling instead, so if its cleanup then failed
    // there was nothing to retry from: `recoverLocalDeletion()` reported 'none', the app went to a
    // plain signed-out state, and the deleted user's drafts, active project, playback snapshot and
    // image cache stayed on that device behind one dismissible warning.
    //
    // Marking before attempting anything is the correct order: an unnecessary marker costs one
    // redundant purge, a missing one costs silent retention.
    try {
      await markAccountDeletionIntent();
    } catch {
      // Best effort. Failing to mark must not stop the cleanup it exists to make retryable.
    }
    try {
      await stopPlaybackForSessionEnd({ failClosed: true });
    } catch {
      failure = 'Private playback could not be stopped.';
    }
    try {
      await clearDeletedAccountStorage();
    } catch {
      // Keep the local intent marker so a later signed-out launch retries cleanup.
      failure = 'Some account-linked data could not be cleared from this device.';
    }
    if (!failure) {
      try {
        await clearAccountDeletionIntent();
      } catch {
        failure = 'Some account-linked data could not be cleared from this device.';
      }
    }
    // The account is gone server-side whether or not the local purge succeeded, so record the
    // acknowledgement here rather than on the success path only. `cleanup-required` takes priority
    // in AuthGate, so a failed purge still shows its own screen first and this surfaces after.
    await markAccountDeleted().catch(() => {});
    setAccountDeleted(true);
    // Identity deletion already happened server-side. A normal/global sign-out would now make an
    // unnecessary Auth request against an account that no longer exists; local scope removes the
    // persisted Supabase session and refresh token from this device only.
    try {
      const result = await client.current?.auth.signOut({ scope: 'local' });
      if (result?.error) failure = result.error.message;
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : 'Could not clear the local session.';
    }
    await adoptSession(null);
    if (failure) {
      setError(`${failure} Clear the app's data before another person uses this device.`);
    }
  }, [adoptSession]);

  const value = useMemo<AuthState>(
    () => ({
      status, mode, userId, email, error,
      signInWithGoogle, signInWithMagicLink, reauthenticateForDeletion,
      signInWithPassword, signUpWithPassword, sendPasswordReset,
      finishAccountDeletion, signOut,
      accountDeleted,
      dismissAccountDeleted: () => {
        setAccountDeleted(false);
        void clearAccountDeleted();
      },
      retry: () => setAttempt((n) => n + 1),
    }),
    [
      status, mode, userId, email, error, signInWithGoogle, signInWithMagicLink,
      signInWithPassword, signUpWithPassword, sendPasswordReset,
      reauthenticateForDeletion, finishAccountDeletion, signOut, accountDeleted,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
