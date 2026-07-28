// The property this whole feature hinges on: whatever Supabase currently considers the session,
// `src/api/config.ts` must be holding the matching access token. `client.ts` reads that token
// synchronously from module state, so a session change that does not reach `setToken` produces
// silent 401s — most cruelly an hour after sign-in, when the first refresh lands.

import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderAsync, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from 'react-native';

import * as apiConfig from '@/api/config';
import { subscribeBaseUrl } from '@/api/config';
import * as endpoints from '@/api/endpoints';
import { AuthProvider, redirectUri, sessionStorageKey, useAuth } from '@/auth/AuthProvider';
import {
  hasAccountDeletionIntent,
  markAccountDeletionIntent,
} from '@/auth/accountCleanup';
import { createTestQueryClient } from './queryClient';

let authStateCallback: ((event: string, session: unknown) => void) | undefined;
const mockAuth = {
  onAuthStateChange: jest.fn((cb: (event: string, session: unknown) => void) => {
    authStateCallback = cb;
    return { data: { subscription: { unsubscribe: jest.fn() } } };
  }),
  getSession: jest.fn(async (): Promise<{ data: { session: unknown } }> => ({ data: { session: null } })),
  signOut: jest.fn(async () => ({ error: null })),
  exchangeCodeForSession: jest.fn(async () => ({ error: null })),
  setSession: jest.fn(async () => ({ error: null })),
  signInWithOtp: jest.fn(
    async (_options?: unknown): Promise<{ error: { message: string } | null }> => ({ error: null }),
  ),
  signInWithOAuth: jest.fn(async () => ({
    data: { url: 'https://project.supabase.co/auth/v1/authorize?x=1' }, error: null,
  })),
  startAutoRefresh: jest.fn(),
  stopAutoRefresh: jest.fn(),
};

