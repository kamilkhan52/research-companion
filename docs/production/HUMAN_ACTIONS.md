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

**Still needed before M1 can deploy:** a payment method on the Fly account — persistent volumes
(which hold `projects/` and `.app-state/`) are not available on the free allowance.

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

### H4 — Create production and staging Supabase projects · `todo` — **now blocks M1**
*Moved forward from M2 by Sol's review:* production will refuse to boot unless
`auth.mode() == "supabase"`, because `auth.mode()` otherwise falls back to `open` and a deploy that
forgets one env var would serve the entire API unauthenticated (audit P0-12). So the Supabase
projects must exist before M1 can deploy, not before M2.
Two projects (never share one across environments — production customer data must not be casual
test data). Enable **asymmetric JWT signing keys** so the JWKS endpoint is live, and enable the
Email and Google providers. `README.md` already documents this setup.
**Why not an agent:** account creation.
**Report back:** both project URLs and anon (publishable) keys. The anon key is publishable and
safe to share; **never** paste a service-role key into chat, a commit, or a doc.

### H20 — Set provider spend limits · `todo` — **blocks M1 deploy and M2.5**
Do this *before* the instance is publicly reachable, not before the closed test — M1 already
exposes a working backend to the internet.

- **OpenRouter:** set a per-key credit limit. This is a genuine hard stop — requests are rejected
  before reaching the upstream provider once it's exhausted. Set it below a number you'd accept
  losing outright.
- **OpenAI:** be aware that a "project budget" is **only an alert** — OpenAI removed hard budget
  caps, and requests keep being processed past the threshold (verified 2026-07-25; an earlier
  version of this file wrongly said it fails closed). Set the alert anyway, but the nearest real
  stop is a small **prepaid balance with auto-recharge disabled** — confirm that behavior before
  relying on it. The actual TTS ceiling is enforced in-app by M2.5, as a per-user daily budget —
  see H22, since the default model is token-priced rather than character-priced and the per-request
  figure is a conservative estimate rather than an exact cost.

**Why not an agent:** provider account billing settings.
**Report back:** the limits you set, so M2.5's in-app caps can be sized under them.

### H22 — Decide the production TTS model · `todo` — blocks M2.5
A quality-vs-accounting tradeoff, so it's yours. The default `gpt-4o-mini-tts` is priced on input
text tokens **plus generated audio tokens**, so its exact cost is not knowable before synthesis
(and `/audio/speech` returns raw mp3 with no usage payload). The older `tts-1` / `tts-1-hd` are
character-priced and therefore exactly costable in advance.

- **Keep `gpt-4o-mini-tts` (recommended)** — better voice, and audio is a headline feature. Quota
  reserves a conservative upper bound from character count, so the ledger over-counts slightly.
- **Pin `tts-1`** — exact per-character accounting, lower voice quality.

Either way the accounting is exact only *per dispatch*, not per narration: the synthesis path
retries up to 3× per segment and retries even on read timeouts, where the audio may already have
been produced and billed. M2.5 handles that by reserving per attempt.

**Report back:** the choice, so M2.5 sizes the per-user TTS budget accordingly.

### H21 — Provide your Supabase user UUID for the allowlist · `todo` — blocks M1
M1 ships a temporary allowlist because Supabase sign-in is self-service: without it, the first
stranger who signs up gets your single-tenant instance, including the shared provider keys and
system prompts. The allowlist is removed when M2's ownership enforcement lands.
**Report back:** your auth UUID (not an email) once H4 exists, plus tester UUIDs before M2.5.

---

## Blocking M2 (identity and tenancy)

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
