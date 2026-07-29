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

### H26 — Production secrets, and the bootstrap order that avoids locking yourself out · `todo`
The app `research-companion` exists and its volume is created: **`rc_data`, 20 GB, `sjc`, encrypted,
scheduled snapshots on with 5-day retention** (`vol_rnzpyx8xp2j10xpr`, created 2026-07-29). A volume
cannot change region, so `sjc` is now fixed for production.

What is missing is secrets. Nothing else blocks a deploy. Run these yourself so no key passes
through an agent transcript — values from the **production** Supabase project
`aumedoefxacycwfrlcml`, not staging:

```
flyctl secrets set -a research-companion \
  RC_SUPABASE_URL=... \
  RC_SUPABASE_ANON_KEY=... \
  RC_SUPABASE_SECRET_KEY=... \
  RC_DATABASE_URL=... \
  OPENROUTER_API_KEY=...
```

**`RC_DATABASE_URL` must not be the `:6543` transaction pooler** — `app/db.py` refuses it outright,
because the app uses session-scoped advisory locks that a transaction pooler silently breaks. Use
the session pooler or the direct connection.

**Then the part that has bitten before.** `RC_ALLOWED_USERS` and `RC_OPERATOR_USERS` hold Supabase
user UUIDs, and **UUIDs are per project** — your staging ids mean nothing to the production project,
and the ids written in older revisions of this file are from a pre-split project. Setting a wrong
one locks everybody out, operator included, and the 403 deliberately does not name the account, so
there is no way to read the right id off the response. So:

1. Deploy **without** the allowlist first. With `RC_ALLOWED_USERS` unset the app refuses to boot in
   prod by design, so instead set it to a **throwaway placeholder** (`RC_ALLOWED_USERS=bootstrap`)
   purely so the safety check passes.
2. Sign in on the phone against the production origin. You will be refused — expected.
3. Read your real production UUID from `flyctl logs -a research-companion | grep "rejected
   non-allowlisted"`. That log line exists precisely for this moment.
4. Set the real values: `flyctl secrets set -a research-companion RC_ALLOWED_USERS=<uuid>
   RC_OPERATOR_USERS=<uuid> RC_ADOPT_OWNER=<uuid>`.

`flyctl secrets set` **replaces, it does not append**, and `secrets list` shows only names — so to
add a second user later you must set the whole comma-separated list again. See
`fly-secrets-are-replace-not-append` for the incident this comes from.

**Report back:** that secrets are set, and I will deploy and verify.

### H25 — Custom SMTP, or the closed test cannot happen · `todo` — **BLOCKS M2.5**
Found 2026-07-29 from an offhand remark by Kamil — *"the magic link has always gone to junk for me
so far"*. Chasing that turned up something much worse than a spam-folder problem.

**Supabase's built-in email service only delivers to pre-authorized addresses** — project team
members. Every other recipient is rejected outright with "Email address not authorized." It is also
capped at **2 messages per hour**, with no delivery SLA, and Supabase states plainly it is "not
meant for production use" (checked against
[supabase.com/docs/guides/auth/auth-smtp](https://supabase.com/docs/guides/auth/auth-smtp) on
2026-07-29).

So as things stand **the 12 testers cannot receive any auth email at all.** Not "it might land in
spam" — rejected. That breaks magic-link sign-in, email confirmation on sign-up, and password reset,
for everyone who is not Kamil. It is a hard blocker on the tester clock, which is the longest-lead
item in the entire plan, and nothing in this document had caught it.

Kamil's junk-folder experience is the *mild* version of the same cause, visible only because he is a
team member and therefore authorized at all.

**Fix:** configure custom SMTP on **both** Supabase projects (Authentication → Emails → SMTP
Settings). Supabase names Resend, AWS SES, Postmark, SendGrid, ZeptoMail and Brevo as compatible.
**Resend's free tier** is the obvious fit: 3,000 emails/month, 100/day, one verified domain — far
more than a 12-person closed test needs. Custom SMTP also raises Supabase's own cap from 2/hour to
30/hour (adjustable).