jest.mock('@supabase/supabase-js', () => ({
  // `__esModule` matters: AuthProvider reaches the module via a dynamic `await import()`, and
  // without this flag the namespace object does not expose the named export.
  __esModule: true,
  createClient: jest.fn(() => ({ auth: mockAuth })),
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('expo-image', () => ({
  Image: {
    clearMemoryCache: jest.fn(async () => true),
    clearDiskCache: jest.fn(async () => true),
  },
}));
jest.mock('@/audio/AudioProvider', () => ({
  stopPlaybackForSessionEnd: jest.fn(async () => undefined),
}));
let deepLinkHandler: ((event: { url: string }) => void) | undefined;
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `researchcompanion://${path}`,
  // REAL parse semantics, not a convenient shape. `researchcompanion://auth` puts "auth" in the
  // HOSTNAME and leaves the path null — mocking `{ path: 'auth' }` (as an earlier version of this
  // file did) describes a URL that never occurs, and hid a guard that rejected every real callback.
  parse: jest.fn((url: string) => {
    const parsed = new URL(url);
    const queryParams: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => { queryParams[key] = value; });
    return {
      scheme: parsed.protocol.replace(/:$/, ''),
      hostname: parsed.hostname || null,
      path: parsed.pathname.replace(/^\/+/, '') || null,
      queryParams,
    };
  }),
  getInitialURL: jest.fn(async () => null),
  addEventListener: jest.fn((_event: string, cb: (e: { url: string }) => void) => {
    deepLinkHandler = cb;
    return { remove: jest.fn() };
  }),
}));
jest.mock('expo-secure-store', () => ({
  // A sign-in is marked pending before the callback is honoured, so default to "one is pending".
  getItemAsync: jest.fn(async () => 'pending'),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const SUPABASE_CONFIG = {
  mode: 'supabase' as const,
  enabled: true,
  supabase_url: 'https://project.supabase.co',
  supabase_anon_key: 'sb_publishable_test',
};

function Probe() {
  const { status } = useAuth();
  return <Text>{status}</Text>;
}

/** AuthProvider clears the query cache on a server switch, so it needs a client above it. */
function withQuery(children: React.ReactNode) {
  const client = createTestQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function renderProvider() {
  return renderAsync(withQuery(<AuthProvider><Probe /></AuthProvider>));
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  // clearAllMocks resets CALLS, not implementations — a mockResolvedValue set by one test would
  // otherwise deliver its cold-start URL to every test after it.
  jest.requireMock('expo-linking').getInitialURL.mockResolvedValue(null);
  jest.requireMock('expo-secure-store').getItemAsync.mockResolvedValue('pending');
  authStateCallback = undefined;
  mockAuth.getSession.mockResolvedValue({ data: { session: null } });
  mockAuth.signInWithOtp.mockResolvedValue({ error: null });
  jest.spyOn(apiConfig, 'setToken').mockResolvedValue(undefined);
  jest.spyOn(apiConfig, 'subscribeBaseUrl').mockImplementation(() => jest.fn());
});

test('a restored session becomes the API token before anything renders as signed in', async () => {
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  mockAuth.getSession.mockResolvedValue({
    data: { session: { access_token: 'restored-jwt', user: { email: 'r@example.com' } } },
  });

  const { getByText } = await renderProvider();
  await waitFor(() => getByText('signed-in'));
  expect(apiConfig.setToken).toHaveBeenCalledWith('restored-jwt');
});

test('a token refresh replaces the stored token', async () => {
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  mockAuth.getSession.mockResolvedValue({
    data: { session: { access_token: 'first-jwt', user: { email: 'r@example.com' } } },
  });

  const { getByText } = await renderProvider();
  await waitFor(() => getByText('signed-in'));

  // This is the case that breaks silently without the listener: supabase-js rotates the access
  // token on its own schedule, and nothing else tells the API client about it.
  authStateCallback?.('TOKEN_REFRESHED', {
    access_token: 'second-jwt', user: { email: 'r@example.com' },
  });
  await waitFor(() => expect(apiConfig.setToken).toHaveBeenCalledWith('second-jwt'));
});

test('account deletion reauthentication requires Google account selection and adopts its token', async () => {
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  const oldSession = {
    access_token: 'old-jwt',
    user: {
      id: 'user-a',
      email: 'r@example.com',
      last_sign_in_at: '2026-07-20T00:00:00Z',
      app_metadata: { provider: 'google', providers: ['google'] },
    },
  };
  mockAuth.getSession.mockResolvedValue({
    data: { session: oldSession },
  });
  const WebBrowser = jest.requireMock('expo-web-browser');
  WebBrowser.openAuthSessionAsync.mockResolvedValue({
    type: 'success', url: `${redirectUri()}?code=reauth-code`,
  });
  const freshSession = {
    access_token: 'fresh-jwt',
    user: {
      ...oldSession.user,
      last_sign_in_at: new Date().toISOString(),
    },
  };

  let auth: ReturnType<typeof useAuth> | undefined;
  function Capture() { auth = useAuth(); return <Text>{auth.status}</Text>; }
  const { getByText } = await renderAsync(withQuery(<AuthProvider><Capture /></AuthProvider>));
  await waitFor(() => getByText('signed-in'));
  mockAuth.getSession
    .mockResolvedValueOnce({ data: { session: oldSession } })
    .mockResolvedValueOnce({ data: { session: freshSession } });

  await act(async () => {
    await auth!.reauthenticateForDeletion();
  });

  expect(mockAuth.signInWithOAuth).toHaveBeenCalledWith({
    provider: 'google',
    options: expect.objectContaining({
      redirectTo: redirectUri(),
      skipBrowserRedirect: true,
      queryParams: { prompt: 'select_account' },
    }),
  });
  expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('reauth-code');
  expect(apiConfig.setToken).toHaveBeenLastCalledWith('fresh-jwt');
});

test('recent email authentication is accepted without sending another link', async () => {
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  mockAuth.getSession.mockResolvedValue({
    data: {
      session: {
        access_token: 'recent-jwt',
        user: {
          id: 'user-a',
          email: 'r@example.com',
          last_sign_in_at: new Date().toISOString(),
          app_metadata: { provider: 'email', providers: ['email'] },
        },
      },
    },
  });

  let auth: ReturnType<typeof useAuth> | undefined;
  function Capture() { auth = useAuth(); return <Text>{auth.status}</Text>; }
  const { getByText } = await renderAsync(withQuery(<AuthProvider><Capture /></AuthProvider>));
  await waitFor(() => getByText('signed-in'));

  let result: Awaited<ReturnType<NonNullable<typeof auth>['reauthenticateForDeletion']>>;
  await act(async () => {
    result = await auth!.reauthenticateForDeletion();
  });

  expect(result!).toBe('authenticated');
  expect(mockAuth.signInWithOtp).not.toHaveBeenCalled();
});

test('finishing deletion uses local sign-out and clears the API token', async () => {
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  mockAuth.getSession.mockResolvedValue({
    data: {
      session: {
        access_token: 'soon-deleted',
        user: { id: 'user-a', email: 'r@example.com' },
      },
    },
  });

  let auth: ReturnType<typeof useAuth> | undefined;
  function Capture() { auth = useAuth(); return <Text>{auth.status}</Text>; }
  const { getByText } = await renderAsync(withQuery(<AuthProvider><Capture /></AuthProvider>));
  await waitFor(() => getByText('signed-in'));

  await act(async () => {
    await auth!.finishAccountDeletion();
  });

  expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  expect(apiConfig.setToken).toHaveBeenLastCalledWith(null);
  await waitFor(() => expect(getByText('signed-out')).toBeTruthy());
});

test('cold start honors local deletion intent without a restorable session or reachable API', async () => {
  await AsyncStorage.setItem('rc.activeProject', 'private-project');
  await AsyncStorage.setItem('rc.draft.v1:private-project:paper', 'private draft');
  await markAccountDeletionIntent();
  jest.spyOn(endpoints, 'getAuthConfig').mockRejectedValue(new Error('server unavailable'));

  const { getByText } = await renderProvider();
  await waitFor(() => getByText('unreachable'));
  expect(await AsyncStorage.getItem('rc.activeProject')).toBeNull();
  expect(await AsyncStorage.getItem('rc.draft.v1:private-project:paper')).toBeNull();
  expect(await hasAccountDeletionIntent()).toBe(false);
});

test('signing out clears the token, not just the UI state', async () => {
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  mockAuth.getSession.mockResolvedValue({
    data: { session: { access_token: 'a-jwt', user: { email: 'r@example.com' } } },
  });

  let auth: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    auth = useAuth();
    return <Text>{auth.status}</Text>;
  }
  const { getByText } = await renderAsync(withQuery(<AuthProvider><Capture /></AuthProvider>));
  await waitFor(() => getByText('signed-in'));

  await auth!.signOut();
  await waitFor(() => expect(apiConfig.setToken).toHaveBeenLastCalledWith(null));
});

test('an unreachable server is not reported as signed out', async () => {
  // Telling someone to sign in when the server is down sends them to fix the wrong thing, and no
  // password they type will help.
  jest.spyOn(endpoints, 'getAuthConfig').mockRejectedValue(new Error('network'));
  const { getByText } = await renderProvider();
  await waitFor(() => getByText('unreachable'));
});

test('a backend with auth disabled clears any stale token and lets the app through', async () => {
  await AsyncStorage.setItem('rc.activeProject', 'private-project');
  await markAccountDeletionIntent();
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue({ mode: 'open', enabled: false });
  const { getByText } = await renderProvider();
  await waitFor(() => getByText('disabled'));
  // A token left from a previous authenticated server would be sent to one that never asked for
  // it — harmless today, but it is a credential travelling somewhere it has no business going.
  expect(apiConfig.setToken).toHaveBeenCalledWith(null);
  expect(await AsyncStorage.getItem('rc.activeProject')).toBeNull();
  expect(await hasAccountDeletionIntent()).toBe(false);
});

test('an auth-disabled server cannot mount content when deletion cleanup fails', async () => {
  const ExpoImage = jest.requireMock('expo-image').Image;
  ExpoImage.clearDiskCache.mockResolvedValueOnce(false);
  await AsyncStorage.setItem('rc.activeProject', 'private-project');
  await markAccountDeletionIntent();
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue({ mode: 'open', enabled: false });

  const { getByText } = await renderProvider();

  await waitFor(() => getByText('cleanup-required'));
  expect(await hasAccountDeletionIntent()).toBe(true);
});

test('supabase mode without an anon key does not pretend to be signed in', async () => {
  // mode() keys off the URL alone server-side, so this combination is reachable by misconfiguration.
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue({
    mode: 'supabase', enabled: true, supabase_url: 'https://project.supabase.co',
  });
  const { getByText } = await renderProvider();
  await waitFor(() => getByText('signed-out'));
});


describe('the magic link, which arrives as an OS deep link rather than in-process', () => {
  const Linking = jest.requireMock('expo-linking');

  beforeEach(() => {
    jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  });

  test('a link tapped while the app runs completes the sign-in', async () => {
    const { getByText } = await renderProvider();
    await waitFor(() => getByText('signed-out'));

    // Google comes back through openAuthSessionAsync; a magic link does NOT — it is tapped in a
    // mail app and arrives here. Handling only the former left this flow doing nothing at all.
    deepLinkHandler!({ url: 'researchcompanion://auth?code=pkce-code' });

    await waitFor(() =>
      expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('pkce-code'));
  });

  test('a link tapped while the app is closed completes on cold start', async () => {
    Linking.getInitialURL.mockResolvedValue('researchcompanion://auth?code=cold-code');

    await renderProvider();
    await waitFor(() => expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('cold-code'));
  });

  test('an expired link surfaces its reason instead of silently doing nothing', async () => {
    // Supabase reports these as query params, not as a thrown error. Without handling them the
    // user taps a dead link, sees no change, and taps it again.

    let auth: ReturnType<typeof useAuth> | undefined;
    function Capture() { auth = useAuth(); return <Text>{auth.status}</Text>; }
    const { getByText } = await renderAsync(withQuery(<AuthProvider><Capture /></AuthProvider>));
    await waitFor(() => getByText('signed-out'));

    deepLinkHandler!({
      url: 'researchcompanion://auth?error=access_denied'
        + '&error_description=Email%20link%20is%20invalid%20or%20has%20expired',
    });
    await waitFor(() => expect(auth!.error).toMatch(/invalid or has expired/));
    expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  test('an unrelated deep link is not treated as an auth callback', async () => {
    const { getByText } = await renderProvider();
    await waitFor(() => getByText('signed-out'));

    deepLinkHandler!({ url: 'researchcompanion://paper/attention-is-all-you-need' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockAuth.setSession).not.toHaveBeenCalled();
  });
});


describe('a deep link is not a trusted channel', () => {
  const Linking = jest.requireMock('expo-linking');

  beforeEach(() => {
    jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  });

  test('tokens delivered by another app are ignored', async () => {
    // A custom scheme is not exclusive: ANY installed app can fire
    // researchcompanion://auth#access_token=…&refresh_token=…. Honouring it would plant the
    // attacker's session — the victim then writes their reading notes into the attacker's account
    // — or a non-allowlisted one, which just bricks the app.
    const { getByText } = await renderProvider();
    await waitFor(() => getByText('signed-out'));

    deepLinkHandler!({
      url: 'researchcompanion://auth#access_token=attacker-jwt&refresh_token=attacker-refresh',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockAuth.setSession).not.toHaveBeenCalled();
    expect(apiConfig.setToken).not.toHaveBeenCalledWith('attacker-jwt');
  });

  test('but a PKCE code from the same channel is fine, because it needs our verifier', async () => {
    // The guard must not be "ignore deep links" — that would break the magic link again. A code is
    // worthless without the verifier held in our own storage, which is the point of PKCE.
    const { getByText } = await renderProvider();
    await waitFor(() => getByText('signed-out'));

    deepLinkHandler!({ url: 'researchcompanion://auth?code=legit-code' });
    await waitFor(() => expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('legit-code'));
  });

  test('a lookalike host is not our callback', async () => {
    // researchcompanion://auth.evil/auth passes a naive prefix match — which is exactly how Expo's
    // Android openAuthSessionAsync decides a URL is "our" result — but the authority is not ours.
    const { getByText } = await renderProvider();
    await waitFor(() => getByText('signed-out'));

    deepLinkHandler!({ url: 'researchcompanion://auth.evil/auth?code=sneaky' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
  });
});

test('a magic link that lands before the auth config does is not dropped', async () => {
  // The cold-start race: getInitialURL almost always resolves BEFORE /api/auth/config, so the
  // client does not exist yet. Dropping the one-shot URL there means the user taps their link,
  // the app opens, and nothing happens — with no second chance.
  const Linking = jest.requireMock('expo-linking');
  Linking.getInitialURL.mockResolvedValue('researchcompanion://auth?code=parked-code');

  let releaseConfig: (value: typeof SUPABASE_CONFIG) => void;
  jest.spyOn(endpoints, 'getAuthConfig').mockReturnValue(
    new Promise((resolve) => { releaseConfig = resolve; }),
  );

  await renderProvider();
  expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();  // nothing to exchange with yet

  releaseConfig!(SUPABASE_CONFIG);
  await waitFor(() => expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('parked-code'));
});


test('a failure to purge stored credentials still signs the user out locally', async () => {
  // secureSessionStore.removeItem throws when it cannot clear the session — correct, because a
  // silent failure there is a sign-out that reverses on the next launch. But it must not abort the
  // rest of sign-out: propagating would skip token clearing and leave the app looking signed in
  // with a live API token, which is the worse of the two failures.
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  mockAuth.getSession.mockResolvedValue({
    data: { session: { access_token: 'a-jwt', user: { email: 'r@example.com' } } },
  });
  mockAuth.signOut.mockRejectedValueOnce(new Error('Could not fully clear the stored session'));

  let auth: ReturnType<typeof useAuth> | undefined;
  function Capture() { auth = useAuth(); return <Text>{auth.status}</Text>; }
  const { getByText } = await renderAsync(withQuery(<AuthProvider><Capture /></AuthProvider>));
  await waitFor(() => getByText('signed-in'));

  await auth!.signOut();
  await waitFor(() => getByText('signed-out'));
  expect(apiConfig.setToken).toHaveBeenLastCalledWith(null);
  expect(auth!.error).toMatch(/clear the app/i);
});


test('a code arriving with no sign-in outstanding is ignored', async () => {
  // A PKCE code cannot mint a session without our verifier — but presenting one CONSUMES that
  // verifier, so any installed app could otherwise kill every legitimate sign-in on demand by
  // firing codes at us. The gate narrows that from "always" to "while the user is mid-sign-in".
  const SecureStore = jest.requireMock('expo-secure-store');
  SecureStore.getItemAsync.mockResolvedValue(null);  // nothing pending
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);

  const { getByText } = await renderProvider();
  await waitFor(() => getByText('signed-out'));

  deepLinkHandler!({ url: 'researchcompanion://auth?code=unsolicited' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
});

test('the real redirect URI is accepted — the shape Expo actually produces', async () => {
  // Regression guard for the bug this round found: `researchcompanion://auth` puts "auth" in the
  // HOSTNAME with a null path, so a path-based check rejected every genuine callback and both
  // sign-in methods silently did nothing. Asserted against redirectUri() itself so the test cannot
  // drift from what the app registers.
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  const { getByText } = await renderProvider();
  await waitFor(() => getByText('signed-out'));

  deepLinkHandler!({ url: `${redirectUri()}?code=real-shape` });
  await waitFor(() => expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('real-shape'));
});


test('a refresh from the retired client cannot restore the token after a server switch', async () => {
  // The race: setAttempt only SCHEDULES the bootstrap effect, so between the URL changing and
  // React running that effect the old client was still "current". A refresh landing in that gap
  // put the old project's JWT back — and the new server's first request would carry it.
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  mockAuth.getSession.mockResolvedValue({
    data: { session: { access_token: 'old-jwt', user: { email: 'r@example.com' } } },
  });

  const { getByText } = await renderProvider();
  await waitFor(() => getByText('signed-in'));
  const notify = (subscribeBaseUrl as jest.Mock).mock.calls.at(-1)![0] as () => void;

  notify();  // the user saved a new server URL

  // The retired client refreshes anyway — it is still subscribed until React cleans up.
  authStateCallback!('TOKEN_REFRESHED', {
    access_token: 'old-jwt-refreshed', user: { email: 'r@example.com' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(apiConfig.setToken).not.toHaveBeenCalledWith('old-jwt-refreshed');
});


test('an adoption paused mid-await cannot flip the app to the old server', async () => {
  // Narrower than the previous race and not covered by it: the callback passes the generation
  // check, then PAUSES inside setToken (SecureStore), and the retirement happens while it waits.
  // Resuming would set status 'signed-in' for the old server, mounting every API consumer against
  // the new one before its session exists — and those 401s get cached.
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  mockAuth.getSession.mockResolvedValue({ data: { session: null } });

  let releaseSetToken: () => void;
  const { getByText, queryByText } = await renderProvider();
  await waitFor(() => getByText('signed-out'));

  const notify = (apiConfig.subscribeBaseUrl as jest.Mock).mock.calls.at(-1)![0] as () => void;
  (apiConfig.setToken as jest.Mock).mockImplementationOnce(
    () => new Promise<void>((resolve) => { releaseSetToken = resolve; }),
  );

  authStateCallback!('TOKEN_REFRESHED', {
    access_token: 'old-jwt', user: { email: 'old@example.com' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));  // now parked inside setToken

  notify();            // the server switch happens while it waits
  releaseSetToken!();  // and only then does it resume
  await new Promise((resolve) => setTimeout(resolve, 0));

  // 'unknown' is correct here — the switch restarts the bootstrap. What must NOT happen is the
  // resumed callback declaring the app signed in to the server we just left.
  expect(queryByText('signed-in')).toBeNull();
});

test('two Supabase URLs that differ only in punctuation get different storage keys', async () => {
  // replace(/[^a-zA-Z0-9]/g, '-') collapses these to the same key, which would let one project's
  // session be restored under the other and its bearer token sent to the wrong backend.
  expect(sessionStorageKey('https://auth-a.example.com'))
    .not.toBe(sessionStorageKey('https://auth.a-example.com'));
  // Stable across trivial variation, so a session is not orphaned by a trailing slash.
  expect(sessionStorageKey('https://p.supabase.co/'))
    .toBe(sessionStorageKey('https://P.supabase.co'));
  // And within the alphabet secureSessionStore accepts, so nothing downstream rewrites it.
  expect(sessionStorageKey('https://p.supabase.co')).toMatch(/^[A-Za-z0-9._-]+$/);
});


test('the storage key needs no btoa, because React Native has none', () => {
  // The round-5 version called btoa. TypeScript accepts it from the DOM lib and Node provides it,
  // so the test passed — but Hermes has no btoa, so on a real device the call threw into a
  // fallback that restored the very collision the fix was for. Deleting the global here proves the
  // implementation does not reach for it.
  const saved = (globalThis as { btoa?: unknown }).btoa;
  delete (globalThis as { btoa?: unknown }).btoa;
  try {
    expect(sessionStorageKey('https://auth-a.example.com'))
      .not.toBe(sessionStorageKey('https://auth.a-example.com'));
    expect(sessionStorageKey('https://p.supabase.co')).toMatch(/^[A-Za-z0-9._-]+$/);
  } finally {
    (globalThis as { btoa?: unknown }).btoa = saved;
  }
});

test('the encoder agrees with real base64url, including on non-ASCII', () => {
  // Guards the tails (1-, 2- and 3-byte remainders) AND the UTF-8 encoding. The ASCII-only version
  // of this test was the fifth in this PR to pass against a broken implementation: it could not
  // see that masking a code point to a byte is lossy.
  for (const value of ['a', 'ab', 'abc', 'abcd', 'abcde', 'https://p.supabase.co', 'ā', '日本語', '🎧']) {
    const expected = `sb-${Buffer.from(value, 'utf8').toString('base64url')}-auth`;
    expect(sessionStorageKey(value)).toBe(expected);
  }
});

test('code points sharing a low byte do not share a key', () => {
  // `& 0xff` collapses U+0101 and U+0201 to the same byte, so two distinct projects would share a
  // session — and one's bearer token would be sent to the other's backend.
  expect(sessionStorageKey('\u0101')).not.toBe(sessionStorageKey('\u0201'));
});

test('canonicalisation lowercases the host but not a case-sensitive path', () => {
  expect(sessionStorageKey('https://P.supabase.co')).toBe(sessionStorageKey('https://p.supabase.co/'));
  expect(sessionStorageKey('https://p.example.com/Proxy'))
    .not.toBe(sessionStorageKey('https://p.example.com/proxy'));
});

test('Google sign-in opens the browser and completes through the shared handler', async () => {
  // This path had no coverage at all: mockAuth did not even define signInWithOAuth, so it could
  // have become a no-op without failing anything.
  const WebBrowser = jest.requireMock('expo-web-browser');
  WebBrowser.openAuthSessionAsync.mockResolvedValue({
    type: 'success', url: `${redirectUri()}?code=google-code`,
  });
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);

  let auth: ReturnType<typeof useAuth> | undefined;
  function Capture() { auth = useAuth(); return <Text>{auth.status}</Text>; }
  const { getByText } = await renderAsync(withQuery(<AuthProvider><Capture /></AuthProvider>));
  await waitFor(() => getByText('signed-out'));

  await auth!.signInWithGoogle();

  expect(mockAuth.signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'google',
    options: expect.objectContaining({ redirectTo: redirectUri(), skipBrowserRedirect: true }),
  }));
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
    'https://project.supabase.co/auth/v1/authorize?x=1', redirectUri());
  await waitFor(() => expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('google-code'));
});

test('a dismissed Google sign-in is not reported as an error', async () => {
  const WebBrowser = jest.requireMock('expo-web-browser');
  WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'dismiss' });
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);

  let auth: ReturnType<typeof useAuth> | undefined;
  function Capture() { auth = useAuth(); return <Text>{auth.status}</Text>; }
  const { getByText } = await renderAsync(withQuery(<AuthProvider><Capture /></AuthProvider>));
  await waitFor(() => getByText('signed-out'));

  await auth!.signInWithGoogle();
  expect(auth!.error).toBeNull();
  expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
});

test('an accepted magic-link request reports success without manufacturing an error', async () => {
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);

  let auth: ReturnType<typeof useAuth> | undefined;
  function Capture() { auth = useAuth(); return <Text>{auth.status}</Text>; }
  const { getByText } = await renderAsync(withQuery(<AuthProvider><Capture /></AuthProvider>));
  await waitFor(() => getByText('signed-out'));

  await expect(auth!.signInWithMagicLink(' reader@example.com ')).resolves.toBe(true);
  expect(mockAuth.signInWithOtp).toHaveBeenCalledWith(expect.objectContaining({
    email: 'reader@example.com',
  }));
  expect(auth!.error).toBeNull();
});

test('a rejected magic-link request reports failure and surfaces the provider error', async () => {
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  mockAuth.signInWithOtp.mockResolvedValue({ error: { message: 'Email delivery failed' } });

  let auth: ReturnType<typeof useAuth> | undefined;
  function Capture() { auth = useAuth(); return <Text>{auth.status}</Text>; }
  const { getByText } = await renderAsync(withQuery(<AuthProvider><Capture /></AuthProvider>));
  await waitFor(() => getByText('signed-out'));

  await expect(auth!.signInWithMagicLink('reader@example.com')).resolves.toBe(false);
  await waitFor(() => expect(auth!.error).toBe('Email delivery failed'));
});


test('switching servers drops the previous server\'s cached data', async () => {
  // Query keys carry a project id but no server identity, so without this the new server renders
  // the OLD one's projects and settings as FRESH data — and an action can fire at server B using a
  // pid that only exists on A. invalidateQueries is not enough: it marks data stale and keeps
  // serving it, which is the wrong half of the behaviour.
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
  const client = createTestQueryClient();
  client.setQueryData(['projects'], [{ id: 'from-server-a' }]);

  const { getByText } = await renderAsync(
    <QueryClientProvider client={client}><AuthProvider><Probe /></AuthProvider></QueryClientProvider>,
  );
  await waitFor(() => getByText('signed-out'));

  const notify = (apiConfig.subscribeBaseUrl as jest.Mock).mock.calls.at(-1)![0] as () => void;
  notify();

  expect(client.getQueryData(['projects'])).toBeUndefined();
});


describe('a session ending silences playback, however it ends', () => {
  const audio = jest.requireMock('@/audio/AudioProvider');

  beforeEach(() => {
    jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue(SUPABASE_CONFIG);
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'a-jwt', user: { email: 'r@example.com' } } },
    });
  });

  test('a token that expires on its own, with no button pressed', async () => {
    // The Settings sign-out button called dismiss() directly, so it looked covered. An expiring
    // token never touches that button, and the narration kept playing over the sign-in screen.
    const { getByText } = await renderProvider();
    await waitFor(() => getByText('signed-in'));

    authStateCallback!('SIGNED_OUT', null);
    await waitFor(() => expect(audio.stopPlaybackForSessionEnd).toHaveBeenCalled());
  });

  test('a server switch', async () => {
    const { getByText } = await renderProvider();
    await waitFor(() => getByText('signed-in'));

    const notify = (apiConfig.subscribeBaseUrl as jest.Mock).mock.calls.at(-1)![0] as () => void;
    notify();
    expect(audio.stopPlaybackForSessionEnd).toHaveBeenCalled();
  });

  test('but not on an ordinary token refresh', async () => {
    // The guard that keeps the two above honest: firing on every session change would cut off
    // playback once an hour, every hour, for no reason.
    const { getByText } = await renderProvider();
    await waitFor(() => getByText('signed-in'));

    authStateCallback!('TOKEN_REFRESHED', {
      access_token: 'fresh-jwt', user: { email: 'r@example.com' },
    });
    await waitFor(() => expect(apiConfig.setToken).toHaveBeenCalledWith('fresh-jwt'));
    expect(audio.stopPlaybackForSessionEnd).not.toHaveBeenCalled();
  });
});
