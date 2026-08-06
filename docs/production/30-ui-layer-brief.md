# Production UI layer — reference brief

*Drafted 2026-07-26 and updated after receiving seven screenshots from the running Android app.*

## Purpose

This document bridges the production-readiness roadmap and the Figma UI work. The reference
screens establish useful hierarchy, density, and state-composition patterns; they do not override
the application contract, security model, pricing analysis, or milestone ordering.

The durable source images live in two sets:

- [`docs/design-references/production-ui-2026-07/`](../design-references/production-ui-2026-07/)
  contains eight aspirational account, subscription, usage, and settings references.
- [`docs/design-references/current-app-2026-07/`](../design-references/current-app-2026-07/)
  contains seven screenshots of the running Android app and is the visual-language source of truth.

The editable Figma file remains the design source of truth.

## Relevant production milestones

| UI surface | Roadmap source | Required behavior |
|---|---|---|
| Welcome and sign-in | M2 | Supabase session bootstrap with no signed-out/signed-in flash; magic link and Google are the implemented providers |
| Email verification follow-up | M2 | Explain the pending magic link, support resend/change-server recovery, and handle expired or reused links honestly |
| Legal, deletion, and reporting | M2.5 and M7 | Privacy/terms links, account deletion, AI-content reporting, and support must be real reachable surfaces |
| Usage and credit states | M3 | Server-authoritative usage, reset timing, 80% warning, hard-limit handling, and no client-side claim of remaining quota |
| Paywall and restore | M4 | Render RevenueCat's current Offering rather than hardcoding product availability; support restore and offering-fetch failure |
| Subscription management | M5 | Server-enforced entitlement, Customer Center management, cancellation/grace/retry states, and reconciliation-safe status |
| Settings and account lifecycle | M2, M2.5, M7 | Separate personal preferences from operator-owned settings; expose sign-out, deletion, legal, support, and reporting paths |

## Translation into the existing design language

- Recompose the aspirational references in the running app's production language: warm cream
  canvas, white cards, thin neutral-gray borders, Paradigm green actions, restrained violet usage
  accents, and large rounded geometry.
- Continue the established `393 × 852` Android canvas and system chrome shown in the supplied app
  screenshots.
- Keep Manrope for controls, labels, and dense cards. Use Newsreader for onboarding and page-level
  editorial hierarchy, consistent with the app's scholarly reading surfaces.
- Preserve the references' strongest structural ideas: one clear page purpose, generous first-run
  hierarchy, grouped recovery actions, explicit usage progress, and a single dominant purchase or
  continue action.
- Use the Settings reference as an information-architecture model, not a feature checklist. Hide
  rows for capabilities that are not implemented, configured, or meaningful for the current
  account.
- Every new screen or state belongs in a named section on `02 · Mobile Screens`; do not add loose
  frames or duplicate existing pages.

## Figma output

The editable screens are in `Research Companion — UI Redesign Proposal`, page
`02 · Mobile Screens`, section `17 · Production Readiness · Accounts, Usage & Billing`.

| Screen | Figma node |
|---|---|
| Welcome | `90:104` |
| Sign in | `90:106` |
| Create account | `90:108` |
| Check inbox | `90:110` |
| Upgrade | `90:112` |
| Subscription | `90:114` |
| Usage | `90:116` |
| Settings | `90:118` |

The sign-in, upgrade, usage, and settings frames carry Figma annotations for the authentication,
RevenueCat, credit-attribution, reporting, privacy, and deletion constraints.

## One-to-one visual comparison pass

The eight Figma screens were reviewed one-to-one against the matching aspirational references on
2026-07-26. The pass retained the running app's production language and made the following
reference-driven refinements:

- **Welcome:** replaced the provisional monogram with the production Paradigm mark and strengthened
  the connected-paper illustration with editable document nodes and a denser research graph.
- **Check inbox:** replaced the placeholder `@` illustration with an editable envelope/check
  illustration and rounded the recovery actions into one grouped list.
- **Upgrade:** added subtle benefit-row separators to improve scanning while preserving live
  Offering-driven package and renewal copy.
- **Subscription:** promoted management to a full-width action and grouped entitlement rows into
  a single rounded list.
- **Usage:** expanded the credit explanation into a two-level callout without implying fixed
  per-feature allowances.
- **Settings:** rounded each information-architecture group and the destructive-action group so
  the dense page reads as a sequence of intentional cards rather than unrelated rows.
- **Sign in and Create account:** retained as-is after comparison; their production-correct
  magic-link/Google hierarchy was already stronger than copying the reference password and
  unsupported-provider controls.

All eight frames passed a final bounds audit with no overflow, use only the product's Manrope and
Newsreader families, and retain visible Android home indicators.

## Product truth versus reference copy

The following reference details are placeholders and must not silently become requirements:

- The screenshots say “Paradigm Pro” and show `$14.99/month` and `$119.99/year`. The current
  pricing analysis recommends **Basic at $10/month** with **2,500 credits**. Final pricing and tier
  naming remain human decisions.
- Annual availability and discount copy must come from the RevenueCat Offering. The client must
  not imply that a package exists when it does not.
- Apple and Microsoft sign-in appear in a reference, but the implemented mobile plan currently
  specifies magic link and Google. Only configured providers should be shown.
- Password creation and password-security rows appear in the references, but the implemented flow
  is magic-link-first. Do not introduce password UI unless Supabase password authentication is an
  explicit product decision and is implemented end to end.
- Credit balances, renewal dates, reset dates, payment brands, and entitlement labels must come
  from authoritative services, never fixture copy.
- The pricing model defines one fungible monthly credit balance. A feature breakdown may explain
  actual attributed spend, but it must not imply separate per-feature allowances unless M3
  deliberately implements those buckets. Avoid impossible states such as usage against a zero
  allowance.
- “Encrypted and stored securely” or similar assurance language needs to match the approved
  privacy/security documentation before it appears in product UI.
- “Advanced models,” project-size limits, deeper-insight tools, and other tier benefits need a
  server-enforced entitlement or quota definition before they are advertised.

## Initial screen/state inventory

1. First-run welcome.
2. Sign-in and account creation entry.
3. Magic-link sent / check-inbox state.
4. Paywall with current monthly/annual offerings, restore, legal links, and graceful loading/error
   states.
5. Active subscription and usage overview.
6. Settings hub with account, plan, usage, preferences, support/legal, sign-out, and deletion
   groups; unavailable rows are omitted rather than shown as dead ends.
7. Create-account entry consistent with the enabled Supabase providers and approved legal copy.
8. Subscription lifecycle variants: free, active, grace period, billing retry, cancelled but
   active through term, expired, and entitlement unavailable.
9. Credit lifecycle variants: healthy, 80% warning, exhausted, reset pending, and usage service
   unavailable.

## Open design decisions

- Public tier name: Basic, Pro, or another label.
- Final monthly/annual prices and whether both packages launch together.
- Which benefits are marketable at M4 versus only after M5 server enforcement.
- Whether email/password account creation is in scope or the UI remains magic-link-first.
- Where account deletion, AI-content reporting, legal links, and support live in Settings.
- Whether usage is presented primarily as credits, operations, premium-audio minutes, or a
  combined explanation.
- Which existing Settings rows remain app-global/operator-owned and therefore must not be exposed
  as ordinary per-user preferences.
