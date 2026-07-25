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

### H1 — Fix GitHub Actions billing · ✅ `done` (2026-07-24)
Actions spending limit was $0; raised to $10. Re-run on PR #217 went fully green (backend 47s,
web 50s, mobile 6m49s). CI is a usable merge gate again.
*Note: the mobile job burns ~7 min/run, which is most of the spend against that cap — re-check
the limit if reds reappear with the ~3s/0-steps signature.*

### H2 — Hosting account · ✅ `done` (2026-07-25)
Fly.io account created; `flyctl` installed via Homebrew and authenticated on the dev Mac as
`kaamilkhaan52@gmail.com`. Org: `personal`. App `research-companion` exists (status `pending`,
never deployed), so the production origin will be **`research-companion.fly.dev`** with automatic
TLS unless we rename it.

*Auth note for future sessions:* `flyctl auth login` refuses to run without a TTY and `script`
rejects a FIFO for stdin, so a remote login is driven by a small PTY helper — flyctl prints a URL
Kamil opens on his phone, and the returned one-time code is written into the process. Credentials
now live in `~/.fly/`; no token needs to pass through chat again.

Payment method added 2026-07-25, so volumes are available. Staging app
`research-companion-staging` created with a 3 GB volume (`rc_data_staging`) in `dfw` — the nearest
Fly region to Colorado; there is no Denver region.

The plan assumes a container with a persistent volume; Fly was chosen because volumes are
first-class and the `*.fly.dev` subdomain ships with TLS.

**You do not need to buy a domain to start.** The host's own subdomain
(`paradigm.fly.dev` or similar) is a real HTTPS origin and is sufficient for Supabase redirect
URLs, the Play-required privacy-policy and account-deletion URLs, Play reviewer access, and the
entire closed test. A custom domain is an M10 polish item, not an M1 blocker — see H2b.

**Do not use the university domain (`colostate.edu`).** University IT policy almost universally
prohibits commercial use of institutional domains, the product would be tied to an affiliation you
may not keep, and a paid subscription app on a `.edu` host invites a policy problem with your
institution rather than solving a hosting one.

**Why not an agent:** payment, account ownership.
**Blocks:** M1, and transitively M2's auth redirect URLs, M7's public deletion URL, and H3's
tester clock.
**Report back:** the platform, the app subdomain it assigns, and how deploy credentials should be
provided (a scoped deploy token in an EAS/CI secret, never the repo).

### H2b — Custom domain · `todo` — deferred to M10
Buy before public launch, not now. **Cloudflare Registrar** sells at wholesale cost with no
markup and free DNS; Namecheap is the usual alternative. Budget ~$10–15/year for a `.com`.
A domain is just a name you rent annually and point at your host with a DNS record; Fly and
Railway both issue the TLS certificate automatically once you add it. The app is named Paradigm,
so name availability needs a search when we get there.
**Report back:** the domain, once purchased.

### H3 — Play developer account situation · ✅ `answered` — **the tester requirement applies**
Account created 2026-07, type **Personal**, currently pending verification.

