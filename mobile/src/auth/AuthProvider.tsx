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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';

import { stopPlaybackForSessionEnd } from '@/audio/AudioProvider';
import { getAuthConfig } from '@/api/endpoints';
import { setToken, subscribeBaseUrl } from '@/api/config';
import type { AuthConfig } from '@/api/types';

import { secureSessionStore } from './secureSessionStore';

/** `unknown` until /api/auth/config answers — the app must not decide it is signed out while it
 *  still does not know whether auth is even on. */
export type AuthStatus = 'unknown' | 'disabled' | 'signed-out' | 'signed-in' | 'unreachable';

interface AuthState {
  status: AuthStatus;
  /** Non-null only in supabase mode once config has loaded. */
  mode: AuthConfig['mode'] | null;
  email: string | null;
  error: string | null;
  signInWithGoogle: () => Promise<void>;
  signInWithMagicLink: (email: string) => Promise<void>;
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
  const [mode, setMode] = useState<AuthConfig['mode'] | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const queryClient = useQueryClient();
  const client = useRef<SupabaseClient | null>(null);
  /** A callback URL that arrived before the Supabase client existed (cold start). */
  const pendingUrl = useRef<string | null>(null);
  /** Bumped when a client becomes available, so the deep-link effect can replay. */
  const [clientReady, setClientReady] = useState(0);
  /** Bumped on every bootstrap. An auth callback captures the generation it belongs to, so a
   *  refresh completing on a REPLACED client cannot write its token back after we cleared it —
   *  which, on a server switch, would send the old project's JWT to the new host. */
  const generation = useRef(0);

  /** The one place a session becomes an API token. Every path that changes the session — restore,
   *  sign-in, refresh, sign-out — goes through here, because `src/api/client.ts` reads the token
   *  synchronously from module state and would otherwise keep sending a stale one. An expired
   *  access token is a silent 401 an hour after sign-in, which looks like the backend breaking. */
  const adoptSession = useCallback(async (session: Session | null, forGeneration?: number) => {
    // A callback from a superseded client must not win. React runs effect cleanup asynchronously,
    // so the old client stays subscribed for a moment after the base URL changes; if its refresh
    // lands in that window it would restore the old token on top of the clear.
    if (forGeneration !== undefined && forGeneration !== generation.current) return;
    await setToken(session?.access_token ?? null);
    // Checked AGAIN after the await. `setToken` touches SecureStore, so a callback can pass the
    // first check, pause here, and resume after the base-URL subscriber has retired its client —
    // then flip the app to `signed-in` for the OLD server, mounting every API consumer against the
    // new one before its session exists, which caches 401s the user has to restart to clear.
    if (forGeneration !== undefined && forGeneration !== generation.current) return;
    setEmail(session?.user?.email ?? null);
    setStatus((previous) => {
      const next = session?.access_token ? 'signed-in' : 'signed-out';
      // Covers every way a session ends, not just the Settings button: an expiring token and a
      // failed refresh both land here too, and neither goes anywhere near that button.
      if (previous === 'signed-in' && next !== 'signed-in') void stopPlaybackForSessionEnd();
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    setStatus('unknown');
    setError(null);

    // The subscriber above may already have bumped this; take the next one either way so a
    // bootstrap always owns a generation no earlier callback can match.
    generation.current += 1;
    const mine = generation.current;

    void (async () => {
      let config: AuthConfig;
      try {
        config = await getAuthConfig();
      } catch {
        // Distinct from signed-out: the server may be down or the URL wrong. Telling the user to
        // sign in would be a lie, and would hide the actual problem behind a login form.
        if (!cancelled) setStatus('unreachable');
        return;
      }
      if (cancelled) return;
      setMode(config.mode);

      if (!config.enabled) {
        await setToken(null);
        if (!cancelled) setStatus('disabled');
        return;
      }
      // Both values are required: mode() keys off the URL alone server-side, so a missing anon key
      // still reports "supabase" while leaving the client unable to construct anything.
      if (config.mode !== 'supabase' || !config.supabase_url || !config.supabase_anon_key) {
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
    })().catch((caught) => {
      // Without this the app sits on the loading spinner forever with no message: `status` never
      // leaves 'unknown', and an unhandled rejection in a fire-and-forget async IIFE is invisible.
      if (cancelled) return;
      setError(caught instanceof Error ? caught.message : 'Could not start sign-in.');
      setStatus('unreachable');
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      // Stop the replaced client's refresh timer explicitly: it holds the old project's session
      // and would otherwise keep ticking against a server we have already left.
      client.current?.auth.stopAutoRefresh();
      client.current = null;
    };
  }, [adoptSession, attempt]);

  // Pointing the app at a different server means a different Supabase project, and a JWT minted
  // by the old project is meaningless to the new one — worse, sending it there hands a bearer
  // credential to a server that has no business seeing it. Re-bootstrap from scratch.
  useEffect(() => subscribeBaseUrl(() => {
    // Retire the old client SYNCHRONOUSLY, here — not in the bootstrap effect. `setAttempt` only
    // *schedules* that effect, and until React runs it the old client's generation is still
    // current, so a refresh landing in the gap passes the generation check and restores the token
    // we just cleared. The new server's very first request could then carry the old project's JWT.
    generation.current += 1;
    client.current?.auth.stopAutoRefresh();
    client.current = null;
    void setToken(null);

    // Every cached answer belongs to the server that gave it. Query keys carry a project id but no
    // server identity, so without this the new server renders the OLD one's projects, papers and
    // settings — as fresh data, with no refetch to correct it — and an action can fire at server B
    // using a pid that only exists on A. `clear()` and not `invalidateQueries()`: invalidation
    // marks data stale but keeps serving it, which is exactly the wrong half of the behaviour here.
    queryClient.clear();
    void stopPlaybackForSessionEnd();
    // The remembered project is server-scoped for the same reason, and it is persisted, so it
    // would otherwise survive even a restart onto the new server.
    void AsyncStorage.removeItem('rc.activeProject');

    setAttempt((n) => n + 1);
  }), [queryClient]);

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
      setError(oauthError?.message ?? 'Could not start Google sign-in.');
      return;
    }
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectUri());
    if (result.type !== 'success') return;  // user dismissed; not an error worth showing
    const message = await completeFromUrl(result.url);
    if (message) setError(message);
  }, [completeFromUrl]);

  const signInWithMagicLink = useCallback(async (address: string) => {
    setError(null);
    const supabase = client.current;
    if (!supabase || !address.trim()) return;
    await markSignInPending();
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: address.trim(),
      options: { emailRedirectTo: redirectUri() },
    });
    setError(otpError?.message ?? 'Check your email for the sign-in link.');
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

  const value = useMemo<AuthState>(
    () => ({
      status, mode, email, error,
      signInWithGoogle, signInWithMagicLink, signOut,
      retry: () => setAttempt((n) => n + 1),
    }),
    [status, mode, email, error, signInWithGoogle, signInWithMagicLink, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
