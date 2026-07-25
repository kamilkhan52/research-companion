// The property this whole feature hinges on: whatever Supabase currently considers the session,
// `src/api/config.ts` must be holding the matching access token. `client.ts` reads that token
// synchronously from module state, so a session change that does not reach `setToken` produces
// silent 401s — most cruelly an hour after sign-in, when the first refresh lands.

import { renderAsync, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import * as apiConfig from '@/api/config';
import * as endpoints from '@/api/endpoints';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';

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
  signInWithOtp: jest.fn(async () => ({ error: null })),
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
let deepLinkHandler: ((event: { url: string }) => void) | undefined;
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `researchcompanion://${path}`,
  parse: jest.fn(() => ({ queryParams: {} })),
  getInitialURL: jest.fn(async () => null),
  addEventListener: jest.fn((_event: string, cb: (e: { url: string }) => void) => {
    deepLinkHandler = cb;
    return { remove: jest.fn() };
  }),
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

async function renderProvider() {
  return renderAsync(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  authStateCallback = undefined;
  mockAuth.getSession.mockResolvedValue({ data: { session: null } });
  jest.spyOn(apiConfig, 'setToken').mockResolvedValue(undefined);
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
  const { getByText } = await renderAsync(
    <AuthProvider>
      <Capture />
    </AuthProvider>,
  );
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
  jest.spyOn(endpoints, 'getAuthConfig').mockResolvedValue({ mode: 'open', enabled: false });
  const { getByText } = await renderProvider();
  await waitFor(() => getByText('disabled'));
  // A token left from a previous authenticated server would be sent to one that never asked for
  // it — harmless today, but it is a credential travelling somewhere it has no business going.
  expect(apiConfig.setToken).toHaveBeenCalledWith(null);
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
    Linking.parse.mockReturnValue({ queryParams: { code: 'pkce-code' } });
    deepLinkHandler!({ url: 'researchcompanion://auth?code=pkce-code' });

    await waitFor(() =>
      expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('pkce-code'));
  });

  test('a link tapped while the app is closed completes on cold start', async () => {
    Linking.getInitialURL.mockResolvedValue('researchcompanion://auth?code=cold-code');
    Linking.parse.mockReturnValue({ queryParams: { code: 'cold-code' } });

    await renderProvider();
    await waitFor(() => expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('cold-code'));
  });

  test('an expired link surfaces its reason instead of silently doing nothing', async () => {
    // Supabase reports these as query params, not as a thrown error. Without handling them the
    // user taps a dead link, sees no change, and taps it again.
    Linking.parse.mockReturnValue({
      queryParams: { error: 'access_denied', error_description: 'Email link is invalid or has expired' },
    });

    let auth: ReturnType<typeof useAuth> | undefined;
    function Capture() { auth = useAuth(); return <Text>{auth.status}</Text>; }
    const { getByText } = await renderAsync(<AuthProvider><Capture /></AuthProvider>);
    await waitFor(() => getByText('signed-out'));

    deepLinkHandler!({ url: 'researchcompanion://auth?error=access_denied' });
    await waitFor(() => expect(auth!.error).toMatch(/invalid or has expired/));
    expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  test('an unrelated deep link is not treated as an auth callback', async () => {
    Linking.parse.mockReturnValue({ queryParams: {} });
    const { getByText } = await renderProvider();
    await waitFor(() => getByText('signed-out'));

    deepLinkHandler!({ url: 'researchcompanion://paper/attention-is-all-you-need' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockAuth.setSession).not.toHaveBeenCalled();
  });
});