**This is what makes H2b a blocker rather than polish.** Every provider requires a domain you
control to send to arbitrary recipients; sandbox senders reach only your own address. So the domain
has to be bought now.

**Report back:** the domain, and confirmation that SMTP is configured on both projects.

### H2b — Custom domain · `todo` — **PROMOTED to M2.5 blocker on 2026-07-29** (was deferred to M10)
**No longer deferrable: H25 needs it.** Custom SMTP requires a verified sending domain, and without
custom SMTP the closed test's testers cannot receive auth email at all. It is still NOT needed as
the app's origin — `research-companion.fly.dev` remains fine for that, and for Play's policy URLs.
It is needed as an *email* domain.

**Cloudflare Registrar** sells at wholesale cost with no markup and free DNS; Namecheap is the usual
alternative. Budget ~$10–15/year for a `.com`.

**Availability, checked 2026-07-29:** `paradigm.ai` is **taken** (registered to Deep Vision
Architects), so `info@paradigm.ai` was never available. `getparadigm.com` and `useparadigm.com` are
also taken. **`readparadigm.com` and `paradigmreader.com` were both free.** Recheck before buying —
availability moves.

A domain is a name you rent annually; DNS records point it at things. For SMTP you add the
provider's verification records (SPF/DKIM) rather than pointing it at Fly at all.

*Also worth knowing:* "Paradigm" is crowded commercially, so the Play **store listing name** may
need to differ from the internal codename. That is a launch-time decision, not a blocker now.
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

### H4 — Supabase projects · ✅ `done — separate prod and staging` (2026-07-25)
*Moved forward from M2 by Sol's review:* production refuses to boot unless
`auth.mode() == "supabase"`, because `auth.mode()` otherwise falls back to `open` and a deploy that
forgets one env var would serve the entire API unauthenticated (audit P0-12).

Project `aumedoefxacycwfrlcml` is live. **Asymmetric JWT signing verified** — the JWKS endpoint
returns an ES256 key, so `app/auth.py`'s local verification will work. Email provider enabled;
Google provider in progress (see H5).

**Two projects, on the Free plan, at $0 — the one-project compromise is gone.**

| | Project ref | Purpose |
|---|---|---|
| Production | `aumedoefxacycwfrlcml` | the real instance |
| Staging | `iqsiabkdbczvgyccswcy` ("Research Companion Staging") | created 2026-07-25 |

This corrects an earlier decision that accepted one project serving both, which rested on my own
unverified claim that the account was already at Supabase's project cap. **It was not.** Free allows
**2 active projects**; both slots are now used, correctly.

**Asymmetric JWT signing verified on the staging project too** — its JWKS endpoint returns an ES256
key, which is what `app/auth.py` verifies against. That is the one thing that could have silently
failed, so it was checked before anything was pointed at it.

