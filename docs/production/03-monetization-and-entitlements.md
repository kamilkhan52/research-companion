# Monetization and entitlements (M4 →)

*Written 2026-08-14 with the M4 client foundation PR. This is the design record for how money
maps to access. `20-pricing-analysis.md` holds the unit economics behind the numbers;
`10-roadmap.md` M4/M5 hold the milestone framing.*

## The shape

**RevenueCat + Google Play Billing, subscription-only, one entitlement.**

- **Entitlement:** `pro` (`PRO_ENTITLEMENT` in `mobile/src/purchases/purchases.ts`). Active ⇒
  the paid tier; absent ⇒ free tier. Tier→allowance mapping is M3's `app/plans.py`
  (`plans.for_user` is already shaped for the per-account lookup M5's entitlements make real).
- **Products (H9, Kamil):** monthly and annual subscriptions. Pricing decided 2026-08:
  **$10 Basic / $25 Pro monthly + annuals** — final product IDs and price points are authored
  in Play Console and mirrored in RevenueCat, never hardcoded in the app.
- **Paywall = the current Offering.** The paywall screen (`mobile/src/app/paywall.tsx`)
  renders whatever packages the RevenueCat dashboard's current Offering carries — package
  list, prices and order are dashboard-controlled, so pricing experiments need no app release.

## Identity rules (the part that must never regress)

- **App User ID = the Supabase auth UUID. Never email.** Emails change and get recycled;
  the UUID is the same subject the backend's ownership rows and quota ledger key on, which is
  what lets M5's webhook map a RevenueCat event to a `rc_*` row without a join table.
- Configuration is **anonymous at app start**; `PurchasesIdentity` (mounted under
  `AuthProvider` in `_layout.tsx`) calls `logIn(uuid)` on sign-in and `logOut()` on sign-out.
  A purchase made anonymously before sign-in is aliased onto the account by RevenueCat's
  transfer behavior on the next `logIn`.
- **`logOut()` on sign-out is mandatory** — it resets to a fresh anonymous id so a shared
  device can never render user A's entitlements to user B. A direct A→B switch is just
  `logIn(B)`; RevenueCat handles the identity swap.
- The client's entitlement reading is **render-only**. Server-side enforcement is M5's
  webhook → `entitlements` projection → `plans.for_user`; no client claim is trusted for
  anything the server charges for (the same principle as M3's spend ceiling).

## Degradation ladder (all typed, all tested — `mobile/test/purchases.test.ts`)

1. **Native module absent** (a dev client predating the dependency — the react-native-view-shot
   lesson, DR-062): `billingAvailable()` is false, every entry point no-ops or returns an
   `unavailable` result, the paywall explains a rebuilt app is needed. The app is fully usable.
2. **No SDK key**: same as (1). The key lives in `app.json → extra.revenuecatAndroidApiKey` —
   a **publishable** key by design. Today it is the onboarding TEST key; swap in the
   Play-specific `goog_…` key when RevenueCat↔Play connect (no code change).
3. **Offerings fetch fails or is empty** (dashboard not authored, network): paywall renders an
   honest "plans aren't available" state with retry. Null is a normal state, not an error.
4. **Purchase outcomes**: `purchased` / `cancelled` (silent — the reader changed their mind) /
   `error` (toast). **Restore Purchases** is always present when billing works: it is the
   Play-required recovery path for a fresh install finding its subscription.

## Flags and rollout

- The paywall is reachable only from the Plan screen's **dev-gated Upgrade row**
  (`__DEV__ && billingAvailable()`), per M4's rollback plan: paywall behind a flag,
  entitlement checks default closed, the app remains usable on the free tier. The gate
  widens when M5 lands server-side enforcement.
- **Billing Library gate, verified 2026-08-14:** Play rejects new apps/updates on Billing ≤7
  after **2026-08-31**. `react-native-purchases` 10.7.1 (installed) ships **Billing 8.3.0** —
  clear. Re-verify on any SDK downgrade.
- **Native rebuild required:** react-native-purchases is a native module. The dev client on
  Kamil's phone (EAS build `b6f68fe2`, 2026-08-11) predates it — sandbox purchase testing
  needs a fresh `eas build --profile development` (and the eventual AAB gets it for free).

## What remains (in order)

1. **H8 remainder (Kamil):** Play payments profile — agreements, tax and banking — required
   before any subscription product can be created. The app itself was created 2026-08-14
   (Free — correct and irreversible-by-design for a subscription app; the download is free,
   revenue is in-app).
2. **H9 (Kamil):** author the subscription products + base plans in Play Console, mirror them
   in RevenueCat, define the `pro` entitlement and the current Offering (monthly + annual
   packages).
3. **H10 (Kamil):** Play service credential; connect RevenueCat to the Play app; swap the
   `goog_…` public SDK key into `app.json`.
4. Dev-client rebuild; sandbox purchase of both packages on-device (M4's manual gate:
   purchase → reinstall → Restore recovers the entitlement).
5. **M5:** webhook endpoint, `entitlements` projection in Postgres (RevenueCat authoritative,
   projection rebuildable, one reconciliation command), tier→quota wiring, Customer Center.

## Decisions taken in the M4 client PR

- **No RevenueCat MCP dependency.** M4's scope note said to evaluate it; the client
  foundation needs nothing from it, and dashboard configuration is H9's manual step for now.
  Revisit if M5's config churn warrants agent-operable dashboard access (least-privilege,
  documented without credentials).
- **iOS is out of scope everywhere** — no Apple developer account; the key name in app.json
  is deliberately `revenuecatAndroidApiKey` so an iOS key later is an addition, not a rename.
