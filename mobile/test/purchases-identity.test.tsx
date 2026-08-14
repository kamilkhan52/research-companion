// M4 — PurchasesIdentity mirrors RESOLVED auth transitions into the RevenueCat identity,
// exactly once per change. Gated on auth status, not just userId (PR #405 review): userId is
// also null while auth is merely unresolved — 'unknown' during every cold-start session
// restore, 'unreachable' offline — and syncing "signed out" then would log out a valid
// persisted subscriber identity (permanently, on an offline launch).

import { render } from '@testing-library/react-native';

const mockSyncIdentity = jest.fn(async (_id: string | null) => {});
jest.mock('@/purchases/purchases', () => ({
  syncIdentity: (id: string | null) => mockSyncIdentity(id),
}));

let mockStatus = 'unknown';
let mockUserId: string | null = null;
jest.mock('@/auth/AuthProvider', () => ({
  useAuth: () => ({ status: mockStatus, userId: mockUserId }),
}));

import { PurchasesIdentity } from '@/purchases/PurchasesIdentity';

test('unresolved auth never touches the identity; resolved transitions sync once each', () => {
  // Cold start: session restore in progress. userId is null but nothing may sync.
  mockStatus = 'unknown';
  mockUserId = null;
  const screen = render(<PurchasesIdentity />);
  expect(mockSyncIdentity).not.toHaveBeenCalled();

  // Offline launch: unreachable is unresolved too, not "signed out".
  mockStatus = 'unreachable';
  screen.rerender(<PurchasesIdentity />);
  expect(mockSyncIdentity).not.toHaveBeenCalled();

  // Restore completes signed-in.
  mockStatus = 'signed-in';
  mockUserId = 'uuid-a';
  screen.rerender(<PurchasesIdentity />);
  expect(mockSyncIdentity).toHaveBeenCalledTimes(1);
  expect(mockSyncIdentity).toHaveBeenLastCalledWith('uuid-a');

  // A rerender without an auth change must not resync.
  screen.rerender(<PurchasesIdentity />);
  expect(mockSyncIdentity).toHaveBeenCalledTimes(1);

  // Direct A → B switch.
  mockUserId = 'uuid-b';
  screen.rerender(<PurchasesIdentity />);
  expect(mockSyncIdentity).toHaveBeenLastCalledWith('uuid-b');

  // Explicit sign-out is the one null that DOES sync.
  mockStatus = 'signed-out';
  mockUserId = null;
  screen.rerender(<PurchasesIdentity />);
  expect(mockSyncIdentity).toHaveBeenLastCalledWith(null);
  expect(mockSyncIdentity).toHaveBeenCalledTimes(3);
});
