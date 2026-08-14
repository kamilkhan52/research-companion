// M4 — keeps the RevenueCat App User ID in lockstep with the Supabase auth UUID.
//
// Mounted once under AuthProvider — inside it, but OUTSIDE AccountScopedApp, deliberately:
// it survives ProjectProvider's key={userId} remount AND stays mounted while AuthGate shows
// the signed-out screen, which is exactly when the sign-out transition must be observed.
// Renders nothing; its only job is the identity transitions the roadmap pins down:
// sign-in → logIn(uuid), sign-out → logOut() (fresh anonymous id, so a shared device can
// never show one account's entitlements to another), direct A→B switch → logIn(new uuid).
// All of it no-ops on a build without the native module or without a key (purchases.ts).
//
// Gated on auth STATUS, not just userId (Opus review, PR #405): userId is null while auth
// is merely UNRESOLVED — 'unknown' during session restore on every cold start, and
// 'unreachable' when the config/Supabase fetch fails offline. Keying on userId alone called
// logOut() on a perfectly good persisted identity at every launch (then raced the restore's
// logIn), and an OFFLINE launch would leave a real subscriber anonymous all session.

import { useEffect } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { syncIdentity } from '@/purchases/purchases';

export function PurchasesIdentity() {
  const { status, userId } = useAuth();
  useEffect(() => {
    if (status === 'signed-in' && userId) void syncIdentity(userId);
    else if (status === 'signed-out' || status === 'disabled') void syncIdentity(null);
    // 'unknown' / 'unreachable' / 'cleanup-required': auth unresolved — leave the persisted
    // RevenueCat identity exactly as it is. cleanup-required skipping logOut is safe, not a
    // gap: AuthGate blocks the whole app behind LocalCleanupRequired (nothing can read an
    // entitlement), clearing app data takes RevenueCat's cache with it, and the only other
    // exit is a successful adoption whose logIn supersedes the missed logOut.
  }, [status, userId]);
  return null;
}
