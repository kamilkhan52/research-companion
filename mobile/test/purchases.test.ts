// M4 — the RevenueCat wrapper's contracts (roadmap "Tests" list): identity stability across
// login/logout/switch, offering fetch failure degrading gracefully, and the
// native-module-absent build (the installed dev client predates the dependency) never
// throwing. The SDK itself is mocked; these pin OUR module's behavior around it.

import { NativeModules } from 'react-native';

// Self-contained factory: jest.mock is hoisted above any const in this file, and the module
// under test captures `.default` at import time — an out-of-band mock object would still be
// undefined at that moment.
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    getAppUserID: jest.fn(async () => '$RCAnonymousID:abc'),
    isAnonymous: jest.fn(async () => true),
    logIn: jest.fn(async () => ({})),
    logOut: jest.fn(async () => ({})),
    getOfferings: jest.fn(async () => ({ current: null })),
    purchasePackage: jest.fn(),
    restorePurchases: jest.fn(),
    getCustomerInfo: jest.fn(),
  },
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockSdk = (require('react-native-purchases') as { default: Record<string, jest.Mock> }).default;
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { revenuecatAndroidApiKey: 'test_key' } } },
}));

// The module guards on the INSTALLED BINARY, not the JS package (the view-shot lesson,
// DR-062) — simulate a build that has the native module.
(NativeModules as Record<string, unknown>).RNPurchases = {};

import * as purchases from '@/purchases/purchases';

beforeEach(() => {
  jest.clearAllMocks();
  purchases.resetForTests();
  (NativeModules as Record<string, unknown>).RNPurchases = {};
});

test('configures once, anonymously, across repeated entry points', async () => {
  await purchases.currentOffering();
  await purchases.syncIdentity(null);
  expect(mockSdk.configure).toHaveBeenCalledTimes(1);
  expect(mockSdk.configure).toHaveBeenCalledWith({ apiKey: 'test_key' });
});

test('identity: sign-in logs in with the Supabase UUID; a repeat is a no-op', async () => {
  mockSdk.getAppUserID.mockResolvedValueOnce('$RCAnonymousID:abc');
  await purchases.syncIdentity('uuid-1');
  expect(mockSdk.logIn).toHaveBeenCalledWith('uuid-1');

  mockSdk.getAppUserID.mockResolvedValueOnce('uuid-1');
  await purchases.syncIdentity('uuid-1');
  expect(mockSdk.logIn).toHaveBeenCalledTimes(1); // unchanged identity: no extra round-trip
});

test('identity: an account switch logs in as the new UUID', async () => {
  mockSdk.getAppUserID.mockResolvedValueOnce('uuid-1');
  await purchases.syncIdentity('uuid-2');
  expect(mockSdk.logIn).toHaveBeenCalledWith('uuid-2');
});

test('identity: sign-out logs out a named user but never an anonymous one', async () => {
  mockSdk.getAppUserID.mockResolvedValueOnce('uuid-1');
  mockSdk.isAnonymous.mockResolvedValueOnce(false);
  await purchases.syncIdentity(null);
  expect(mockSdk.logOut).toHaveBeenCalledTimes(1);

  mockSdk.getAppUserID.mockResolvedValueOnce('$RCAnonymousID:abc');
  mockSdk.isAnonymous.mockResolvedValueOnce(true);
  await purchases.syncIdentity(null);
  expect(mockSdk.logOut).toHaveBeenCalledTimes(1); // logOut on anonymous would throw SDK-side
});

test('offering fetch failure degrades to null, never throws', async () => {
  mockSdk.getOfferings.mockRejectedValueOnce(new Error('network'));
  await expect(purchases.currentOffering()).resolves.toBeNull();
});

test('purchase maps user cancellation and errors to typed results', async () => {
  mockSdk.purchasePackage.mockRejectedValueOnce({ userCancelled: true });
  const cancelled = await purchases.purchase({} as never);
  expect(cancelled.status).toBe('cancelled');

  mockSdk.purchasePackage.mockRejectedValueOnce(new Error('declined'));
  const failed = await purchases.purchase({} as never);
  expect(failed).toEqual({ status: 'error', message: 'declined' });
});

test('restore reports whether the pro entitlement came back', async () => {
  mockSdk.restorePurchases.mockResolvedValueOnce({ entitlements: { active: { pro: {} } } });
  await expect(purchases.restore()).resolves.toEqual({ status: 'restored', active: true });
  mockSdk.restorePurchases.mockResolvedValueOnce({ entitlements: { active: {} } });
  await expect(purchases.restore()).resolves.toEqual({ status: 'restored', active: false });
});

test('overlapping identity syncs serialize — the later call decides the final identity', async () => {
  // Without serialization, both calls read the pre-transition identity and the LOSER of the
  // race wins (e.g. a slow logOut landing after the logIn that followed it, leaving a
  // signed-in app anonymous). Order of SDK effects is the property under test.
  const effects: string[] = [];
  mockSdk.getAppUserID.mockResolvedValue('uuid-a');
  mockSdk.isAnonymous.mockResolvedValue(false);
  mockSdk.logOut.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 20)); // the slow transition
    effects.push('logOut');
    return {};
  });
  mockSdk.logIn.mockImplementation(async () => {
    effects.push('logIn');
    return {};
  });

  const signOut = purchases.syncIdentity(null);      // slow
  const signIn = purchases.syncIdentity('uuid-b');   // fast, must WAIT
  await Promise.all([signOut, signIn]);

  expect(effects).toEqual(['logOut', 'logIn']);
  mockSdk.getAppUserID.mockResolvedValue('$RCAnonymousID:abc');
  mockSdk.isAnonymous.mockResolvedValue(true);
  mockSdk.logOut.mockReset();
  mockSdk.logIn.mockReset();
});

test('a build without the native module degrades everywhere and never configures', async () => {
  delete (NativeModules as Record<string, unknown>).RNPurchases;
  expect(purchases.billingAvailable()).toBe(false);
  await expect(purchases.currentOffering()).resolves.toBeNull();
  await expect(purchases.purchase({} as never)).resolves.toEqual({ status: 'unavailable' });
  await expect(purchases.restore()).resolves.toEqual({ status: 'unavailable' });
  await expect(purchases.proActive()).resolves.toBeNull();
  await purchases.syncIdentity('uuid-1');
  expect(mockSdk.configure).not.toHaveBeenCalled();
  expect(mockSdk.logIn).not.toHaveBeenCalled();
});
