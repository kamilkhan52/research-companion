// M4 — PurchasesIdentity mirrors auth transitions into the RevenueCat identity, exactly once
// per change (each sync is a network round-trip).

import { render } from '@testing-library/react-native';

const mockSyncIdentity = jest.fn(async (_id: string | null) => {});
jest.mock('@/purchases/purchases', () => ({
  syncIdentity: (id: string | null) => mockSyncIdentity(id),
}));

let mockUserId: string | null = null;
jest.mock('@/auth/AuthProvider', () => ({
  useAuth: () => ({ userId: mockUserId }),
}));

import { PurchasesIdentity } from '@/purchases/PurchasesIdentity';

test('sign-in, switch, and sign-out each sync exactly once', () => {
  mockUserId = null;
  const screen = render(<PurchasesIdentity />);
  expect(mockSyncIdentity).toHaveBeenCalledTimes(1);
  expect(mockSyncIdentity).toHaveBeenLastCalledWith(null);

  mockUserId = 'uuid-a';
  screen.rerender(<PurchasesIdentity />);
  expect(mockSyncIdentity).toHaveBeenCalledTimes(2);
  expect(mockSyncIdentity).toHaveBeenLastCalledWith('uuid-a');

  // A rerender without an auth change must not resync.
  screen.rerender(<PurchasesIdentity />);
  expect(mockSyncIdentity).toHaveBeenCalledTimes(2);

  mockUserId = 'uuid-b'; // direct A → B switch
  screen.rerender(<PurchasesIdentity />);
  expect(mockSyncIdentity).toHaveBeenLastCalledWith('uuid-b');

  mockUserId = null; // sign-out
  screen.rerender(<PurchasesIdentity />);
  expect(mockSyncIdentity).toHaveBeenLastCalledWith(null);
  expect(mockSyncIdentity).toHaveBeenCalledTimes(4);
});
