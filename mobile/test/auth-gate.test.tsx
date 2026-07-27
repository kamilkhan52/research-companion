import { fireEvent, renderAsync, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AuthGate } from '@/components/AuthGate';

const signInWithGoogle = jest.fn(async () => undefined);
const signInWithMagicLink = jest.fn(async () => true);
const retry = jest.fn();
const mockSetBaseUrl = jest.fn(async (_url: string) => undefined);

let mockAuthState = {
  status: 'signed-out',
  mode: 'supabase',
  email: null,
  error: null as string | null,
  signInWithGoogle,
  signInWithMagicLink,
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
    email: null,
    error: null,
    signInWithGoogle,
    signInWithMagicLink,
    signOut: jest.fn(async () => undefined),
    retry,
  };
  signInWithMagicLink.mockResolvedValue(true);
});

async function renderGate() {
  return renderAsync(
    <AuthGate>
      <Text>Private library</Text>
    </AuthGate>,
  );
}

test('signed-out users start at the welcome screen and can choose sign in', async () => {
  const view = await renderGate();

  expect(view.getByText('Understand a field, not just a paper.')).toBeTruthy();
  fireEvent.press(view.getByText('I already have an account'));

  expect(view.getByText('Welcome back')).toBeTruthy();
  expect(view.getByText('Email me a sign-in link')).toBeTruthy();
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
  mockAuthState = { ...mockAuthState, status: 'signed-in' };
  const signedIn = await renderGate();
  expect(signedIn.getByText('Private library')).toBeTruthy();

  mockAuthState = { ...mockAuthState, status: 'disabled' };
  await signedIn.rerenderAsync(
    <AuthGate>
      <Text>Private library</Text>
    </AuthGate>,
  );
  expect(signedIn.getByText('Private library')).toBeTruthy();
});