Verified against Google's current policy (checked 2026-07-25,
[support.google.com/googleplay/android-developer/answer/14151465](https://support.google.com/googleplay/android-developer/answer/14151465)):
personal accounts created after **2023-11-13** must run a closed test with **≥12 testers opted in
for the last 14 continuous days**, then apply for production access (review typically ≤7 days).
Continuous means uninterrupted — a tester who drops out and rejoins resets their clock. The
requirement was 20 testers before December 2024; it is 12 now.

**Real cost: ~3 weeks minimum** from "12 real testers opted in" to production access, and that
clock cannot start until there is a working build on a Play closed track. See **M2.5** in the
roadmap: that slice starts this clock as early as is legal and safe. It sits after tenancy (M2) and
carries a compliance slice, because closed tracks require a Data safety form and privacy policy
(only *internal* testing is exempt, and internal doesn't satisfy the 12-tester rule), and because
12 external testers must not share one untenanted backend.

**Remaining human actions:** finish account verification; recruit 12 testers (see H16).

---

### H4 — Supabase project · ✅ `done (single project)` (2026-07-25)
*Moved forward from M2 by Sol's review:* production refuses to boot unless
`auth.mode() == "supabase"`, because `auth.mode()` otherwise falls back to `open` and a deploy that
forgets one env var would serve the entire API unauthenticated (audit P0-12).

Project `aumedoefxacycwfrlcml` is live. **Asymmetric JWT signing verified** — the JWKS endpoint
returns an ES256 key, so `app/auth.py`'s local verification will work. Email provider enabled;
Google provider in progress (see H5).

**Accepted compromise, decided 2026-07-25: one project serves both staging and production.** The
standing rule is that production data must never be casual test data, and this breaks it. Tolerable
only while the sole user is Kamil and the allowlist (H21) keeps the instance closed. **Revisit
before M2.5** — the moment 12 external testers create real accounts, staging must be separated, or
staging testing has to move to a throwaway project. Recorded here so it isn't forgotten rather than
silently accepted.

Publishable key received 2026-07-25 and set as a Fly secret (`RC_SUPABASE_ANON_KEY`) — it is
publishable by design and is served to clients via `/api/auth/config`, so it lives in deploy
secrets rather than in this repo. The **service-role / secret key was never requested and must
never leave the server side** — it bypasses RLS entirely.

### H20 — Set provider spend limits · ✅ `done` (2026-07-25)
OpenRouter per-key credit limit set. OpenAI **auto-recharge confirmed OFF**, so the prepaid balance
is a genuine hard stop — which matters because the dashboard budget alone would not have been one.
Both providers now fail closed. Re-verify the OpenAI Admin API enforcing limit if you also set one.

Do this *before* the instance is publicly reachable, not before the closed test — M1 already
exposes a working backend to the internet.

- **OpenRouter:** set a per-key credit limit. This is a genuine hard stop — requests are rejected
  before reaching the upstream provider once it's exhausted. Set it below a number you'd accept
  losing outright.
- **OpenAI:** two different things share the name "spend limit", and only one of them stops
  anything.
  - The **dashboard project/org monthly budget is a soft alert** — requests keep being processed
    past the threshold. Set it, but do not treat it as protection. (An earlier version of this
    file called it a hard cap; that was wrong.)
  - The **Admin API spend-limit resource supports an *enforcing* mode**, where requests fail once
    the limit is reached. This is the strongest provider-side control available — set it, and then
    **verify it actually blocks** with a deliberate small-limit test, since the dashboard and API
    surfaces have differed and community reports of limits "not being respected" exist.
  - **Prepaid balance with auto-recharge disabled** remains a belt-and-braces backstop, though it
    is org-wide and cutoff can lag.

  Regardless, the per-user TTS ceiling is enforced in-app by M2.5 (see H22) — provider limits
  protect *you* from total runaway; only the in-app budget stops one user burning everyone's.

**Why not an agent:** provider account billing settings.
**Report back:** the limits you set, so M2.5's in-app caps can be sized under them.

### H22 — Decide the production TTS model · `DONE 2026-07-25`
**Decision: `tts-1-hd`.** Kamil chose the higher-quality model over `gpt-4o-mini-tts`. Applied as
the default in `config.py` (`RC_TTS_MODEL` still overrides).

Verified against OpenAI's live docs on 2026-07-25 rather than from memory:
- `tts-1-hd` is **available, not deprecated**, and priced **$30.00 / 1M characters** (`tts-1` is
  $15.00). Character pricing means cost is **exactly computable before synthesis**, which is
  strictly better for the M3 quota work than the token-priced alternative.
- The `gpt-4o-mini-tts` *snapshot* `-2025-03-20` is deprecated (shutdown 2027-01-20), superseded by
  `-2025-12-15`. The floating `gpt-4o-mini-tts` alias is NOT deprecated — a search result claiming
  the model was deprecated conflated the snapshot with the family. Worth knowing if we revisit.

**Consequence to carry into M3:** `tts-1-hd` returns raw mp3 with no usage payload and no SSE, so
audio spend is *computed* from the character count we sent, never reported back. That is fine
because character pricing is deterministic — but it means `usage.py` must bill audio from input
length rather than waiting for a provider figure, and the `pending`/reconcile path that
`gpt-4o-mini-tts` would have used does not apply. Cheaper to reason about; different code path.

`app/tts.py` only sends `instructions` (the steerability prompt) when the model is
`gpt-4o-mini-tts`, so the `tts_instructions` prompt is now unused by default. Left in place: the
model remains selectable in Settings.

### H21 — Provide your Supabase user UUID for the allowlist · ✅ `done` (2026-07-25)
Received; it goes into `fly secrets` as `RC_ALLOWED_USERS`, not into this repo. The allowlist
exists because Supabase sign-in is self-service — without it the first stranger who signs up gets
the single-tenant instance, including the shared provider keys and system prompts. It is removed
when M2's ownership enforcement lands.
**Still needed before M2.5:** tester UUIDs, if the allowlist is still the gate at that point.

---

## Blocking M2 (identity and tenancy)

### H5 — Google OAuth credentials · ✅ `done` (2026-07-25)
Web client created and wired into Supabase's Google provider; 3 accounts added as OAuth test users.

**Carried forward to H16:** adding test users means the Google consent screen is in **Testing**
mode, which restricts sign-in to those specific accounts. Before M2.5 needs 12+ testers, either add
every tester as a Google test user (limit 100) or publish the consent screen. Publishing does not
require Google verification for basic email/profile scopes, but it is a step that is easy to hit at
the worst possible moment.

Original guidance, kept because it is the part people get wrong: create a **Web application** OAuth
client — *not* Android. Android client types have **no client secret**, which is what Supabase's
Google provider requires, so an Android client cannot satisfy this step.

- **Authorized redirect URI:** `https://aumedoefxacycwfrlcml.supabase.co/auth/v1/callback`
- **Authorized JavaScript origins:** `http://localhost:5173` (Vite dev) and
  `https://research-companion.fly.dev` once M1 deploys.
- Put the resulting client ID + secret into Supabase → Authentication → Providers → Google.

**A separate Android OAuth client is *probably* not needed at all.** Mobile sign-in (built in M2,
see P0-15) will use Supabase's `signInWithOAuth` through `expo-web-browser`, redirecting back via
the app's `researchcompanion` scheme — that flow uses the Web client. An Android client is only
required for the *native* Google ID-token flow. If one is ever created it needs package name
`com.kamilkhan.researchcompanion` (from `mobile/app.json`, not `com.example`) and the SHA-1 from
`eas credentials`, since EAS holds the signing keystore.

**Why not an agent:** Google Cloud account ownership.
**Report back:** confirmation only — no secrets.

### H6 — Operator identity · `DONE 2026-07-25`
**Decision: prompt editing is the developer's, not the user's.** Implemented as `RC_OPERATOR_USERS`
(comma-separated Supabase user ids) gating `POST /api/prompts` and `/api/prompts/reset`, which
previously accepted writes from **any authenticated user** — that was P0-3, and it was live.

Fails closed: unset means nobody is an operator, so prompt editing is disabled until someone is
named. A dev environment short-circuits to allow, since local prompt editing has no signed-in user.

**Kamil still needs to run this** for staging (and later production), or prompt editing stays off
for everyone including him:
```
flyctl secrets set RC_OPERATOR_USERS=b8f19707-4b13-4cbb-834a-93cd6d06f489 -a research-companion-staging
```

Unaffected, deliberately: the per-session **starting prompt** a reader edits before a discussion.
That travels on the turn (`ChatStartReq.prompt`) and never touches the prompt registry, so it stays
a normal user feature.

**`POST /api/settings` is gated the same way** (P0-2, closed 2026-07-25). So the operator role now
covers BOTH the system prompts and the instance's shared provider keys and model choice — more
authority than "prompt editing" implies, which is why the role is named operator rather than
prompt-editor. Reading settings stays open to everyone (keys return as 6-char hints), and
`GET /api/settings` reports `is_operator` so clients can render shared controls read-only instead
of failing on submit.

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

## Blocking M2.5 (closed-track compliance) and M7

**H11 and H13 are needed at M2.5, not M7.** A closed testing track requires a completed Data safety
form and a published privacy policy — only *internal* testing is exempt, and internal testing does
not satisfy the 12-tester rule. So these gate the tester clock.

### H11 — Approve privacy policy and terms of service · `todo` — blocks M2.5
An agent drafts both from the data inventory, which is an **M2.5 deliverable** (not M7 — M7 depends
on M2.5, so sourcing the policy from M7 would deadlock). Publishing them is a legal statement about
your product and must be your decision. Consider review if the subscription terms are non-trivial.
Expect to revise once at M3 (usage events) and once at M5 (billing data), since Data safety answers
must keep matching the policy.
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

### H16 — Recruit closed-test testers · `todo` — **required, confirmed by H3**
12 testers opted in for 14 **continuous** days. Each needs a real Google account that opts into
the closed track and keeps it — dropping out and rejoining resets that tester's clock, so recruit
14–15 for margin. Lab mates, friends, and cohort peers are the usual source; tester-swap
communities exist but read Google's policy on them before relying on one.

This is the longest calendar dependency in the whole plan and it does **not** need a
finished product — only a build good enough that testers can install and open it. Start it as
soon as M2.5 puts an AAB on the closed track.

**Prerequisite carried from H5:** the Google OAuth consent screen is in Testing mode, which
limits sign-in to explicitly listed accounts. Either add every tester as a Google test user (limit
100) or publish the consent screen before opening the closed test.

**Report back:** tester count, the date the closed test opened, and any drop-outs.

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
