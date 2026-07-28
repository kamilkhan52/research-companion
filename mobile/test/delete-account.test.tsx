import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, renderAsync, waitFor } from '@testing-library/react-native';

import DeleteAccountScreen from '@/app/delete-account';
import * as api from '@/api/endpoints';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { createTestQueryClient } from './queryClient';

const mockRefreshSession = jest.fn(async () => undefined);
const mockBack = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
}));
jest.mock('@/auth/AuthProvider', () => ({
  useAuth: () => ({
    email: 'reader@example.com',
    refreshSession: mockRefreshSession,
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(api.startAccountDeletion).mockResolvedValue({
    deletion: {
      status: 'pending',
      error_code: null,
      attempts: 0,
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

test('requires exact confirmation and adopts a fresh session before deletion starts', async () => {
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
  expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  expect(mockRefreshSession.mock.invocationCallOrder[0])
    .toBeLessThan(jest.mocked(api.startAccountDeletion).mock.invocationCallOrder[0]);
});
