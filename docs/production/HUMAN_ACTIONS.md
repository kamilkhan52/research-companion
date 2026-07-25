# Human actions

Things **only Kamil** can do — account ownership, legal attestations, financial setup, and
decisions with money or legal consequence. Agents must not attempt these, and must not work around
them with browser automation.

Format: each action states what to do, why an agent can't, which milestone it blocks, and **what to
report back** so the agent can continue.

Status: `todo` / `done` / `n/a`. Keep this file current — it is the handoff surface between you and
every agent session.

---

## Blocking now (M1)

### H1 — Fix GitHub Actions billing · `todo`
All CI jobs have failed at the account billing gate since 2026-07-22 (~3s, 0 steps). Until this is
fixed there is no automated gate on any of the work below, and every "tests pass" claim is a local
claim only.
**Why not an agent:** account billing.
**Blocks:** M1 (and quality-gates everything after).
**Report back:** confirmation that a workflow run reaches a real step.

### H2 — Domain + hosting account · `todo`
Register or point a domain for the production API and web client, and create the hosting account
(Fly.io / Railway / Hetzner — the plan assumes a container with a persistent volume).
**Why not an agent:** payment, account ownership.
**Blocks:** M1, and transitively Supabase redirect URLs, the Play account-deletion URL, and Play
reviewer access.
**Report back:** the domain, the chosen platform, and how deploy credentials should be provided.

### H3 — Determine the Play developer account's situation · `todo`
Establish whether the account is personal or organizational and when it was created, then check
whether Google's closed-testing requirement applies (current rule for qualifying new personal
accounts: **12 testers opted in for 14 continuous days**).
**Why not an agent:** account-owner information.
**Blocks:** M10 — but must be answered at **M1**, because if it applies it adds a four-week
calendar dependency that has to run in parallel with development, not after it.
**Report back:** account type, creation date, and whether the requirement applies.

---

## Blocking M2 (identity and tenancy)

### H4 — Create production and staging Supabase projects · `todo`
Two projects (never share one across environments — production customer data must not be casual
test data). Enable **asymmetric JWT signing keys** so the JWKS endpoint is live, and enable the
Email and Google providers. `README.md` already documents this setup.
**Why not an agent:** account creation.
**Report back:** both project URLs and anon (publishable) keys. The anon key is publishable and
safe to share; **never** paste a service-role key into chat, a commit, or a doc.

### H5 — Google OAuth credentials · `todo`
Create a Web OAuth client with redirect URI `https://<ref>.supabase.co/auth/v1/callback`, and add
the production web origin to authorized JS origins. Put the client ID and secret into Supabase's
Google provider.
**Why not an agent:** Google Cloud account ownership.
**Report back:** confirmation only — no secrets.

### H6 — Decide how the operator role is assigned · `todo`
M2 splits settings into operator-owned (API keys, system prompts) and per-user preferences. Decide
how "operator" is granted — an allowlist of user UUIDs in config is the simplest and is the
recommendation.
**Why not an agent:** a security-policy decision.
**Report back:** the mechanism, and your own auth UUID once H4 exists.

---

## Blocking M4/M5 (money)

### H7 — RevenueCat account and project · `todo`
Create the account and project, connect the Play app.
**Report back:** project confirmation and how the API key should be provided. **Never commit the
RevenueCat v2 API key or OAuth credentials.**

### H8 — Play Console: create the app, agreements, tax and banking · `todo`
Create the app listing for `com.kamilkhan.researchcompanion`, accept the developer agreements, and
complete tax and banking setup (required before any paid product can be sold).
**Why not an agent:** legal agreements and financial identity.
**Report back:** app created, agreements accepted, payments profile active.

### H9 — Author store product IDs and prices · `todo`
Create the monthly and annual subscription products in Play Console and mirror them in RevenueCat.
**Why not an agent:** pricing is a business decision with financial consequence.
**Report back:** product IDs, prices, and any trial or intro-offer terms.

### H10 — Play service account credential · `todo`
Generate the Google service account for EAS Submit and grant it the minimum Play Console
permissions needed.
**Why not an agent:** credential issuance.
**Report back:** where the JSON key is stored (EAS secret — **not** the repo).

---

## Blocking M7 (compliance)

### H11 — Approve privacy policy and terms of service · `todo`
An agent can draft both from the M7 data inventory. Publishing them is a legal statement about your
product and must be your decision. Consider review if the subscription terms are non-trivial.
**Report back:** approved text and the public URLs.

### H12 — Support contact · `todo`
A monitored email or support surface, required by the Play listing.
**Report back:** the address.

### H13 — Data Safety declarations · `todo`
The agent produces the truthful inventory; **you** make the declarations in Play Console — they are
attestations by the developer.
**Report back:** submitted.

### H14 — Paper-source terms decision · `todo`
M7 audits arXiv, Semantic Scholar, and OpenAlex terms for **commercial** storage and redistribution
of full text and figures. The agent reports what the terms say; if they constrain the product, the
call on how to respond (tier it, change caching, seek permission) is yours.
**Report back:** the decision, so the architecture can follow it.

---

## Blocking M3 (quotas)

### H15 — Set tier limits and pricing · `todo`
The free allowance, Pro quotas, and hard ceilings are business decisions. M3's event data gives you
real cost-per-paper numbers to base them on — expect to set them provisionally and revise at M10.
**Report back:** free tier allowance, Pro quotas, hard ceiling per user, and behavior at the limit.

---

## Blocking M10/M11 (launch)

### H16 — Recruit closed-test testers · `todo` / `n/a`
Only if H3 says the requirement applies. 12 testers, 14 continuous days.
**Report back:** tester list and the date the closed test opened.

### H17 — Store listing copy and assets · `todo`
Descriptions, screenshots, feature graphic, content rating questionnaire, target-audience
declaration, ads declaration. An agent can draft copy and generate screenshots; the submissions and
rating answers are yours.

### H18 — Reviewer credentials · `todo`
The app requires login, so Play review needs working test credentials.
**Report back:** the review account, created on production.

### H19 — Final release authorization · `todo`
Promotion to the production track. Never automate this.

---

## Standing rules

- **No secrets in the repository, in documentation examples, in logs, or in chat.** Publishable keys
  (Supabase anon) are fine; service-role keys, RevenueCat v2 keys, OpenRouter/OpenAI keys, and the
  Play service account JSON are not.
- **Agents never make destructive production changes** — dropping tables, deleting Play or
  RevenueCat configuration, promoting a release — without explicit approval in the moment.
- **Prefer official CLIs, APIs, and MCP servers over browser automation.** Browser automation is
  only for dashboard-only steps, and never to work around 2FA, a legal confirmation, or a security
  control.
- When an agent hits one of these actions, it should **stop that thread, finish everything else in
  the milestone, and surface the blocker** rather than inventing a workaround.
