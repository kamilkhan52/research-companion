import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, renderAsync, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import DeleteAccountScreen from '@/app/delete-account';
import { ApiError } from '@/api/client';
import * as api from '@/api/endpoints';
import { hasAccountDeletionIntent } from '@/auth/accountCleanup';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { createTestQueryClient } from './queryClient';

const mockReauthenticate = jest.fn(async () =>
  'authenticated' as 'authenticated' | 'email-sent' | 'cancelled');
const mockBack = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
}));
jest.mock('@/auth/AuthProvider', () => ({
  useAuth: () => ({
    userId: 'user-a',
    email: 'reader@example.com',
    reauthenticateForDeletion: mockReauthenticate,
  }),
}));

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  jest.mocked(api.startAccountDeletion).mockResolvedValue({
    deletion: {
      status: 'pending',
      error_code: null,
      attempts: 0,
      stalled: false,
      requested_at: '2026-07-28T00:00:00Z',
      updated_at: '2026-07-28T00:00:00Z',
      completed_at: null,
    },
  });
});

async function renderScreen() {
  return renderAsync(
    <QueryClientProvider client={createTestQueryClient()}>
      <ThemeProvider>
        <DeleteAccountScreen />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

test('requires exact confirmation and recent user presence before deletion starts', async () => {
  const view = await renderScreen();
  const input = view.getByLabelText('Type DELETE to confirm account deletion');
  const button = view.getByText('Permanently delete account');

  fireEvent.press(button);
  expect(api.startAccountDeletion).not.toHaveBeenCalled();
  fireEvent.changeText(input, 'delete');
  fireEvent.press(button);
  expect(api.startAccountDeletion).not.toHaveBeenCalled();

  fireEvent.changeText(input, 'DELETE');
  fireEvent.press(button);

  await waitFor(() => expect(api.startAccountDeletion).toHaveBeenCalledTimes(1));
  expect(mockReauthenticate).toHaveBeenCalledTimes(1);
  expect(AsyncStorage.setItem).toHaveBeenCalledWith('rc.accountDeletionIntent.v1', '1');
  expect(mockReauthenticate.mock.invocationCallOrder[0])
    .toBeLessThan(jest.mocked(api.startAccountDeletion).mock.invocationCallOrder[0]);
  expect(jest.mocked(AsyncStorage.setItem).mock.invocationCallOrder[0])
    .toBeLessThan(jest.mocked(api.startAccountDeletion).mock.invocationCallOrder[0]);
});

test('an email reauthentication pauses before creating a deletion intent', async () => {
  mockReauthenticate.mockResolvedValueOnce('email-sent');
  const view = await renderScreen();
  fireEvent.changeText(
    view.getByLabelText('Type DELETE to confirm account deletion'),
    'DELETE',
  );
  fireEvent.press(view.getByText('Permanently delete account'));

  await waitFor(() => expect(view.getByText(/Check your email/)).toBeTruthy());
  expect(api.startAccountDeletion).not.toHaveBeenCalled();
  expect(await hasAccountDeletionIntent()).toBe(false);
});

test('an explicit server rejection removes the pre-request recovery marker', async () => {
  jest.mocked(api.startAccountDeletion).mockRejectedValue(
    new ApiError(503, 'Account deletion is not configured on this server yet.'),
  );
  const view = await renderScreen();
  fireEvent.changeText(
    view.getByLabelText('Type DELETE to confirm account deletion'),
    'DELETE',
  );
  fireEvent.press(view.getByText('Permanently delete account'));

  await waitFor(() => expect(view.getByText(
    'Account deletion is not configured on this server yet.',
  )).toBeTruthy());
  expect(await hasAccountDeletionIntent()).toBe(false);
});

test('an ambiguous gateway failure preserves the recovery marker', async () => {
  jest.mocked(api.startAccountDeletion).mockRejectedValue(
    new ApiError(504, 'The upstream request timed out.'),
  );
  jest.mocked(api.getAccountDeletion).mockRejectedValue(
    new ApiError(503, 'Account deletion status is temporarily unavailable.'),
  );
  const view = await renderScreen();
  fireEvent.changeText(
    view.getByLabelText('Type DELETE to confirm account deletion'),
    'DELETE',
  );
  fireEvent.press(view.getByText('Permanently delete account'));

  await waitFor(() => expect(view.getByText('The upstream request timed out.')).toBeTruthy());
  expect(await hasAccountDeletionIntent()).toBe(true);
});
