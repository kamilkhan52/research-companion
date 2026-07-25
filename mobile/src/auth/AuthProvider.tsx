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
import * as WebBrowser from 'expo-web-browser';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('unknown');
  const [mode, setMode] = useState<AuthConfig['mode'] | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const client = useRef<SupabaseClient | null>(null);

  /** The one place a session becomes an API token. Every path that changes the session — restore,
   *  sign-in, refresh, sign-out — goes through here, because `src/api/client.ts` reads the token
   *  synchronously from module state and would otherwise keep sending a stale one. An expired
   *  access token is a silent 401 an hour after sign-in, which looks like the backend breaking. */
  const adoptSession = useCallback(async (session: Session | null) => {
    await setToken(session?.access_token ?? null);
    setEmail(session?.user?.email ?? null);
    setStatus(session?.access_token ? 'signed-in' : 'signed-out');
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    setStatus('unknown');
    setError(null);

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
        },
      });
      client.current = supabase;

      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        void adoptSession(session);
      });
      unsubscribe = () => data.subscription.unsubscribe();

      const restored = (await supabase.auth.getSession()).data.session;
      if (!cancelled) await adoptSession(restored ?? null);
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
    void setToken(null);
    setAttempt((n) => n + 1);
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

  /** Turn a callback URL into a session. Returns an error message, or null on success.
   *
   *  Shared because there are two ways the callback arrives and only one of them was handled
   *  before: Google's comes back through `openAuthSessionAsync` in-process, but a **magic link is
   *  tapped in a mail app days later** and arrives as an OS deep link — cold start or warm resume.
   *  Parsing only the in-process result left the emailed link doing nothing at all: the app opened
   *  on the sign-in screen, still signed out, with no indication why. */
  const completeFromUrl = useCallback(async (url: string): Promise<string | null> => {
    const supabase = client.current;
    if (!supabase) return null;

    const { queryParams } = Linking.parse(url);
    const code = queryParams?.code;
    if (typeof code === 'string') {
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      return exchangeError?.message ?? null;
    }
    // Supabase surfaces auth failures (expired or already-used link) as query params, not as a
    // thrown error. Without this the user gets a silent no-op and taps the dead link again.
    if (typeof queryParams?.error_description === 'string') return queryParams.error_description;
    if (typeof queryParams?.error === 'string') return String(queryParams.error);

    // Implicit-flow fallback: tokens in the fragment. Kept because a project configured for the
    // implicit flow, or a link minted before flowType was pinned to pkce, still lands here.
    const fragment = url.split('#')[1] ?? '';
    if (fragment) {
      const params = new URLSearchParams(fragment);
      const access_token = params.get('access_token');
      const refresh_token = params.get('refresh_token');
      if (access_token && refresh_token) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token, refresh_token,
        });
        return sessionError?.message ?? null;
      }
      const described = params.get('error_description') ?? params.get('error');
      if (described) return described;
    }
    return null;  // an unrelated deep link into the app; not an auth callback
  }, []);

  // The magic link's only route home. `getInitialURL` covers a cold start (the app was not
  // running when the link was tapped); the listener covers a warm resume.
  useEffect(() => {
    let cancelled = false;
    const handle = (url: string | null) => {
      if (cancelled || !url) return;
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
  }, [completeFromUrl]);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    const supabase = client.current;
    if (!supabase) return;
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
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: address.trim(),
      options: { emailRedirectTo: redirectUri() },
    });
    setError(otpError?.message ?? 'Check your email for the sign-in link.');
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    await client.current?.auth.signOut();
    // Not left to onAuthStateChange alone: if the client was never built (auth disabled, or an
    // unreachable server) there is no listener to fire, and a token could survive a sign-out.
    await adoptSession(null);
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
