// M4 — RevenueCat foundation. One module owns every touch of react-native-purchases so the
// rest of the app never imports the SDK directly; everything else goes through the small
// surface below.
//
// Three constraints shape this file (docs/production/03-monetization-and-entitlements.md):
//
// 1. **The native module may be absent.** react-native-purchases is a NATIVE module, and the
//    dev client installed on Kamil's phone predates it — the same trap as
//    react-native-view-shot (DR-062): the JS package resolves the moment it's npm-installed,
//    which says nothing about the installed APK. Every entry point here degrades to a typed
//    "unavailable" result instead of throwing, so the app works fully without billing until
//    the next dev-client/EAS build bakes it in.
// 2. **App User ID = the Supabase auth UUID, never email** (roadmap M4). Configuration is
//    anonymous at startup; PurchasesIdentity.tsx logs in/out as auth state changes, so a
//    purchase made anonymously before sign-in is aliased onto the account by RevenueCat's
//    own transfer behavior, and an account switch can never leak entitlements across users.
// 3. **The client is never the authority on access** (M5 makes access server-enforced via
//    webhooks). Entitlement state read here is for rendering — unlocking UI optimistically —
//    not for gating anything the server charges for.
//
// The SDK key is the PUBLISHABLE Android key from app.json extra — RevenueCat SDK keys ship
// inside the binary by design. Today it is the onboarding TEST key (H7); the Play-specific
// `goog_…` key replaces it in app.json once the Play app is connected (H8→H9), with no code
// change here.

import Constants from 'expo-constants';
import { NativeModules } from 'react-native';

import type {
  CustomerInfo,
  PurchasesOffering,
  PurchasesPackage,
} from 'react-native-purchases';

/** The single entitlement M4/M5 define (roadmap): active ⇒ the paid tier. */
export const PRO_ENTITLEMENT = 'pro';

type PurchasesModule = typeof import('react-native-purchases').default;

// Guarded exactly like react-native-view-shot in DevTestBubble: the require succeeding only
// proves Metro served the JS; NativeModules.RNPurchases is the truth about the installed
// binary. Checked once at module load.
let Purchases: PurchasesModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Purchases = require('react-native-purchases').default;
} catch {
  Purchases = null;
}

const apiKey = (
  (Constants.expoConfig?.extra?.revenuecatAndroidApiKey as string | undefined) ?? ''
).trim();

export const billingAvailable = (): boolean =>
  Purchases !== null && NativeModules.RNPurchases != null && apiKey.length > 0;

let configured = false;

/** Configure once, anonymously. Safe to call from anywhere; a no-op when billing is
 *  unavailable, so callers never need their own guard. */
export function ensureConfigured(): boolean {
  if (!billingAvailable()) return false;
  if (!configured) {
    Purchases!.configure({ apiKey });
    configured = true;
  }
  return true;
}

/** Exposed for tests only — the module is stateful by nature (configure-once). */
export function resetForTests(): void {
  configured = false;
}

/** Sync the RevenueCat identity to the app's auth state. `null` means signed out.
 *
 *  logIn is idempotent-enough on RevenueCat's side, but each call is a network round-trip,
 *  so the caller (PurchasesIdentity) only invokes this when the uuid actually changes; the
 *  getAppUserID check here is the second guard for restarts, where RevenueCat has already
 *  restored the cached identity. logOut resets to a fresh anonymous id — required so an
 *  account switch on a shared device cannot render user A's entitlements to user B. */
export async function syncIdentity(userId: string | null): Promise<void> {
  if (!ensureConfigured()) return;
  try {
    const current = await Purchases!.getAppUserID();
    if (userId) {
      if (current !== userId) await Purchases!.logIn(userId);
    } else if (!(await Purchases!.isAnonymous())) {
      await Purchases!.logOut();
    }
  } catch {
    // Identity sync is retried on the next auth transition; billing UI independently
    // re-checks entitlements, so a transient failure here must never crash the shell.
  }
}

/** The current Offering (paywall contents), or null when unavailable/unconfigured/empty.
 *  Null is a normal state the paywall must render (offerings are authored in the RevenueCat
 *  dashboard and may lag the app), not an error. */
export async function currentOffering(): Promise<PurchasesOffering | null> {
  if (!ensureConfigured()) return null;
  try {
    const offerings = await Purchases!.getOfferings();
    return offerings.current ?? null;
  } catch {
    return null;
  }
}

export type PurchaseResult =
  | { status: 'purchased'; customerInfo: CustomerInfo }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

export async function purchase(pkg: PurchasesPackage): Promise<PurchaseResult> {
  if (!ensureConfigured()) return { status: 'unavailable' };
  try {
    const { customerInfo } = await Purchases!.purchasePackage(pkg);
    return { status: 'purchased', customerInfo };
  } catch (e) {
    const err = e as { userCancelled?: boolean; message?: string };
    if (err.userCancelled) return { status: 'cancelled' };
    return { status: 'error', message: err.message ?? 'Purchase failed.' };
  }
}

export type RestoreResult =
  | { status: 'restored'; active: boolean }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** Restore Purchases — the Play-required path for a fresh install finding its subscription. */
export async function restore(): Promise<RestoreResult> {
  if (!ensureConfigured()) return { status: 'unavailable' };
  try {
    const info = await Purchases!.restorePurchases();
    return { status: 'restored', active: hasPro(info) };
  } catch (e) {
    return { status: 'error', message: (e as Error).message ?? 'Restore failed.' };
  }
}

export const hasPro = (info: CustomerInfo): boolean =>
  info.entitlements.active[PRO_ENTITLEMENT] !== undefined;

/** Render-only entitlement check (constraint 3 above). Null when billing is unavailable. */
export async function proActive(): Promise<boolean | null> {
  if (!ensureConfigured()) return null;
  try {
    return hasPro(await Purchases!.getCustomerInfo());
  } catch {
    return null;
  }
}