Free-plan caveats, both acceptable: a project **pauses after 1 week of inactivity**, which will
happen to staging between work sessions and needs an unpause click, and will not happen to a
production project with users on it; and there are **no automatic backups**, which is the real
reason to buy Pro ($25/mo) and belongs at the **M6** gate ("automated backups and a tested
restore"), not now. Note what Pro would protect: the ownership/index tables. The content record
 lives in git.

**Switching an instance to a different Supabase project invalidates its allowlist.** Supabase user
ids are **per project**, so the UUID in `RC_ALLOWED_USERS` / `RC_OPERATOR_USERS` — issued by the
production project — means nothing to the staging project. Pointing staging at
`iqsiabkdbczvgyccswcy` therefore locks *everyone* out, operator included, and the 403 deliberately
does not name the account, so there is no way to read the new id off the response.

The bootstrap, in order. **Step 1 is not optional** — without it step 3 silently produces nothing,
because the sign-in never completes, no protected request is ever made, and so no id is ever logged:

1. **Configure the staging project's auth URLs first.** `web/src/components/AuthGate.tsx` sends
   `redirectTo` / `emailRedirectTo` = `window.location.origin`, and Supabase only honours a redirect
   that is in the project's allowlist. A brand-new project has neither the Site URL nor the redirect
   entry for this app. In the staging project → Authentication → URL Configuration, set **Site URL**
   and add to **Redirect URLs** the staging origin (`https://research-companion-staging.fly.dev`).
2. Point staging at the new project: `RC_SUPABASE_URL`, `RC_SUPABASE_ANON_KEY`.
3. Sign in through the web client with the **magic link** (Google needs step 5 first). Supabase
   creates the account; the app then answers **403** on the first protected request.
4. Read the new UUID from `flyctl logs -a research-companion-staging` — since 2026-07-25 it prints
   `auth: rejected non-allowlisted user id=<uuid>`, added precisely so this needs no dashboard.
   (Supabase dashboard → Authentication → Users also has it.) Set both `RC_ALLOWED_USERS` and
   `RC_OPERATOR_USERS` to that id.
5. **Google OAuth is separate work (H5) and does not carry across projects.** The staging project
   needs its own provider configuration, and the Google Cloud Web client needs
   `https://iqsiabkdbczvgyccswcy.supabase.co/auth/v1/callback` as an authorized redirect URI plus
   the staging origin as an authorized JavaScript origin. Until then, magic link is the way in.

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

### H22 — Decide the production TTS model · `DONE 2026-07-25, REVISED same day`
**Decision: `tts-1`.** Kamil first chose `tts-1-hd` over `gpt-4o-mini-tts`, then revised to `tts-1`
once the cost analysis existed — `-hd` is **$30.00 / 1M characters against `tts-1`'s $15.00**, and
audio is the dominant cost in this app (finding 1 of `20-pricing-analysis.md`), so the default was
halving the largest line item. Applied as the default in `config.py` and `tts.py` (`RC_TTS_MODEL`
still overrides, and `tts-1-hd` remains selectable in Settings for anyone who wants it).

**This halves *unmetered* audio spend, not the tier economics.** `20-pricing-analysis.md` §2 already
priced the paid allowance at `tts-1` ($0.65 for 45 min), so the $2.22 variable cost and 74% margin
are unchanged. What changes is today's uncapped default behaviour: the measured ~2.4M characters go
from ~$72 to **~$36** and the per-turn audio figure from $0.32 to **$0.16**, moving audio from 79%
of a turn's cost to ~65% — still the largest single line, which is why the M3 hard cap still
matters. LLM figures untouched.

**A stored setting outranks a default.** `config.load_settings()` layers `.app-state/settings.json`
over the env defaults, so any instance that already has `tts_model` saved keeps its old value —
changing this default does *not* change a running instance. The fix is to POST `tts_model: ""`,
which clears the override so the instance follows the default from then on, rather than pinning
`"tts-1"` and having to repeat this the next time the default moves.

Verified against OpenAI's live docs on 2026-07-25 rather than from memory:
- Both `tts-1` ($15.00 / 1M characters) and `tts-1-hd` ($30.00) are **available, not deprecated**.
  Character pricing means cost is **exactly computable before synthesis**, which is strictly better
  for the M3 quota work than the token-priced alternative — and that property is what made the
  later switch from `-hd` to `tts-1` a pure price change with no accounting rework.
- **`gpt-4o-mini-tts` deprecation — OpenAI's own two pages disagree, so do not state this
  confidently either way.** The model page shows the *snapshot* `-2025-03-20` as `Deprecated` with
  `-2025-12-15` as current, which is what an earlier version of this note asserted. But the
  all-models catalog labels the **family** "GPT-4o mini TTS — Deprecated". Re-checked 2026-07-25;
  both readings are live. The earlier note went further and claimed a search summary saying "the
  family is deprecated" was simply wrong — that claim is not supportable, and it is removed.
  Consequence: none today. We are on `tts-1`, and the same catalog shows **`tts-1` and `tts-1-hd`
  carrying no deprecation label**. It matters only if we ever revisit `gpt-4o-mini-tts`, at which
  point the family's status must be settled first.

**Consequence to carry into M3:** the `tts-1` family returns raw mp3 with no usage payload and no SSE, so
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

### H5 — Google OAuth credentials · 🟡 `prod done; staging callback outstanding` (2026-07-26)
Web client created and wired into Supabase's Google provider; 3 accounts added as OAuth test users.

**The staging project's callback is a SEPARATE redirect URI and is missing.** Hit on the first
device test of mobile sign-in (2026-07-26):

```
Error 400: redirect_uri_mismatch
redirect_uri=https://iqsiabkdbczvgyccswcy.supabase.co/auth/v1/callback
```

Enabling the Google provider *inside* Supabase is only half the job. The other half is in Google
Cloud Console, and it is per-project because the callback URL contains the project ref. Add to the
same **Web application** client's *Authorized redirect URIs*:

```
https://iqsiabkdbczvgyccswcy.supabase.co/auth/v1/callback
```

Worth knowing for diagnosing this class of error: there are **two** redirect legs, and only one of
them is Google's business.

| Leg | Redirect | Registered where |
|---|---|---|
| App → Supabase | `researchcompanion://auth` | Supabase → Authentication → URL Configuration |
| Supabase → Google and back | `https://<ref>.supabase.co/auth/v1/callback` | Google Cloud Console → Credentials |

A `redirect_uri_mismatch` from Google is always the second leg, so the app's own scheme is never
the cause and changing it never helps. Magic-link sign-in does not touch Google at all, which makes
it the way to verify everything else while this is outstanding.

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
flyctl secrets set RC_OPERATOR_USERS=<your-staging-supabase-uuid> -a research-companion-staging
```

**The literal UUID that used to sit in that command was removed on 2026-07-28, because it was
wrong and it caused an outage.** It predated the 2026-07-25 split into a separate staging Supabase
project, and Supabase user ids are per project — the same warning H4 already gives. An agent read
it as current, used it to rewrite `RC_ALLOWED_USERS`, and locked Kamil out of staging until the
real ids were recovered from `flyctl logs`.

Two rules follow, and they are the actual lesson:

- **Never write a UUID for a live environment into these documents.** They go stale silently and
  read as authoritative. The environment is the source of truth.
- **`flyctl secrets set` REPLACES a value, and `flyctl secrets list` shows only names.** So a
  secret that holds a list — `RC_ALLOWED_USERS`, `RC_OPERATOR_USERS` — cannot be appended to
  safely: you cannot read what is there. Setting one means setting the complete intended list, and
  if you do not know it, recover it first rather than guessing.

To recover the ids when they are unknown: sign in on the device and read the middleware's own
rejection line, which exists for exactly this — `flyctl logs -a research-companion-staging
--no-tail | grep "rejected non-allowlisted"` prints the id it refused.

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

### H11 — Approve privacy policy and terms of service · ✅ `APPROVED by Kamil 2026-07-29`
Approved as written, with governing law corrected to **California**. Re-approval is needed only if
the text changes materially — expect that at M3 (usage events) and M5 (billing data), since the Data
safety answers must keep matching.

Both are live, sourced from the data inventory in `02-security-and-privacy.md`:

- `/legal/privacy` — `app/legal/privacy.html`
- `/legal/terms` — `app/legal/terms.html`
- `/legal/delete-account` — `app/legal/delete-account.html`

Read them on staging: <https://research-companion-staging.fly.dev/legal/privacy>.

**What needs your judgement, not an agent's.** Publishing these is a legal statement about your
product. Four specific things to look at rather than a general "read it all":

1. **Governing law is California, USA** (corrected 2026-07-28 — Kamil lives in California, not
   Colorado, which an earlier draft assumed), and liability is capped at the greater of twelve
   months of fees or $20.
   *Two consequences worth knowing.* CCPA/CPRA attaches to businesses meeting thresholds — roughly
   $25M revenue, or personal information on 100k+ California consumers, or half of revenue from
   selling it. None apply here, so no CCPA-specific disclosures are added; the policy's rights
   section is written generally and already says the app does not sell data. Revisit at M10 if the
   user base grows.
   *And:* the staging Fly region is `dfw`, chosen as nearest to **Colorado**. **Production has not
   been created yet, so pick `sjc` (San Jose) for it** — a free improvement while the choice is
   still open. Not worth moving staging, which already has a volume there.
2. **The terms say the AI output can be confidently wrong** and must not be relied on for research,
   teaching or clinical use. That is deliberately blunt. It is honest and it is also a disclaimer
   you may want a lawyer to phrase differently.
3. **The privacy policy promises that no provider retains or trains on paper text.** That promise is
   now enforced in code (`llm.PRIVACY_ROUTING`) and tested, but it rests on OpenRouter's
   classification of its providers — we verify the routing, not the providers' internals.
4. **You are named as the developer** with `thelocalscientist@gmail.com` as the public contact.

Expect to revise once at M3 (usage events) and once at M5 (billing data), since Data safety answers
must keep matching the policy.
**Report back:** approval, or the specific changes you want.

### H24 — Confirm email sign-up is enabled on both Supabase projects · ✅ `done` (Kamil, 2026-07-29)
Both settings were already as needed. **Caveat that outranks this action:** whichever way "Confirm
email" is set, delivery itself is broken for anyone but Kamil until **H25** (custom SMTP) is done —
see below. If "Confirm email" is ON, sign-up is impossible for testers until then; if OFF, sign-up
works but password reset still cannot reach them.

*Original text:*
Password sign-up and reset were added on 2026-07-28. They use the email provider that magic links
already use, so nothing new needs enabling — but two settings decide whether they work, and both
live in the dashboard rather than in code. In **each** project (prod `aumedoefxacycwfrlcml`,
staging `iqsiabkdbczvgyccswcy`) → Authentication → Providers → Email:

- **"Allow new users to sign up" must be ON**, or `signUp` fails for everyone and the create-account
  screen is dead.
- **"Confirm email"** is your choice. ON (Supabase's default) is safer and is what the code expects
  by default: sign-up returns no session, and the app sends the user to the check-inbox screen.
  OFF signs them straight in. Both paths are implemented and tested; nothing breaks either way.

Also confirm the app's redirect URL is still in the allowlist — password reset uses the same
`researchcompanion://auth` target as magic links, so if links work, resets will.
**Report back:** which setting you chose for "Confirm email", so the tester instructions match.

### H12 — Support contact · ✅ `done` (2026-07-28)
`thelocalscientist@gmail.com` — not a personal address, already controlled, in use now as the
privacy contact on all three legal pages and the address the deletion page tells readers to write
to. It is the address the Play listing should use.

*It is a real obligation, not a form field:* the deletion page promises a reply and completion
within 30 days, so this inbox has to be watched. Revisit if a custom domain lands (H2b) — but
changing it later means editing the published policy, so prefer keeping it.

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

### H23 — Supabase server secret for account deletion · `done` (staging, 2026-07-28)
Create or retrieve a server-side Supabase secret/service-role key for each environment, then set it
directly as the Fly secret `RC_SUPABASE_SECRET_KEY` on that environment. Do not paste the value into
chat, source, a PR, or a client configuration. Supabase requires this privileged server credential
to delete an Auth identity; the publishable anon key cannot perform that operation.

Wait until the account-deletion coordinator has landed before setting it. Then verify deletion
with a disposable staging account before production configuration. The backend treats an already
missing Auth identity as success so the final step is safe to retry.

**Done on staging 2026-07-28.** The key is set, and a throwaway email account was deleted end to end on a device: the flow ran to completion, the client cleared its local state, and the acknowledgement screen appeared. Production still needs its own key when that app exists.

Original note, kept for the production repeat: The coordinator (#253)
and the mobile client (#254) are merged and deployed to staging at version 17; migrations `0004`
and `0005` applied on boot. `flyctl secrets list -a research-companion-staging` shows every other
secret present and this one absent.

Until it is set, `supabase_admin.configured()` is False and `account_deletion.request()` refuses
**before** writing a tombstone, so a tap on "Permanently delete account" returns 503 and nothing is
deleted. That refusal is a designed path and is worth exercising on the device — the client should
clear its local deletion marker and say the server is not configured — but it is not the
Play-required deletion path, and the Data safety form cannot truthfully claim deletion works until
the disposable-account run above has passed.

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
