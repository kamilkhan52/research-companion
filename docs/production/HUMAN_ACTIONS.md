# Human actions

Things **only Kamil** can do — account ownership, legal attestations, financial setup, and
decisions with money or legal consequence. Agents must not attempt these, and must not work around
them with browser automation.

Format: each action states what to do, why an agent can't, which milestone it blocks, and **what to
report back** so the agent can continue.

Status: `todo` / `done` / `n/a`. Keep this file current — it is the handoff surface between you and
every agent session.

---

## What is actually waiting on Kamil, as of 2026-08-09

Everything in this short list blocks the closed track. Everything below it in this file is either
done or a later milestone. Read this before the H-numbered sections.

1. **His own sign-off on the app.** Device feedback is now tracked per item in
   [`../device-review-ledger.md`](../device-review-ledger.md) — every row there that is not `closed`
   is waiting on him, and merging never closes one. Testers are gated on this, and correctly so.
2. **H13 — Data safety answers** in Play Console. `02-security-and-privacy.md` holds the
   code-derived inventory the answers must match, and the published policy must match both.
3. **The Firecrawl key.** Set on production 2026-07-29 via in-app Settings, which is the right
   route for him: he is in `RC_OPERATOR_USERS`, and it takes effect with no machine restart and so
   cannot kill an in-flight job. `FIRECRAWL_API_KEY` as a Fly secret also works but restarts the
   machine. **Parallel was removed entirely** (PR #290) — its account was out of credit, and its
   key being present was measurably worse than no key, because the keyless anonymous tier works.
4. **Web search is now Firecrawl, then keyless DuckDuckGo.** Decided 2026-07-29: one clean
   method, on the plan Kamil already pays for. Note the research memo recommended the opposite
   (Parallel over Firecrawl) on result shape — see PR #290 if tool-round counts become a problem.

**Not blocking, but decided and worth not re-litigating:** the AAB should NOT be rushed — see the
correction under "Then the AAB and the closed track" in `10-roadmap.md`. Uploading early freezes the
Android package name and banks no tester-clock time.

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

**Superseded 2026-07-29 — a domain WAS needed, for a reason this paragraph did not anticipate.**
The claim below is correct about the *origin*: `research-companion.fly.dev` is a real HTTPS origin
and suffices for Supabase redirects, Play's policy URLs, reviewer access, and the closed test. What
it missed is EMAIL. Supabase's built-in mail service only delivers to project team members, so
custom SMTP is required before any tester can sign in — and every SMTP provider needs a verified
sending domain. `scholiast.io` was bought for that (H25/H2b). Original text follows.

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

### H28 — The production database password contains `@`, so nothing reaches Postgres · ✅ `DONE 2026-07-29`
**Resolved.** Kamil rotated the password and re-set the secret; the machine restarted and connected
on the next boot. Verified from the logs and then independently against the live schema:

- `db: pool opened on db.aumedoefxacycwfrlcml.supabase.co:5432/postgres`
- all six migrations applied in order, `0001_ownership.sql` … `0006_content_reports.sql`
- `data-api lockout asserted on 7/7 table(s)` — and, checked directly against `pg_class` and
  `information_schema.role_table_grants` rather than trusting that log line: **7 `rc_*` tables, all
  with RLS enabled, 0 policies, and 0 `anon`/`authenticated` grants**, which is exactly the P0-18
  end state. PostgreSQL 17.6.
- the deploy guard acquired at boot (its failure path logs; success is silent)

`OPENAI_API_KEY` is now set too, so narration has a key.

Original diagnosis follows, because the ambiguity is a property of the URL format and will recur
for anyone who generates a password containing `@`.

Production deployed cleanly on 2026-07-29 and then refused to connect to Postgres. `app/db.py`
caught it at boot and kept serving rather than crash-looping (deliberate — a refusal to start is a
crash loop on Fly), logging on repeat:

> `RC_DATABASE_URL is ambiguous: the URL parser and libpq read a different host, port or database
> from it.`

**This is not a bug in the URL you pasted; it is a genuine ambiguity in the URL format.** The two
parsers split the authority on different `@` characters — `urlsplit` uses the LAST one, libpq the
FIRST — so a password containing a literal `@` sends them to different hosts. Confirmed on the
machine: `urlsplit` reads host `db.aumedoefxacycwfrlcml.supabase.co`, libpq reads host
`52@db.aumedoefxacycwfrlcml.supabase.co`. The guard exists precisely so this fails loudly instead
of connecting somewhere unintended.

**Fix — rotate the password rather than escaping it.** Percent-encoding the `@` as `%40` would also
work, but Supabase → Settings → Database → **Reset database password**, generating one with no
`@ / ? # :`, is less error-prone and moots the incidental disclosure below. Then re-set the secret
with the *direct* connection (port 5432, never 6543):

```
flyctl secrets set -a research-companion RC_DATABASE_URL='postgresql://...'
```

Single-quote it in the shell so no character is expanded, and re-set nothing else — `flyctl secrets
set` replaces only the names you pass.

**Incidental disclosure, why the rotation is the recommended fix:** diagnosing this printed libpq's
misparsed *host*, which necessarily contained the two password characters preceding the `@`. Three
characters of the old password are therefore in an agent transcript. That is not an exploitable
leak on its own, but the fix costs nothing extra, so rotate.

**Ordering — do NOT run H26's allowlist bootstrap until this is fixed.** With no database,
`tenancy.enabled()` is False and the app falls back to single-tenant behaviour where every project
is reachable. Signing in and creating projects in that state produces projects with **no ownership
rows**; once the database connects, an unowned project is reachable by nobody, which looks exactly
like data loss and needs `RC_ADOPT_OWNER` to undo. Fix the URL, confirm migrations ran, *then*
bootstrap the allowlist.

**Report back:** that the secret is re-set. I will redeploy, confirm the migrations run, and then
walk the allowlist bootstrap.

### H27 — Add the new deep-link scheme to Supabase, or sign-in breaks · ✅ `DONE 2026-07-29` — 2 minutes, BOTH projects
The rebrand changed `mobile/app.json`'s `"scheme"` from `researchcompanion` to `scholiast`, so the
OAuth/magic-link callback the app registers is now **`scholiast://auth`** instead of
`researchcompanion://auth`. Supabase only honours a redirect that is on its allowlist, and silently
redirects elsewhere if it is not — which looks exactly like sign-in doing nothing.

In **each** project (prod `aumedoefxacycwfrlcml`, staging `iqsiabkdbczvgyccswcy`) →
Authentication → URL Configuration → **Redirect URLs**, add `scholiast://auth`.

**Keep `researchcompanion://auth` there too** until no build using the old scheme is installed on
any device — including the one on Kamil's phone right now. Removing it early breaks the installed
app; leaving it costs nothing.
**Report back:** added on both.

### H26 — Production secrets, and the bootstrap order that avoids locking yourself out · ✅ `DONE 2026-07-29`
**Complete.** Secrets set, production deployed, and the allowlist bootstrapped. `RC_ALLOWED_USERS`
now holds **two** production accounts — `kaamilkhaan52@gmail.com`
(`481cd897-29f9-4368-9453-1ef9efaac407`) and `kamilkhan52@outlook.com`
(`b8f19707-4b13-4cbb-834a-93cd6d06f489`) — while `RC_OPERATOR_USERS` and `RC_ADOPT_OWNER` hold only
the first. Keeping the second account non-operator is deliberate: it is the only way to exercise the
operator-only routes (usage, covers) from the side a tester will actually see.

**The UUIDs came from the Supabase admin API, not from log-scraping.** `GET /auth/v1/admin/users`
with the service key lists ids and emails directly, which is both more reliable than catching a
`rejected non-allowlisted` line in a log buffer that only holds a few minutes, and does not depend
on the user attempting a sign-in first. Prefer it. Then verify the values *inside the running
process* — `auth.allowed_users()` / `auth.operator_users()` / `tenancy.adopt_owner()` over
`fly ssh console` — because `flyctl secrets list` shows only names, and a trailing newline or a
staging-era id looks identical there. That check is what the 2026-07-28 lockout lacked.

Confirmed empirically while doing it: `flyctl secrets set` replaces **per name**, so setting
`RC_ALLOWED_USERS` alone left `RC_OPERATOR_USERS` and `RC_ADOPT_OWNER` untouched. It is the value of
a single name that is replaced wholesale, not the secret set.

Original brief follows.

### H26 (original) — Production secrets and bootstrap order
**Status 2026-07-29:** all secrets set, and **production is deployed, serving, and connected to its
database** at `https://research-companion.fly.dev` (machine `822716c7e945d8`, `sjc`, volume
attached, 512 MB swap live, health check passing, `/legal/*` public, `/api/*` rejecting
unauthenticated callers, `/api/auth/config` correctly reporting the **production** Supabase project,
migrations applied, tenancy lockout verified against the live schema — see H28).

**All that remains of H26 is the allowlist bootstrap below**, which needs one sign-in attempt from
Kamil. `RC_ALLOWED_USERS` is currently the placeholder `bootstrap`, so the instance is deployed but
reachable by nobody — which is the correct state to be in while waiting.

**Use email + password for the bootstrap attempt, not the magic link.** Password sign-in returns a
session directly with no deep-link redirect, so it does not depend on which scheme the installed
build registers. Signing *up* on the production project will send a confirmation mail through
Resend, which incidentally gives H25 its first real end-to-end delivery test. The installed dev
build predates the rebrand and still registers `researchcompanion://auth`; that is allowlisted in
Supabase alongside the new scheme, so OAuth would work too.

Point the app at production first: **Settings → server URL → `https://research-companion.fly.dev`**
(it overrides `app.json`'s `extra.apiBaseUrl`, which is the tailnet address).

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

**Not a blocker, but audio is dead until it is set:** there is no `OPENAI_API_KEY` on production (nor
on staging). `app/tts.py` reads `openai_api_key`, which `config.py` seeds from that environment
variable, so narration will fail until it exists. It is an *operator* setting, so it can equally be
entered once in the app's Settings screen after sign-in — which keeps it out of both the repo and
this file. Decide which; just do not discover it during the tester round.

**Report back:** that secrets are set, and I will deploy and verify.

### H25 — Custom SMTP · ✅ `DONE 2026-07-29` — was the top M2.5 blocker
**Confirmed delivering in production 2026-07-29.** Resend's own send log is the evidence, and it is
the place to look first whenever "the email did not arrive":

```
GET https://api.resend.com/emails   (Authorization: Bearer <key from ~/.resend-key>)
```

It showed both a Supabase invitation and an app sign-up **"Confirm your email address"** to a fresh
address, each `last_event: delivered`, from `"Kamil Khan" <team@scholiast.io>`. So the app's own
sign-up mail path works end to end, not just the dashboard's invite button.

That log is also what proved the sign-up failure below was **not** a delivery problem: the address
that "never got an email" has no entry at all, because no message was ever handed to Resend.

**Resolved.** `scholiast.io` registered at Cloudflare Registrar (Cloudflare nameservers), Resend
free tier verified for sending, and the Resend↔Supabase integration connected on the **production**
project with sender `team@scholiast.io`. Records live and resolving publicly:

| Record | Name | Purpose |
|---|---|---|
| TXT | `resend._domainkey.scholiast.io` | DKIM — signs as the apex, so DMARC aligns |
| TXT | `send.scholiast.io` | SPF for the bounce/return-path |
| MX | `send.scholiast.io` | bounce handling |
| TXT | `_dmarc.scholiast.io` | `v=DMARC1; p=none` — added by the agent |

Resend's own layout turned out better than the plan: DKIM on the apex gives alignment while SPF/MX
sit on a `send.` subdomain, so the sender reads `team@scholiast.io` AND the apex SPF slot stays
free for a future mailbox provider. There is only ever ONE SPF record per name, so that matters.

DMARC is `p=none` (observe-only) deliberately — tighten to `quarantine` after watching real
delivery. No `rua` report address: sending reports to an address at another domain needs
authorisation at that domain, which we cannot set.

**Staging is deliberately left on Supabase's built-in email.** Kamil is a project team member,
which is the one case the built-in service does deliver to, so staging keeps working without
consuming the free tier's single-domain slot.

Credentials, never in the repo: Cloudflare DNS-edit token (single zone) at `~/.cloudflare-token`,
Resend key at `~/.resend-key`. Zone id `239faeab9fbd56a4404a0477af4826db`.
**Gotcha for future sessions:** Cloudflare's `/user/tokens/verify` answers "Invalid API Token" for a
correctly-narrow token, because it needs a `User → API Tokens → Read` permission such a token should
NOT have. Test against the zone endpoint instead; the verify endpoint is a misleading health check.

*Original problem statement follows, kept because the lesson generalises.*

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

### H2b — Custom domain · ✅ `DONE 2026-07-29` — `scholiast.io`
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

*Also worth knowing:* "Scholiast" is crowded commercially, so the Play **store listing name** may
need to differ from the internal codename. That is a launch-time decision, not a blocker now.
**DECIDED 2026-07-29: buy `scholiast.io` at Cloudflare Registrar, and rebrand the app to
Scholiast.** The domain is not only for email — it becomes the web app's origin too, which is why a
`.io` was accepted despite the ccTLD question (see the roadmap's step 3 for the full name-selection
reasoning, so it is not re-litigated).

**Cloudflare Registrar, for one decisive reason:** its API tokens can be scoped to
`Zone → DNS → Edit` on a single zone, so the credential handed to an agent is structurally incapable
of transferring or deleting the domain. Porkbun's key is an account key with a domain allowlist —
it can change nameservers and start a transfer. Namecheap still gates API access behind 20+ domains
or $50 on account and issues an account-wide key. Route 53 scopes well via IAM but costs ~80% more.
Cloudflare's "must use our nameservers" requirement is the point here, not a drawback: it guarantees
the zone lives where the scoped API reaches.

Kamil's steps: (1) create the account and **verify the email** — ICANN suspends domains that skip
it; (2) Domain Registration → Register Domains → buy `scholiast.io`, expect ~$35–45/yr at cost;
(3) My Profile → API Tokens → Create Token → "Edit zone DNS" template, narrowed to
`Include → Specific zone → scholiast.io`; **write the token to `~/.cloudflare-token` with
`umask 077` rather than pasting it into a chat**, and report only the Zone ID, which is not secret;
(4) resend.com → free account → Domains → Add Domain → `send.scholiast.io`; (5) Resend →
Integrations → **Connect to Supabase**, which writes the SMTP settings into Supabase directly.

The agent then creates SPF/DKIM/DMARC via the Cloudflare API, polls Resend until the domain reports
verified, and later points the apex at Fly with TLS. Use the `send.` subdomain, not the apex, so
auth-mail reputation stays separate from anything sent later.

**Report back:** the Zone ID, and that the token file exists.

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
the app's `scholiast` scheme — that flow uses the Web client. An Android client is only
required for the *native* Google ID-token flow. If one is ever created it needs package name
`io.scholiast.app` (read it from `mobile/app.json`) and the SHA-1 from
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
Create the app listing for **`io.scholiast.app`** — the post-rebrand package in `mobile/app.json`,
not the `com.kamilkhan.researchcompanion` this file named before #272. **Play freezes the package
name on first upload**, so read it off `mobile/app.json` rather than from any document, including
this one. Accept the developer agreements, and
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

### H15 — Set tier limits and pricing · `todo — narrowed by M3`
The mechanism shipped: named plans (`tester`/`free`/`basic` in `app/plans.py`), a credit pegged at
$0.001 of metered variable cost, per-operation maximums in `app/spend_limits.py`, and a durable
reservation ledger that refuses at the ceiling. **What is still yours is the numbers**, which the
code carries as provisional defaults from `20-pricing-analysis.md` rather than as decisions.

One plan applies per DEPLOYMENT today, not per account; `plans.for_user` is shaped for the per-account
lookup M4's entitlements make real, so revising values is a config change and not a migration.
**Report back:** free allowance, Basic allowance, the hard ceiling per user, and behaviour at the
limit (today: refuse, with a soft warning at 80%).

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
