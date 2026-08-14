// M4 — keeps the RevenueCat App User ID in lockstep with the Supabase auth UUID.
//
// Mounted once under AuthProvider (see _layout.tsx). Renders nothing; its only job is the
// identity transitions the roadmap pins down: sign-in → logIn(uuid), sign-out → logOut()
// (fresh anonymous id, so a shared device can never show one account's entitlements to
// another), direct A→B switch → logIn(new uuid). All of it no-ops on a build without the
// native module or without a key (purchases.ts guards).

import { useEffect } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { syncIdentity } from '@/purchases/purchases';

export function PurchasesIdentity() {
  const { userId } = useAuth();
  useEffect(() => {
    void syncIdentity(userId);
  }, [userId]);
  return null;
}
