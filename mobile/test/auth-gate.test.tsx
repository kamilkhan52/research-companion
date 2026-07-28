import { fireEvent, renderAsync, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { Text } from 'react-native';

import * as api from '@/api/endpoints';
import { AuthGate } from '@/components/AuthGate';
import { createTestQueryClient } from './queryClient';

const signInWithGoogle = jest.fn(async () => undefined);
const signInWithMagicLink = jest.fn(async () => true);
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
  reauthenticateForDeletion: jest.fn(async () => 'authenticated' as const),
  finishAccountDeletion: jest.fn(async () => undefined),
  signOut: jest.fn(async () => undefined),
  retry,
};

jest.mock('@/auth/AuthProvider', () => ({
  useAuth: () => mockAuthState,
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
    reauthenticateForDeletion: jest.fn(async () => 'authenticated' as const),
    finishAccountDeletion: jest.fn(async () => undefined),
    signOut: jest.fn(async () => undefined),
    retry,
  };
  signInWithMagicLink.mockResolvedValue(true);
  jest.mocked(api.getAccountDeletion).mockResolvedValue({ deletion: null });
});

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
  expect(view.getByText('Email me a sign-in link')).toBeTruthy();
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

  jest.mocked(api.getAccountDeletion).mockResolvedValue({
    deletion: {
      status: 'draining',
      error_code: null,
      attempts: 1,
      requested_at: '2026-07-28T00:00:00Z',
      updated_at: '2026-07-28T00:00:01Z',
      completed_at: null,
    },
  });
  mockAuthState = { ...mockAuthState, status: 'signed-in', userId: 'user-b' };
  await view.rerenderAsync(
    <QueryClientProvider client={client}>
      <AuthGate><Text>Private library</Text></AuthGate>
    </QueryClientProvider>,
  );

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
  expect(view.getByText('Email me a sign-in link')).toBeTruthy();
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
  fireEvent.press(view.getByText('Email me a sign-in link'));

  await waitFor(() => expect(signInWithMagicLink).toHaveBeenCalledWith('reader@example.com'));
  await waitFor(() => expect(view.getByText('Check your inbox')).toBeTruthy());
  expect(view.getByText('reader@example.com')).toBeTruthy();
});

test('a rejected email request remains on the entry screen', async () => {
  signInWithMagicLink.mockResolvedValue(false);
  const view = await renderGate();
  fireEvent.press(view.getByText('Get started'));
  fireEvent.changeText(view.getByPlaceholderText('name@example.com'), 'reader@example.com');
  fireEvent.press(view.getByText('Create account'));

  await waitFor(() => expect(signInWithMagicLink).toHaveBeenCalled());
  expect(view.getByText('Create your account')).toBeTruthy();
  expect(view.queryByText('Check your inbox')).toBeNull();
});

test('the inbox state supports resending and correcting the address', async () => {
  const view = await renderGate();
  fireEvent.press(view.getByText('I already have an account'));
  fireEvent.changeText(view.getByPlaceholderText('name@example.com'), 'reader@example.com');
  fireEvent.press(view.getByText('Email me a sign-in link'));
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
