import { act, fireEvent, renderAsync, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { Text } from 'react-native';

import { ApiError } from '@/api/client';
import * as api from '@/api/endpoints';
import { AuthGate } from '@/components/AuthGate';
import { createTestQueryClient } from './queryClient';

const signInWithGoogle = jest.fn(async () => undefined);
const signInWithMagicLink = jest.fn(async () => true);
const signInWithPassword = jest.fn(async () => true);
const signUpWithPassword =
  jest.fn<Promise<'signed-in' | 'confirm-email' | 'failed'>, [string, string]>(
    async () => 'signed-in');
const sendPasswordReset = jest.fn(async () => true);
const retry = jest.fn();
const mockSetBaseUrl = jest.fn(async (_url: string) => undefined);

let mockAuthState = {
  status: 'signed-out',
  mode: 'supabase',
  userId: null as string | null,
  email: null,
  error: null as string | null,
  signInWithGoogle,
  signInWithMagicLink,
  signInWithPassword,
  signUpWithPassword,
  sendPasswordReset,
  reauthenticateForDeletion: jest.fn(async () => 'authenticated' as const),
  finishAccountDeletion: jest.fn(async () => undefined),
  signOut: jest.fn(async () => undefined),
  accountDeleted: false,
  dismissAccountDeleted: jest.fn(),
  retry,
};

// This module is mocked wholesale, so anything AuthGate imports from it must be re-supplied here.
// MIN_PASSWORD_LENGTH is one: without it both the component and this file would read `undefined`
// and the placeholder assertions below would match each other vacuously. The REAL value, and the
// enforcement that depends on it, are pinned in auth-provider.test.tsx against the real module.
const MIN_PASSWORD_LENGTH = 8;

jest.mock('@/auth/AuthProvider', () => ({
  useAuth: () => mockAuthState,
  MIN_PASSWORD_LENGTH,
}));

jest.mock('@/api/config', () => ({
  getBaseUrl: () => 'https://staging.example.com',
  setBaseUrl: (url: string) => mockSetBaseUrl(url),
}));

jest.mock('expo-linking', () => ({
  openURL: jest.fn(async () => true),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthState = {
    status: 'signed-out',
    mode: 'supabase',
    userId: null,
    email: null,
    error: null,
    signInWithGoogle,
    signInWithMagicLink,
    signInWithPassword,
    signUpWithPassword,
    sendPasswordReset,
    reauthenticateForDeletion: jest.fn(async () => 'authenticated' as const),
    finishAccountDeletion: jest.fn(async () => undefined),
    signOut: jest.fn(async () => undefined),
    accountDeleted: false,
    dismissAccountDeleted: jest.fn(),
    retry,
  };
  signInWithMagicLink.mockResolvedValue(true);
  signInWithPassword.mockResolvedValue(true);
  signUpWithPassword.mockResolvedValue('signed-in');
  sendPasswordReset.mockResolvedValue(true);
  jest.mocked(api.getAccountDeletion).mockResolvedValue({ deletion: null });
});

/** A REAL flush. Awaiting a promise only drains microtasks; React's re-render lands after them,
 *  so an assertion made without this observes the tree as it was BEFORE the state change and
 *  passes whether or not the bug is present. Both tests below were vacuous until this existed. */
async function flushRender() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function renderGate(client = createTestQueryClient()) {
  return renderAsync(
    <QueryClientProvider client={client}>
      <AuthGate>
        <Text>Private library</Text>
      </AuthGate>
    </QueryClientProvider>,
  );
}

test('signed-out users start at the welcome screen and can choose sign in', async () => {
  const view = await renderGate();

  expect(view.getByText('Understand a field, not just a paper.')).toBeTruthy();
  fireEvent.press(view.getByText('I already have an account'));

  expect(view.getByText('Welcome back')).toBeTruthy();
  expect(view.getByText('Email me a sign-in link instead')).toBeTruthy();
});

test('a completed deletion is acknowledged before the sign-in form comes back', async () => {
  // Without this the completion copy flashes past and the user lands on the welcome screen with
  // no confirmation that an irreversible action worked — next to a "Get started" button that,
  // with self-service sign-up, silently makes a fresh empty account under the same address.
  const dismiss = jest.fn();
  mockAuthState = {
    ...mockAuthState, status: 'signed-out', userId: null,
    accountDeleted: true, dismissAccountDeleted: dismiss,
  };
  const view = await renderGate();

  expect(view.getByText('Your account was deleted')).toBeTruthy();
  expect(view.queryByText('Understand a field,\nnot just a paper.')).toBeNull();

  fireEvent.press(view.getByText('Done'));
  expect(dismiss).toHaveBeenCalled();
});

test('an incomplete local purge is reported ahead of the deletion acknowledgement', async () => {
  // Both are true at once when cleanup fails. The one that still needs the user to DO something
  // has to win, or the acknowledgement dismisses them past it.
  mockAuthState = {
    ...mockAuthState, status: 'cleanup-required', accountDeleted: true,
    error: 'Some account-linked data could not be cleared from this device.',
  };
  const view = await renderGate();

  expect(view.getByText('Local data needs attention')).toBeTruthy();
  expect(view.queryByText('Your account was deleted')).toBeNull();
});

test('a background deletion poll does not tear the app down', async () => {
  // The guard re-polls every 30s for the whole life of a signed-in session, forever, whether or
  // not any deletion exists. If it renders the spinner during those polls it is not showing a
  // loading state — it is UNMOUNTING everything under `AuthGate`, which is the router stack and
  // every provider: navigation resets to the root route, drafts and open sheets are destroyed,
  // and playback is paused by AudioProvider's mount effect. Every 30 seconds.
  const client = createTestQueryClient();
  mockAuthState = { ...mockAuthState, status: 'signed-in', userId: 'user-a' };
  const view = await renderGate(client);
  await waitFor(() => expect(view.getByText('Private library')).toBeTruthy());

  // A refetch that is deliberately still in flight, which is the state the bug rendered wrongly.
  let releasePoll: () => void = () => {};
  jest.mocked(api.getAccountDeletion).mockImplementation(
    () => new Promise((resolve) => { releasePoll = () => resolve({ deletion: null }); }),
  );
  void client.refetchQueries({ queryKey: ['account-deletion', 'user-a'] });
  await flushRender();
  expect(jest.mocked(api.getAccountDeletion)).toHaveBeenCalled();   // the poll really is in flight

  expect(view.getByText('Private library')).toBeTruthy();

  releasePoll();
  await waitFor(() => expect(view.getByText('Private library')).toBeTruthy());
  await view.unmountAsync();
});

test('a deletion that cannot finish stops claiming it is in progress', async () => {
  // The resume monitor keeps restarting a stalled deletion, so it spends most of its life in a
  // RUNNING phase. Keyed off `status` alone the user saw a spinner and "deletion continues safely
  // on the server" indefinitely, while their data sat there — the one thing this screen must not
  // get wrong. `stalled` is reported alongside the phase precisely so the UI can outrank it.
  mockAuthState = { ...mockAuthState, status: 'signed-in', userId: 'user-d' };
  jest.mocked(api.getAccountDeletion).mockResolvedValue({
    deletion: {
      status: 'draining',          // mid-retry: the misleading case
      error_code: 'draining:RuntimeError',
      attempts: 6,
      stalled: true,
      requested_at: '2026-07-28T00:00:00Z',
      updated_at: '2026-07-28T00:05:00Z',
      completed_at: null,
    },
  });

  const view = await renderGate();
  await waitFor(() => expect(view.getByText('Account deletion needs attention')).toBeTruthy());
  expect(view.queryByText('Deleting your account')).toBeNull();
  expect(view.queryByText(/continues safely on the server/)).toBeNull();
  // The recovery affordance must still be there — it is safe and resumes from the durable step.
  expect(view.getByText('Retry deletion')).toBeTruthy();
  await view.unmountAsync();
});

test('a forbidden account is told so, and offered the one action that helps', async () => {
  // Found on a device pass: a second Supabase account signed in fine but was not in
  // `RC_ALLOWED_USERS`, so every /api call 403'd. The guard has no cached answer for a new user,
  // so it fell into the offline card — "Try again" against a server that will never say yes, with
  // no route back to Settings or to another account. This recurs for each of M2.5's twelve
  // testers, since every one has to be allowlisted by hand.
  const signOut = jest.fn(async () => undefined);
  mockAuthState = { ...mockAuthState, status: 'signed-in', userId: 'user-c', signOut };
  jest.mocked(api.getAccountDeletion).mockRejectedValue(new ApiError(403, 'Not permitted.'));

  const view = await renderGate();
  await waitFor(() => expect(view.getByText('This account doesn’t have access')).toBeTruthy());
  // The misleading card must NOT be what a 403 produces.
  expect(view.queryByText('Couldn’t check your account')).toBeNull();
  expect(view.queryByText('Try again')).toBeNull();

  fireEvent.press(view.getByText('Sign out'));
  expect(signOut).toHaveBeenCalled();
  await view.unmountAsync();
});

test('a failed deletion poll does not tear the app down when an answer is already held', async () => {
  // Refusing to mount until the server confirms no deletion is running is a deliberate
  // fail-closed choice ON FIRST LOAD. Applying it to a later poll is a different thing: the guard
  // is holding a successful answer from seconds ago, and the backend 423s every other route the
  // moment a tombstone exists — so one dropped packet should not end the session.
  const client = createTestQueryClient();
  mockAuthState = { ...mockAuthState, status: 'signed-in', userId: 'user-a' };
  const view = await renderGate(client);
  await waitFor(() => expect(view.getByText('Private library')).toBeTruthy());

  jest.mocked(api.getAccountDeletion).mockRejectedValue(new Error('offline'));
  await client.refetchQueries({ queryKey: ['account-deletion', 'user-a'] });
  await flushRender();
  // Vacuity guard: if the query never actually reached its error state, the assertion below
  // would hold for a reason that has nothing to do with the fix.
  expect(client.getQueryState(['account-deletion', 'user-a'])?.status).toBe('error');

  expect(view.queryByText('Couldn’t check your account')).toBeNull();
  expect(view.getByText('Private library')).toBeTruthy();
  await view.unmountAsync();
});

test('deletion status is fetched fresh and isolated across account changes', async () => {
  const client = createTestQueryClient();
  mockAuthState = { ...mockAuthState, status: 'signed-in', userId: 'user-a' };
  const view = await renderGate(client);
  await waitFor(() => expect(view.getByText('Private library')).toBeTruthy());

  mockAuthState = { ...mockAuthState, status: 'signed-out', userId: null };
  await view.rerenderAsync(
    <QueryClientProvider client={client}>
      <AuthGate><Text>Private library</Text></AuthGate>
    </QueryClientProvider>,
  );

  // Held open, so the assertion below observes user B BEFORE their own answer arrives. Without
  // this the two cases converge and the test cannot tell them apart — which is what was wrong
  // with it: every assertion it made was satisfied by a shared cache key too.
  let releaseB: () => void = () => {};
  jest.mocked(api.getAccountDeletion).mockImplementation(
    () => new Promise((resolve) => {
      releaseB = () => resolve({
        deletion: {
          status: 'draining',
          error_code: null,
          attempts: 1,
          stalled: false,
          requested_at: '2026-07-28T00:00:00Z',
          updated_at: '2026-07-28T00:00:01Z',
          completed_at: null,
        },
      });
    }),
  );
  mockAuthState = { ...mockAuthState, status: 'signed-in', userId: 'user-b' };
  await view.rerenderAsync(
    <QueryClientProvider client={client}>
      <AuthGate><Text>Private library</Text></AuthGate>
    </QueryClientProvider>,
  );

  // THE discriminator. User A's entry says `{deletion: null}`. On a shared, non-user-scoped key
  // user B reads that entry, the guard falls straight through to `if (!deletion) return children`,
  // and B mounts the app on A's answer. A user-scoped key has no entry for B at all, so the guard
  // must still be pending here. Per AGENTS.md the composite (user, scope) key is the highest-risk
  // thing in this repo, and this is the only test defending this one.
  expect(view.queryByText('Private library')).toBeNull();

  releaseB();
  await waitFor(() => expect(view.getByText('Deleting your account')).toBeTruthy());
  expect(view.queryByText('Private library')).toBeNull();
  expect(api.getAccountDeletion).toHaveBeenCalledTimes(2);
  await view.unmountAsync();
});

test('email entry uses Google branding without the crossed-out supporting items', async () => {
  const view = await renderGate();
  fireEvent.press(view.getByText('Get started'));

  expect(view.getByLabelText('Continue with Google')).toBeTruthy();
  expect(view.getByTestId('google-sign-in-logo')).toBeTruthy();
  expect(view.queryByText('One tap from your inbox')).toBeNull();
  expect(view.queryByText('Using a self-hosted server? Change server')).toBeNull();
});

test('signed-out users can recover from a reachable wrong server without the removed text link', async () => {
  const view = await renderGate();

  fireEvent.press(view.getByLabelText('Server settings'));

  expect(view.getByText('Can’t reach the server')).toBeTruthy();
  expect(view.getByDisplayValue('https://staging.example.com')).toBeTruthy();
});

test('a cold-start callback error is visible on welcome with a recovery path', async () => {
  mockAuthState = {
    ...mockAuthState,
    error: 'Email link is invalid or has expired.',
  };
  const view = await renderGate();

  expect(view.getByText('That sign-in link couldn’t be used')).toBeTruthy();
  expect(view.getByText('Email link is invalid or has expired. Request a new link below.'))
    .toBeTruthy();

  fireEvent.press(view.getByText('I already have an account'));
  expect(view.getByText('Email me a sign-in link instead')).toBeTruthy();
});

test('a failed deleted-account cleanup is not mislabeled as a sign-in-link error', async () => {
  mockAuthState = {
    ...mockAuthState,
    error: 'Some deleted-account data remains. Clear the app’s data before sharing this device.',
  };
  const view = await renderGate();

  expect(view.getByText('Local data needs attention')).toBeTruthy();
  expect(view.queryByText('That sign-in link couldn’t be used')).toBeNull();
});

test('failed deletion cleanup blocks even an auth-disabled app', async () => {
  mockAuthState = {
    ...mockAuthState,
    status: 'cleanup-required',
    mode: 'open',
    error: 'Some deleted-account data remains.',
  };
  const view = await renderGate();

  expect(view.getByText('Local data needs attention')).toBeTruthy();
  expect(view.queryByText('Private library')).toBeNull();
  fireEvent.press(view.getByText('Try cleanup again'));
  expect(retry).toHaveBeenCalledTimes(1);
});

test('an accepted email request advances to the check-inbox state', async () => {
  const view = await renderGate();
  fireEvent.press(view.getByText('I already have an account'));
  fireEvent.changeText(view.getByPlaceholderText('name@example.com'), ' reader@example.com ');
  fireEvent.press(view.getByText('Email me a sign-in link instead'));

  await waitFor(() => expect(signInWithMagicLink).toHaveBeenCalledWith('reader@example.com'));
  await waitFor(() => expect(view.getByText('Check your inbox')).toBeTruthy());
  expect(view.getByText('reader@example.com')).toBeTruthy();
});

test('a rejected email request remains on the entry screen', async () => {
  signInWithMagicLink.mockResolvedValue(false);
  const view = await renderGate();
  fireEvent.press(view.getByText('I already have an account'));
  fireEvent.changeText(view.getByPlaceholderText('name@example.com'), 'reader@example.com');
  fireEvent.press(view.getByText('Email me a sign-in link instead'));

  await waitFor(() => expect(signInWithMagicLink).toHaveBeenCalled());
  expect(view.getByText('Welcome back')).toBeTruthy();
  expect(view.queryByText('Check your inbox')).toBeNull();
});

test('signing in with a password does not go near the inbox', async () => {
  const view = await renderGate();
  fireEvent.press(view.getByText('I already have an account'));
  fireEvent.changeText(view.getByPlaceholderText('name@example.com'), ' reader@example.com ');
  fireEvent.changeText(view.getByPlaceholderText('Your password'), 'correct horse battery');
  fireEvent.press(view.getByText('Sign in'));

  await waitFor(() =>
    expect(signInWithPassword).toHaveBeenCalledWith('reader@example.com', 'correct horse battery'));
  expect(signInWithMagicLink).not.toHaveBeenCalled();
  expect(view.queryByText('Check your inbox')).toBeNull();
});

test('sign-in is refused until BOTH fields are filled', async () => {
  // The whole point of adding passwords is that a tester can get in without an email round trip.
  // A form that silently no-ops on submit would send them back to the inbox path it exists to
  // avoid — and pressing a disabled button looks identical to a request that failed.
  const view = await renderGate();
  fireEvent.press(view.getByText('I already have an account'));

  fireEvent.changeText(view.getByPlaceholderText('name@example.com'), 'reader@example.com');
  fireEvent.press(view.getByText('Sign in'));
  await flushRender();
  expect(signInWithPassword).not.toHaveBeenCalled();

  fireEvent.changeText(view.getByPlaceholderText('Your password'), 'a password');
  fireEvent.press(view.getByText('Sign in'));
  await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
});

test('a new account that needs confirmation is sent to the inbox, not left at the form', async () => {
  // Supabase returns no session when email confirmation is on, and the account is inert until the
  // address is confirmed. Treating that as a plain failure would leave the user retyping a password
  // that cannot work yet.
  signUpWithPassword.mockResolvedValue('confirm-email');
  const view = await renderGate();
  fireEvent.press(view.getByText('Get started'));
  fireEvent.changeText(view.getByPlaceholderText('name@example.com'), 'reader@example.com');
  fireEvent.changeText(
    view.getByPlaceholderText(`At least ${MIN_PASSWORD_LENGTH} characters`), 'a good password');
  fireEvent.press(view.getByText('Create account'));

  await waitFor(() => expect(view.getByText('Check your inbox')).toBeTruthy());
});

test('a new account that is immediately usable does NOT show the inbox screen', async () => {
  signUpWithPassword.mockResolvedValue('signed-in');
  const view = await renderGate();
  fireEvent.press(view.getByText('Get started'));
  fireEvent.changeText(view.getByPlaceholderText('name@example.com'), 'reader@example.com');
  fireEvent.changeText(
    view.getByPlaceholderText(`At least ${MIN_PASSWORD_LENGTH} characters`), 'a good password');
  fireEvent.press(view.getByText('Create account'));

  await waitFor(() => expect(signUpWithPassword).toHaveBeenCalled());
  await flushRender();
  expect(view.queryByText('Check your inbox')).toBeNull();
});

test('a password reset never reveals whether the address has an account', async () => {
  const view = await renderGate();
  fireEvent.press(view.getByText('I already have an account'));
  fireEvent.changeText(view.getByPlaceholderText('name@example.com'), 'stranger@example.com');
  fireEvent.press(view.getByText('Forgot your password?'));

  await waitFor(() => expect(sendPasswordReset).toHaveBeenCalledWith('stranger@example.com'));
  // The CONDITIONAL wording is the assertion: anything that confirmed the address exists would be
  // an enumeration oracle, letting anyone test which emails are registered.
  await view.findByText('If stranger@example.com has an account, a reset link is on its way.');
});

test('the inbox state supports resending and correcting the address', async () => {
  const view = await renderGate();
  fireEvent.press(view.getByText('I already have an account'));
  fireEvent.changeText(view.getByPlaceholderText('name@example.com'), 'reader@example.com');
  fireEvent.press(view.getByText('Email me a sign-in link instead'));
  await waitFor(() => expect(view.getByText('Check your inbox')).toBeTruthy());

  fireEvent.press(view.getByText('Resend email'));
  await waitFor(() => expect(signInWithMagicLink).toHaveBeenCalledTimes(2));

  fireEvent.press(view.getByText('Use a different email'));
  expect(view.getByText('Welcome back')).toBeTruthy();
});

test('an unreachable server exposes recovery without suggesting sign-in', async () => {
  mockAuthState = { ...mockAuthState, status: 'unreachable' };
  const view = await renderGate();

  expect(view.getByText('Can’t reach the server')).toBeTruthy();
  expect(view.getByDisplayValue('https://staging.example.com')).toBeTruthy();
  expect(view.queryByText('Continue with Google')).toBeNull();
});

test('signed-in and auth-disabled states pass through to the app', async () => {
  mockAuthState = { ...mockAuthState, status: 'signed-in', userId: 'user-a' };
  const signedIn = await renderGate();
  await waitFor(() => expect(signedIn.getByText('Private library')).toBeTruthy());
  expect(api.getAccountDeletion).toHaveBeenCalledTimes(1);

  mockAuthState = { ...mockAuthState, status: 'disabled' };
  await signedIn.rerenderAsync(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthGate>
        <Text>Private library</Text>
      </AuthGate>
    </QueryClientProvider>,
  );
  expect(signedIn.getByText('Private library')).toBeTruthy();
});

test('a durable deletion resumes before ordinary app consumers mount', async () => {
  mockAuthState = { ...mockAuthState, status: 'signed-in', userId: 'user-a' };
  jest.mocked(api.getAccountDeletion).mockResolvedValue({
    deletion: {
      status: 'draining',
      error_code: null,
      attempts: 1,
      stalled: false,
      requested_at: '2026-07-28T00:00:00Z',
      updated_at: '2026-07-28T00:00:01Z',
      completed_at: null,
    },
  });

  const view = await renderGate();
  await waitFor(() => expect(view.getByText('Deleting your account')).toBeTruthy());
  expect(view.queryByText('Private library')).toBeNull();
  await view.unmountAsync();
});

test('a paused deletion retries without requiring a now-impossible Auth refresh', async () => {
  mockAuthState = { ...mockAuthState, status: 'signed-in', userId: 'user-a' };
  const failed = {
    status: 'error' as const,
    error_code: 'deleting_identity:upstream',
    attempts: 1,
    stalled: false,
    requested_at: '2026-07-28T00:00:00Z',
    updated_at: '2026-07-28T00:00:01Z',
    completed_at: null,
  };
  jest.mocked(api.getAccountDeletion).mockResolvedValue({ deletion: failed });
  jest.mocked(api.startAccountDeletion).mockResolvedValue({
    // The coordinator returns the row read before its worker flips status, so a successfully
    // accepted retry can still echo the prior error.
    deletion: failed,
  });

  const view = await renderGate();
  await waitFor(() => expect(view.getByText('Retry deletion')).toBeTruthy());
  fireEvent.press(view.getByText('Retry deletion'));

  expect(mockAuthState.reauthenticateForDeletion).not.toHaveBeenCalled();
  expect(api.startAccountDeletion).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(view.getByText('Deleting your account')).toBeTruthy());
  await view.unmountAsync();
});
