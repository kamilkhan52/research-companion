# Production launch roadmap

*Written 2026-07-24 against `origin/main` @ `e5fe869`. Evidence base: `00-current-state-audit.md`.
This is the execution ledger — update the Status column as milestones land, same convention as
`docs/product-roadmap.md` and `docs/round12-queue.md`.*

**Workflow per milestone:** branch → Opus implements → codex CLI review (GPT 5.6 Sol, high
reasoning) in `/loop` → fix findings → PR → merge. Milestones that change external billing
configuration, the production database, or store configuration need explicit human approval
before execution.

---

## Current position (updated 2026-07-28)

**M2's backend is complete.** M1 is code-complete (#218–#224); what remains of it is the production
Fly app + secrets, all of which needs Kamil. M2 then landed in five slices:

| PR | Slice | Status |
|---|---|---|
| #235 | 1 — `db.py` (pool, migration runner, DSN validation) + `tenancy.py`, recording ownership only | ✅ merged (`38ac21d`) |
| #236 | 2a — enforcement: `use_project` refuses a foreign project, cross-project routes filtered, operator-only usage/covers | ✅ merged (`95d54c2`) |
| #237 | 3 — job isolation pinned by test; audio ownership decision recorded | ✅ merged (`47d1972`) |
| #238 | 4 — settings split into operator-owned vs per-user; 5 — audio scoped per user; the Data API lockout (P0-18) | ✅ merged (`db90e1e`); 10 Sol rounds, 15 findings |

**What M2 actually closed:** P0-1 (every user saw every project), P1-2 (unauthorized job endpoints,
audio included), the cross-user halves of P1-1 and P1-14 (audio as a read channel), and P0-18 — a
finding made *during* the work: the ownership tables were reachable from the published anon key,
with `rc_projects.owner_id` writable, which is a full takeover of another person's reading list.

**Staging M2 rollout completed 2026-07-27.** `RC_DATABASE_URL` uses the staging Supabase direct
connection, `RC_ADOPT_OWNER` matches the allowed/operator user, and the merged M2 code is deployed.
All six pre-tenancy projects were adopted under that owner; an immediate second run adopted zero
and reported all six already owned. The deployed schema has all four `rc_*` tables under RLS with
no `anon` or `authenticated` table grants, and unauthenticated `/api/projects` returns 401.

The rollout found and fixed a production-image gap: `app.db` resolves migrations from
`/srv/supabase/migrations`, and the runbook invokes `/srv/scripts/adopt_projects.py`, but the image
contained neither. Commit `7fa07ba` adds both runtime payloads and a source-level packaging
regression test. Without it, a database-configured machine health-checked successfully while
running against an empty schema.

**Next production gate:** M2.5's account deletion is now cheap on the backend side — a user's audio
and narration cache is one directory. Recoverable project trash now retains an exact,
non-authorizing directory-to-owner link; a transition trigger protects old-worker deletes and the
adoption script repairs only unambiguous or explicitly mapped legacy trash. The remaining
project-content work is the permanent, retryable deletion coordinator.

**M2.5 compliance inventory started 2026-07-28.** The code-derived storage/processor inventory and
provisional Play Data Safety matrix now live in
[`02-security-and-privacy.md`](02-security-and-privacy.md). It found two declaration blockers that
must be fixed rather than hidden in policy prose. The first is now code-complete: ordinary project
deletion clears the live owner but preserves the exact `.trash` incarnation and former owner, while
ambiguous legacy directories require explicit operator mapping. The remaining declaration blocker
is that the current mobile source still defaults to an `http://` tailnet URL while backend retrieval
also permits public `http://` URLs, so “all data encrypted in transit” must wait for an AAB pinned
to the production HTTPS origin and HTTPS-only user/agent-selected fetches.

~~Client wiring for per-user settings~~ — done (#240): both clients now separate `is_operator` (the
provider keys) from `can_edit_preferences` (model/voice/prior-notes). ~~Staging Supabase Site URL /
redirect~~ — was already configured; the item was stale. Google OAuth on the *staging* project (H5
step 5) is the one auth piece that may still be unconfigured there, and magic link works without it.

Not in M2 and still open: P0-17 (`DeliveryReq.model` bypasses settings entirely, so per-user model
preferences do not bound spend — that is M3's tier check), and audio cache eviction, which per-user
copies make *more* pressing rather than less.

M1's PRs, for reference:

| PR | Scope | Status |
|---|---|---|
| #218 | Dockerfile, `.dockerignore`, `fly.toml`, `fly.staging.toml`, staging deploy | ✅ merged to `main` |
| #219 | `RC_ENV` gating, auth hard-fail, user allowlist | ✅ merged to `main` (`9cace9f`) |
| #220 | Hardened outbound-fetch helper — `app/safe_fetch.py` (P0-14) | ✅ merged to `main` (`8e2d5d1`); 16 Sol rounds, 31 defects fixed |
| #222 | Operator role — instance-wide settings + prompts restricted to `RC_OPERATOR_USERS` (P0-2, P0-3) | ✅ merged to `main` (`a291edd`); 2 Sol rounds |
| #223 | Client half of the operator role — both clients key off `is_operator` (P1-15) | ✅ merged to `main` (`07b7f23`); Sol clean first round |
| #224 | API-36 spike — already 36, no change (P2-4) | ✅ merged to `main` (`a18cd6f`); Sol verified the chain |

**M1 is code-complete. Everything left in it needs Kamil** — see `HUMAN_ACTIONS.md`. Nothing further
can be built on this milestone without a payment method on Fly, a named operator id, and the
Supabase projects.

**#220 is worth reading the commit history of.** Thirty-one defects across sixteen review rounds,
and essentially all of them were in the fix rather than in the code it replaced. Three patterns, all
worth carrying into M2:

1. *Fixing a class of bug one layer down from where it was fixed.* Unvalidated redirects were closed
   in `safe_fetch`, then reintroduced in a hand-rolled arXiv streamer. Silent truncation was closed
   for multi-member gzip, then reappeared for truncated streams and again for close-delimited EOF.
   The lesson that stuck: route through the one guarded path instead of writing a second one.
2. *Tests that pass for the wrong reason.* A decompression-bomb test passed while 200MB was
   allocated; a memory test gzipped compressible data so the buffer it measured was free; a deadline
   test asserted an error that fired either way. Each looked green. The habit that caught them is
   reverting the fix and requiring the test to go red — and verifying the revert actually applied.
3. *Absence is invisible to a green suite.* A regex cleanup silently deleted 27 tests, including
   every SSRF regression test, and the suite stayed green for two commits under a section header
   with nothing beneath it. Bulk edits to tests now get a before/after count.

The decoder that caused most of this was ultimately **deleted** rather than bounded a fifth time:
the client sends `Accept-Encoding: identity` and refuses any content coding unread.

**Review note on #219:** it had one Sol round (applied as `04bc9c6`) plus a self-review pass, not
two Sol rounds — codex was in a provider-wide 503 outage (`biscuit_baker_service_me_circuit_open`)
and the loop's fallback reviewers run as subagents, which are not spawned unprompted. The
self-review found three real issues (duplicated `RC_DEV` truthiness rule between
`auth.assert_environment_safe` and `config.dev_mode`, a stale "Default dev" claim in
`.env.example`, and a `setdefault` in `conftest.py` that let a developer's shell break the suite).
If codex recovers, re-running a round against `main` costs nothing.

**Live:** `research-companion-staging.fly.dev` — `RC_ENV=staging`, Supabase auth enforcing,
allowlist = Kamil's UUID only, **no provider API keys** (so nothing can spend). Volume `rc_data_staging`
(3 GB, `dfw`) mounted at `/data`; `/api/health` returns `dev:false`; `/api/projects` 401 unauthenticated.

**Production Fly app `research-companion` exists but has never been deployed** and has no volume.

**API-36 spike: done 2026-07-25 — nothing to change.** Expo SDK 56 / RN 0.85.3 already resolves
`targetSdkVersion` to **36** (via RN's `gradle/libs.versions.toml`, not the plugin's 35 fallback),
so the Play requirement effective 2026-08-31 is met with no `expo-build-properties` override. Left
unpinned on purpose — the requirement is a floor ("36 or higher"), and a pin would hold the app at
36 when a later Expo SDK raises it. Reproducibility does not depend on the pin: `package-lock.json`
already fixes RN at 0.85.3, so the catalog that supplies the 36 is itself locked. Full chain
recorded as P2-4 in the audit.

**Not yet started in M1:** the production app + secrets. Data migration and client cutover are deliberately *out* of M1 — see M1's
"Rollback" section for why they are gated on M2 and M6.

**Operational notes for whoever picks this up:**
- `flyctl` is installed and authenticated on the dev Mac. Deploy with
  `flyctl deploy -c fly.staging.toml --remote-only --yes` — the local Docker daemon is not running,
  so builds must be remote.
- Sol reviews: `codex exec --sandbox read-only - < <instructions>.md`, **run from the repo root**
  (codex refuses elsewhere). `codex exec review --base main` cannot take a custom prompt, so the
  instructions tell it to diff against `main` itself.
- A deploy stops the machine and kills in-flight jobs — check for active jobs first.

**Answered by Kamil 2026-07-25 (all four):**

1. **`RC_OPERATOR_USERS` is set on staging.** ✅ Prompt and settings editing now work for the named
   operator and 403 for everyone else.
2. **Monthly spend ceiling: $200.** This is the number M3's per-user caps get sized against — see
   "Sizing M3 against the $200 ceiling" below.
3. **TTS model: `tts-1`** (H22 revised). Halves the single largest variable cost. `tts-1-hd` stays
   selectable.
4. **Supabase: two Free projects, $0 — Pro not needed yet.** ✅ A separate staging project
   (`iqsiabkdbczvgyccswcy`) was created 2026-07-25, so production (`aumedoefxacycwfrlcml`) no longer
   doubles as staging. This closes a compromise that had rested on my own unverified claim that the
   account was at the 2-project cap; it was not. Free allows **2 active projects**, pauses one after
   **1 week of inactivity**, and has **no automatic backups**; Pro is **$25/mo**. **Pro becomes right
   at M6**, whose gate is exactly "automated backups and a tested restore" — and the content record
   lives in **git**, not Postgres, so what Pro protects is the ownership/index tables, not the papers
   or notes. Staging's JWKS was verified to return an ES256 key before anything pointed at it.

   **Consequence to sequence carefully:** Supabase user ids are per project, so repointing staging
   invalidates `RC_ALLOWED_USERS` / `RC_OPERATOR_USERS`. See H4 for the four-step bootstrap; the
   middleware now logs the rejected id so `flyctl logs` answers it without the dashboard.

**Fly payment method: added.** ✅ The production app + volume is unblocked.

**Staging is fully wired (2026-07-26).** Its own Supabase project (`iqsiabkdbczvgyccswcy`), Site URL
and Redirect URLs configured — including `researchcompanion://auth` for the mobile scheme — Google
provider enabled, and `RC_ALLOWED_USERS` / `RC_OPERATOR_USERS` set to Kamil's staging UUID. Mobile
authentication shipped in #228, so the Android app can now talk to staging: **P0-15 is closed and
M2's hard ordering constraint is satisfied.**

#### Sizing M3 against the $200 ceiling

$200/month is the total spend ceiling (Kamil, 2026-07-25). Fixed cost is **$25.86** (Fly prod
$14.24 + 20 GB volume $3.00, staging $7.12 + volume $1.50, Supabase Free $0), leaving **$174/month
of variable budget**. Against `20-pricing-analysis.md`'s unit costs — $0.14/free-user-month,
$2.22/Basic-user-month, $8.40 net revenue per Basic after Play's 15%:

| Mix | Users the ceiling supports | Variable spend | Revenue there |
|---|---|---:|---:|
| All free | 1,243 free users | $174.02 | $0 |
| 10:1 free\:paid | 48 paying + 480 free | $173.76 | $403 |
| 20:1 free\:paid | 34 paying + 680 free | $170.68 | $286 |
| All paid | 78 Basic subscribers | $173.16 | $655 |

Counts are floored to whole users and the spend column is computed from those same counts, so
every row actually fits under $174.14. (Rounding the 20:1 row *up* to 34.7 → 35 paying and 693.8 →
694 free would put it at $174.86 — over the ceiling, which is exactly the kind of quiet overshoot a
capacity table should not print.) Revenue is the floored subscriber count × $8.40.

**The ceiling is not the binding constraint at any realistic launch scale**, and in every mixed
scenario revenue passes $200 well before spend does. The closed test costs
**$1.68/month of variable spend** (12 testers × $0.14) on top of fixed — i.e. the whole M2.5 tester
phase runs at roughly $28/month.

Two things follow for M3, and they are the actual work:

1. **$200 must be enforced at the provider, not just in-app.** The in-app per-user cap stops one
   user burning everyone's budget; it does nothing if a bug loops. Set the OpenRouter credit limit
   and the OpenAI spend limit to sum to $200 in *enforcing* mode (H20). That is the only layer that
   holds when our own accounting is the thing that broke.
2. **The per-user cap is sized from the mix, not from $200.** $174 ÷ the free allowance is 1,240
   users; the cap that matters is the one making a *single* user's worst case bounded — which
   `20-pricing-analysis.md` §6 identifies as premium TTS minutes, the only line with no natural
   ceiling. Enforce minutes server-side before synthesis, since `tts-1`'s character pricing makes
   the cost of a dispatch exactly knowable before making it.

**Decided/closed since the last revision:** OpenRouter key on staging; OAuth consent screen
published; H6 (operator gating, #222/#223 — closes P0-2 and P0-3); H22 (revised to `tts-1`); the
API-36 spike (#224, already 36); testers deliberately deferred until the app is testable, which
makes Play's 12-testers/14-continuous-days clock strictly additive after M2.5 rather than parallel
with M2.

**Pricing is now analysed, not assumed** — see `20-pricing-analysis.md`. Free = 15 turns on
DeepSeek V4 Flash with `BrowserTTS` (~$0.14/user-month worst case); Basic $10 = 60 turns + 45 min
of `tts-1` (74% gross margin after Play's 15%, break-even ~5 paying users). The four findings that
reshape M3 are recorded as **P0-16, P0-17, P1-12, P1-13, P1-14** in the audit: audio is unmetered
and is the biggest cost line, nothing pins the model server-side, provider routing is unpinned at
~2.45x list, `listening_preview` burns 17.3 calls per turn, and the audio cache never evicts.


---

## Locked decisions

Settled 2026-07-24 with the product owner. These are the assumptions the whole sequence rests on;
revisiting one invalidates the milestones downstream of it.

| Decision | Choice | Reversibility |
|---|---|---|
| Production backend hosting | **VPS/container with a persistent volume** (Fly.io, Railway, or Hetzner + Docker). FastAPI and git-on-disk stay intact; single worker still holds. | Reversible — it's a Dockerfile and a deploy target. |
| Per-user data isolation | **Postgres for ownership/index, git for content.** A small Postgres (Supabase) holds users, project ownership, usage events, entitlements, and abuse reports. Project content stays markdown-in-git. | Partially — the schema is easy to change, the git layout less so. Decide the on-disk namespacing once (M2). |
| Commercial model | **Subscription with hard per-user budget caps.** RevenueCat + Google Play Billing; Free tier with a small included allowance; Pro monthly/annual. Caps are non-negotiable given the marginal cost profile. | Pricing is reversible; the metering architecture it requires is not wasted either way. |

**Scope note (honest):** M1–M11 is several months of solo work, not weeks. The critical path to a
*published* app is M1 → M2 → M2.5 → M3 → M7 → M8 → M9 → M10. M4/M5 (money) can be resequenced if
you'd rather get a free closed beta into Play first and monetize against real usage data — say so
and I'll re-cut the order. M6 (durability) is no longer freely movable: it now depends on M3,
because interrupted jobs and orphaned quota reservations are the same event and must be reconciled
against the same records.

**Calendar dependency, confirmed 2026-07-25:** the Play account is Personal and created 2026-07,
so Google's closed-testing requirement **applies** — 12 testers opted in for 14 continuous days,
then production-access review of up to 7 days. That ~3-week clock cannot start until a working
build is on a closed track, so **M2.5 exists to start it as early as is legal and safe** and let it
run in the background during M3–M8. It sits after tenancy (M2) and carries a compliance slice,
because closed tracks require a Data safety form and privacy policy and because 12 external testers
must not share one untenanted backend — see M2.5 for the verification. Recruiting testers (H16) is
the pacing item; start recruiting *during* M2 so they are ready the day M2.5 lands.

---

## Architectural rules for this work

These exist because the milestones below touch code whose invariants are load-bearing. `CLAUDE.md`
gets updated as each lands.

1. **Postgres access never enters the deterministic spine.** Invariant 3 says `app/store.py` makes
   no network calls; that now also means no database calls. Tenancy and metering live in new
   modules (`app/db.py`, `app/tenancy.py`, `app/metering.py`) called from routers and dependencies,
   never from `store.py` / `sessions.py` / `committer.py`.
2. **The scope key is the composite `(user_uuid, pid)` — everywhere, not just a contextvar.**
   A user contextvar alone is not enough, because today's in-memory keys are `pid`-only: job
   ownership and dedup (`jobs.py:142`), the deleting/busy tombstone sets and the per-project RW
   locks (`config.py:157`), and the paper-identity locks. Two users will both plausibly have a
   project called `default`, so pid-only keys let one join, poll, or cancel the other's job — and
   let one user's split/delete tombstone block the other's — even though their files sit in
   separate directories. Define one canonical composite scope and use it for job keys, locks,
   tombstones, caches, and path resolution alike. Isolation tests must deliberately give both
   users the *same* pid and slug and run jobs concurrently.
3. **Carry that scope into *every* worker, not just `JobRegistry`.** Extending the registry is
   necessary but insufficient: several paid paths spawn their own threads and executors and
   manually rebind only the project — `graph.py:257` (extraction executor), `graph.py:1515`
   (reference fan-out), `affiliations.py:157` (deadline worker). Each would drop the user and
   misattribute spend. Introduce one captured-execution-scope helper carrying both user and
   project, and migrate every `Thread`, `ThreadPoolExecutor.submit`, and orphan-worker site.
   Test attribution *through* a real nested graph/affiliation worker, not just through the registry.
4. **Isolate on the filesystem *and* with mandatory owner-filtered queries.** Namespace the
   projects root per user (`PROJECTS_ROOT/<user_uuid>/<pid>`) *and* scope every query by owner.
   This extends the `_safe_pid` trust boundary to two segments — treat it as security-critical.
   **Do not count RLS as a backend safety net:** the backend connects with a Supabase service
   credential, which *bypasses* RLS, so RLS cannot catch a route that forgets its owner predicate.
   Enable RLS anyway — it protects direct Data API access — but backend isolation rests entirely
   on owner-filtered queries plus filesystem namespacing. If a genuine second layer is wanted, use
   the user's JWT (a non-bypass role) for user-scoped operations.
5. **Quota enforcement is a pre-spend *reservation*, not post-hoc metering.** Best-effort
   accounting after the fact cannot enforce a ceiling — concurrent jobs all pass a
   historical-total check before any of their records land, and metering is explicitly forbidden
   from failing a turn. These are separate mechanisms: **enforcement** atomically reserves a
   pessimistic maximum cost (including in-flight reservations) in Postgres before job admission
   and settles to actual cost afterward, failing *closed* for paid work if the quota store is
   unavailable; **analytics** stays best-effort and never fails a turn. Entitlement checks are
   server-side and precede spend; the client is never the authority. Reservations are durable
   records with leases and idempotent startup reconciliation (see M3) — an in-memory reservation
   table would evaporate on the restarts invariant 6 makes routine. And "before spend" means
   *every* spend path, not just LLM jobs: TTS is currently unmetered entirely (P0-13).
6. **Single uvicorn worker still holds** (invariant 6). Postgres does not change this — job state
   is still in-memory until M6. Do not add `--workers N`. Note this interacts with rule 5: an
   in-process reservation table would be lost on restart, which is why reservations live in
   Postgres rather than memory.

---

## Milestones

| # | Milestone | Depends on | Complexity | Status |
|---|---|---|---|---|
| M1 | Hosting, environments, and secrets | — | L | **code-complete** (#218–#224 merged); the rest needs Kamil — see `HUMAN_ACTIONS.md` |
| M2 | Identity, tenancy, and per-user isolation | M1 | L | **staging rollout complete** — backend #235–#238, client #240, database migrations + six-project adoption verified |
| M2.5 | Closed-track compliance minimum (incl. account deletion) + first build — starts the 14-day tester clock | M1, M2 | L | **in progress** — code-derived inventory and declaration draft written; deletion/report/policy/build remain |
| M3 | Metering, quotas, and abuse controls | M2, M2.5 | L | queued |
| M4 | RevenueCat foundation | M2 | M | queued |
| M5 | Subscription-backed access | M3, M4 | M | queued |
| M6 | Durability — job persistence and backups | M1, M3 | M | queued |
| M7 | Remaining compliance, safety, and legal surfaces | M2, M2.5 | M | queued |
| M8 | Observability and operator tooling | M1 | M | queued |
| M9 | Android release automation | M1, M7 | M | queued |
| M10 | Launch rehearsal | all | M | queued |
| M11 | Production release | M10 | S | queued |

---

### M1 — Hosting, environments, and secrets

**Objective.** Move production off the home Mac mini onto a reproducible container deployment with
a real domain, TLS, a persistent volume, and a staging environment.

**Rationale.** Blocks everything. Supabase auth redirect URLs, the Play-required account-deletion
web page, Play reviewer access, and any uptime claim all need a stable public HTTPS origin. It is
also the last cheap moment to introduce environment separation.

**Scope.** Dockerfile for the FastAPI app (including the `web/dist` static mount). Persistent
volume for `PROJECTS_ROOT` and `.app-state/`. Deploy config for staging + production. Domain, TLS,
process supervision and restart policy. Environment-aware config (`RC_ENV` ∈ dev|staging|prod) that
makes `RC_DEV` and `RC_AUTH_TOKEN` **impossible** to enable in prod, not merely unset.

**Critically (P0-12): prod must refuse to start unless `auth.mode() == "supabase"`.** Forbidding
the dev switches is not sufficient — `auth.mode()` returns `open` when *no* auth env is set, so the
dangerous state is missing config, not present config, and a deploy that forgets one variable
serves the whole API to the internet with no error. Fail loudly at startup instead. This pulls H4
(create the Supabase projects) forward from M2 into M1's prerequisites.

**Equally critical: authentication alone is not access control here.** Supabase Email/Google
sign-in is *self-service* — anyone can create an account — and until M2 lands, any authenticated
user gets the whole single-tenant instance: every project, and `POST /api/settings` / `POST
/api/prompts` over the shared provider keys and system prompts (P0-1/2/3). Deploying M1 publicly
with auth "on" would therefore hand the instance to the first stranger who signs up. M1 must ship a
**temporary allowlist of permitted user UUIDs** (or disable public signup) enforced in the auth
middleware, and keep it until M2's ownership enforcement replaces it. Test that a valid-but-not-
allowlisted JWT gets 403, not 200.

**Close P0-14 before the service is internet-reachable.** `retriever._fetch` follows redirects to a
caller-supplied `pdf_url` and buffers the whole body, with no IP validation and no byte cap — so an
authenticated user can reach the host's internal network and metadata endpoints, or OOM the single
worker (a full outage, invariant 6). On a home Mac mini behind Tailscale this was low-stakes; on a
cloud host it is not.

**Do not simply reuse `_assert_public_url` — it does not close this.** `docs/improvements.md` §7.6
already documents the gap: the helper resolves the host with `getaddrinfo`, checks those IPs, and
then httpx **re-resolves** for the actual connection, leaving a DNS-rebinding window where an
attacker-controlled hostname resolves publicly during validation and privately during the fetch.
Validating every redirect hop does not close it either. M1 must **pin the validated address** (a
custom transport that connects to the checked IP) or verify the connected peer before the response
is read. Stream the download with a byte ceiling instead of `.content`, reusing the 40 MB limit the
upload path already enforces. M1's allowlist limits exposure to trusted users until M2.5, but this
is cheap enough that it should not wait.

**Fix every outbound-fetch path in M1, not just this one.** Deferring the sweep to M3 would leave
holes open through M1 and the entire M2.5 closed test. There are four, each broken differently:

| Path | Address validation | Memory ceiling |
|---|---|---|
| `retriever._fetch` (`retriever.py:173`) | none | none — buffers `.content` |
| `retrieval_agent.fetch_pdf` (`retrieval_agent.py:31`) | validates, then httpx re-resolves (rebinding) | none — buffers `.content` in full, *then* slices to `HUNT_MAX_PDF_BYTES` |
| `cover_jobs._download_pdf` (`cover_jobs.py:82`) | none, and follows redirects | correct already — streams with a cap |
| `research_tools._direct_fetch` | rebinding gap (§7.6) | n/a |

So the work is: one pinned-address, redirect-validating, streaming-with-ceiling fetch helper, and
every one of these four migrated onto it. `cover_jobs` already shows the right streaming shape to
generalize from.

Secrets move to the platform's secret store; `.env` stays dev-only. Client points at the new origin via
`app.json` `extra.apiBaseUrl` with staging/production variants. Early spike: verify Expo SDK 56's
Android `targetSdkVersion` against the API 36 requirement (cheap now, expensive to discover at M9).

**Files/services.** New `Dockerfile`, `.dockerignore`, deploy manifest; `app/config.py`
(environment gating); `app/main.py`; `run.sh`; `mobile/app.json`; `.env.example`; new
`docs/production/01-architecture.md`.

**Risks.** Tailscale-based device testing changes shape — keep the tailnet path working for local
dev so the loop in `CLAUDE.md` survives. PyMuPDF/pypdf need correct base-image wheels. Git must
work inside the container (identity is already pinned, so this should be clean).

**Tests.** Container builds and serves `/api/health`. Volume survives a restart with projects
intact. A prod-mode boot with `RC_DEV=1` and `RC_AUTH_TOKEN` set refuses to enable either, **and a
prod-mode boot with no Supabase config fails to start at all**, **and a valid JWT for a
non-allowlisted user is rejected with 403** — assert all three in `tests/`. **P0-14: a `pdf_url`
pointing at a private address is refused; a redirect *into* a private address is refused; a
hostname that resolves public-then-private across the two lookups is refused (the rebinding case —
fake the resolver so the second answer differs from the first); and a response exceeding the byte
ceiling is aborted mid-stream rather than buffered.** Existing suite green in-container.

**Manual.** Deploy staging, run the device checklist against it from the phone over the public
origin. Restart the service mid-job and confirm the failure mode is understood (it will lose the
job — that's M6, just document it).

**Rollback.** Mac mini keeps running unchanged until staging is proven; DNS/`apiBaseUrl` cutover is
the only switch, and it reverts.

**Production data migration and client cutover are explicitly NOT in M1** (established reviewing
PR #218). Both are gated on later milestones, and pretending otherwise is how the record gets lost:

- **M2** — the mobile client cannot authenticate at all (P0-15), so pointing it at an
  auth-enforcing production would simply break it.
- **M6** — a Fly volume is a *single unreplicated copy*, and Fly's own guidance is explicit that
  daily volume snapshots are not a primary backup. Migrating the git-backed record onto one volume
  with no off-host backup turns a host failure into a data-loss event. Production must not become
  the authoritative copy until M6's automated backups **and a tested restore** exist.

Until both land, the Mac mini stays authoritative and Fly is a proving ground.

**Done when.** Staging and production both reachable over HTTPS on a real domain, restart-safe,
volume-backed, secrets out of the repo, prod provably refusing dev bypasses, API-36 answer recorded.

**Human actions.** H1 (Actions billing) ✅ and H2 (Fly account) ✅ are done. **All four of these
block the deploy:**
- add a payment method to Fly (persistent volumes are not in the free allowance);
- **H4** — create the production and staging Supabase projects, pulled forward from M2 because prod
  now refuses to boot without Supabase auth configured;
- **H20** — set the OpenRouter key credit limit and the OpenAI Admin API spend limit in *enforcing*
  mode, before the instance is internet-reachable;
- **H21** — provide your Supabase user UUID for the temporary allowlist, without which the first
  stranger to sign up owns the pre-tenancy instance.

No domain purchase needed: `research-companion.fly.dev` ships with TLS (H2b defers a custom domain
to M10).

---

### M2 — Identity, tenancy, and per-user isolation

**Objective.** Make every piece of data owned by a user, and make cross-user access structurally
impossible.

**Rationale.** P0-1, P0-2, P0-3. Today any authenticated user reads and writes every project and
can rewrite the instance's API keys and system prompts. This is the largest single body of work and
everything commercial depends on it.

**Scope.** Introduce Postgres (Supabase project, migrations in `supabase/migrations/`, in source
control). Tables: `users` (mirroring auth UUIDs), `projects` (id, owner, timestamps), `usage_events`,
`entitlements`, `content_reports`, `deletion_requests`. RLS on everything exposed, plus server-side
ownership checks — the backend uses a service credential, so RLS is defense in depth, not the
primary control. Add `app/db.py` (connection/migration plumbing) and `app/tenancy.py` (ownership
resolution). Extend `use_project` to check ownership. Namespace `PROJECTS_ROOT` per user and extend
`_safe_pid`/`project_path` to two segments. Add an active-user contextvar and rebind it in
`JobRegistry` alongside the project. Split settings into **operator-owned** (API keys, prompts —
restricted to an operator role, closing P0-2/P0-3) and **per-user preferences** (model picks, voice,
`prior_notes_scope`). Authorize job endpoints by owner (P1-2). Backfill: adopt existing local
projects under your own user id.

**Build mobile authentication — it does not exist (P0-15).** The Android app has no Supabase
dependency, no sign-in screen, and no session handling; `setToken` has no caller, so a token can
never be set. Scope: add `@supabase/supabase-js`, a sign-in screen (magic link + Google), session
persistence in `expo-secure-store` (already a dependency), token refresh, sign-out, and the
OAuth redirect via `expo-web-browser` back through the app's `researchcompanion` scheme. Mirror
`web/src/components/AuthGate.tsx`, which already does this correctly for the web client.

**Hard ordering constraint:** M1 makes production refuse to boot without Supabase auth, so the
mobile `apiBaseUrl` cutover **cannot happen until this lands**. Until then the app keeps pointing
at the Mac mini. This is also why M2.5 depends on M2 — testers must be able to sign in.

**DECIDED 2026-07-26 (Kamil): scope audio jobs and the mp3 cache PER USER.** Each user gets their
own job and their own copy of the file. Chosen over the ACL-rows-over-shared-blobs alternative the
paragraph below recommends, and the reasoning is worth keeping: per-user caching still de-duplicates
a user's OWN repeat listens, which is the common case, so the cache-sharing loss only applies when
two different users narrate identical text — rare with different readers on different papers.
Against that, ownership becomes obvious, cancellation is trivially correct (the job is yours alone),
and M7 deletion is `rm -rf audio/<user_id>/` rather than reference counting. Revisit only if the
usage ledger shows real cross-user duplication.

**Audio needs an explicit redesign, not just an ownership check.** Audio jobs are deliberately
registered under the `None` project scope so identical narration requested from anywhere shares one
job (`audio_jobs.py:89`), cancellation therefore cancels *every* caller joined to that content, and
finished mp3s are served from an app-global content-hash route (`routers/audio.py:89`). None of
that acquires an owner just because a user contextvar exists, and M7 could not later delete one
user's audio. Pick one: scope jobs and cache references per user, or keep immutable
content-addressed blobs behind per-user ACL/reference rows with subscriber-aware cancellation (so
one subscriber leaving doesn't kill another's synthesis). The second preserves the cache-sharing
win and is the recommendation. Polling, media access, billing attribution, and deletion each need
tests.

**Files/services.** New `app/db.py`, `app/tenancy.py`, `supabase/migrations/`; `app/projects.py`,
`app/config.py`, `app/jobs.py`, `app/routers/settings.py`, `app/routers/projects_api.py`,
`app/routers/audio.py`, `app/main.py`; both clients' settings screens; **new mobile auth module +
sign-in screen, `mobile/package.json` (`@supabase/supabase-js`), `mobile/src/api/config.ts`.**

**Risks.** Highest-risk milestone. Touching `_safe_pid` and `project_path` is touching the trust
boundary. The contextvar rebind is the invariant that "silently reads/writes the wrong project's
files" when wrong — now with a user dimension. Mitigate with heavy tests before behavior changes.

**Tests.** Cross-user isolation: user A cannot read, write, list, split, delete, or job-poll user B's
project — one test per route family. **Give both users the identical pid (`default`) and the same
paper slug, and run their jobs concurrently** — this is the case pid-only keys get wrong (rule 2),
so a test that gives them different pids proves nothing. Path traversal via either segment.
Non-operator cannot POST settings or prompts. Scope correctness for both project *and* user inside
job threads **and inside the nested graph/affiliation workers** (rule 3). Audio: one user cannot
poll, cancel, or fetch another's narration, and cancellation by one subscriber does not kill
another's. Migration applies cleanly to an empty and a populated database.

**Manual.** Two accounts on staging; confirm complete invisibility in both directions.

**Rollback.** Ownership enforcement behind a flag defaulting on in staging first; migrations are
forward-only, so keep a database snapshot before applying.

**Done when.** Every `/api/*` route is owner-scoped, operator-only settings are enforced, isolation
tests pass, and existing projects are adopted under your user with no data loss.

**Human actions.** H4 (the Supabase projects) now lands in M1, since prod cannot boot without it —
what remains here is configuring Google OAuth credentials (already documented in `README.md`) and
deciding how the
operator role is assigned.

---

### M2.5 — Closed-track compliance minimum + first build (starts the 14-day tester clock)

**Objective.** Get a signed AAB onto a Play **closed** testing track as early as it can legally and
safely go there, because the tester clock is the longest calendar dependency in the plan and
should run in the background while M3–M8 proceed.

**Rationale, and why this is no longer "M1.5".** The first draft put this immediately after
hosting. Sol's review (PR #217) established that was wrong on two counts, both verified:

1. **Closed tracks are not exempt from compliance.** Only *internal* testing is exempt from the
   Data safety form — and internal testing does **not** satisfy the 12-tester requirement, which
   specifically requires a closed test. So a truthful Data safety declaration, a published privacy
   policy, and (for generative AI) an in-app content-report action are all prerequisites of the
   upload, not things to fix "if review objects."
   Verified 2026-07-25: [Data safety](https://support.google.com/googleplay/android-developer/answer/10787469)
   ("All developers that have an app published on Google Play must complete the Data safety form,
   including apps on closed, open, or production testing tracks"),
   [AI-generated content policy](https://support.google.com/googleplay/android-developer/answer/13985936).
2. **Shipping single-tenant to external testers is not acceptable.** The original text waved this
   through as "recruit people who are fine being a shared-instance beta." But 12 testers sharing
   one backend would see each other's reading projects and notes — and a Data safety form
   declaring that is either a disclosure of a privacy defect or a false statement. Tenancy (M2) is
   a hard prerequisite, not a nicety.

So this milestone now depends on M1 **and** M2, and carries the compliance slice itself.

**Scope, part 1 — compliance minimum.** The subset of M7 that the upload requires: a data
inventory derived from actual code and a truthful Data Safety draft (started in
[`02-security-and-privacy.md`](02-security-and-privacy.md)), a published privacy policy and
terms at public URLs, in-app links to both, and a working in-app report action for offensive
AI-generated content with somewhere for reports to land.

**Account deletion is in this set too** (round-2 correction). The app creates accounts, and
Google's policy — "if your app enables account creation, you must provide users with an in-app
path to delete their app accounts and associated data, *and* a web link resource where users can
request deletion" — states no exemption for testing tracks, while the Data safety form explicitly
asks about deletion. Declaring a deletion path that doesn't exist would make the form untruthful.
So M2.5 ships the real workflow: revoke the Supabase Auth identity, delete the user's Postgres
rows, remove their namespaced git content, drop their audio references, and delete their usage
events (retaining only what is documented as legally necessary). This is tractable precisely
because M2 has already established per-user namespacing and DB ownership — deletion becomes
"delete the rows and remove the namespace," not an archaeology exercise.
*Fallback if this slips:* pre-provision tester accounts and disable public signup, so the app
arguably does not "enable account creation" — but verify that reading against current policy
before relying on it, and note it also satisfies M1's allowlist requirement.

Everything else in M7 (the operator review queue, the paper-source terms audit, support surfaces)
stays in M7.

**Scope, part 2 — the build.** One production-profile EAS build (`.aab`) pointed at the M1
production origin. Play app created, closed track configured, upload, pass review, invite testers.
`targetSdkVersion` is **already 36** (settled in M1, P2-4), so this build should confirm rather
than discover. Check the merged manifest in the build output anyway — that artifact is the only
definitive proof, and this is the first time one exists.

**What testers get.** A multi-tenant, free, no-paywall, no-quota build. That is fine and expected:
Google requires that a closed test *ran*, not that the tested build was final.

**Tester cost control must be automatic, and only one provider gives you a real ceiling.** M3's
per-user reservations do not exist yet, and a manual kill switch is not a ceiling — twelve engaged
testers running Opus-class analyses over full papers plus TTS can spend faster than anyone notices,
and this milestone still has no authoritative internal cost for the agentic path.

Verified 2026-07-25, and this corrects an earlier draft of this plan:

- **OpenRouter — genuinely hard.** A per-key credit limit is enforced *before* the request reaches
  the upstream provider, so an exhausted key costs nothing further
  ([API credit & rate limits](https://openrouter.ai/docs/api_reference/limits)). One caveat: the
  check is per request, so a burst of simultaneous requests can overshoot slightly. Set the limit
  below a number you would accept losing outright.
- **OpenAI — one of the two "spend limits" is hard; use that one.** The *dashboard* project/org
  monthly budget is a **soft alert** — requests keep being processed past it. But the **Admin API
  spend-limit resource has an enforcing mode** that returns `429 insufficient_quota` once reached
  (subject to slight propagation overshoot), and that is the strongest provider-side control
  available. Set it, then **verify it actually blocks** with a deliberate small-limit test. Keep a
  prepaid balance with auto-recharge disabled as belt-and-braces. See H20.

So the load-bearing control for TTS is one **we** enforce. We hold the only key, so an in-app
ceiling is a real ceiling.

**The model is decided (H22, 2026-07-25, revised same day): `tts-1`.** That settles the accounting
design, and it is the SIMPLER of the two this plan previously weighed. The `-hd` variant was chosen
first and then dropped once the cost analysis showed audio dominates: same accounting, half the
price.

- `tts-1` is priced **$15.00 per 1M characters** (`tts-1-hd` is $30.00), verified against OpenAI's
  live pricing on 2026-07-25. Character pricing means **the cost of a dispatch is exactly known
  before making it**, from the length of the text we are about to send — and it is why switching
  between the two is a pure price change with no accounting rework.
- It returns raw mp3 and supports **no usage payload and no SSE**. Nothing settles afterward, and
  nothing needs to: there is no provider figure to reconcile against, because our own computation
  *is* the figure.

So M3 bills audio as `characters_sent × rate`, charged **per dispatch**, and there is no
reservation/settlement machinery for TTS at all. Two consequences that survive from the earlier
design and still bite:

1. **Retries multiply the billable dispatches.** `tts.py` retries up to `_TRIES` (3) per segment,
   and `except httpx.HTTPError: continue` retries on **any** network error — including a read
   timeout where OpenAI may already have synthesized and billed. So one logical narration can cost
   up to 3 × (number of segments). **Charge per attempt, not per logical operation**, or make the
   retry unambiguous (no retry after a read timeout) and accept the reliability cost. Charging per
   logical operation would under-bill by up to 3×.
2. **Long narrations are many dispatches.** `split_for_tts` splits at `MAX_TTS_CHARS` (3800) under
   OpenAI's 4096 input cap, so the unit to meter is the segment, and the per-user ceiling must be
   checked *between* segments — otherwise a single long narration blows past the cap before
   anything looks at it.

*(Historical note, kept because it explains why this section used to be complicated: the
alternative, `gpt-4o-mini-tts`, is priced on input text tokens **plus generated audio tokens**,
which are not knowable before the call. It would have needed a conservative reservation up front
settled against the usage in its SSE terminal event. Choosing a character-priced model deletes that
whole path. On its deprecation status, OpenAI's model page and its all-models catalog disagree —
the former marks only the `-2025-03-20` snapshot, the latter labels the whole family Deprecated —
so an earlier claim here that "a search summary saying the family is deprecated is wrong" was
overconfident and is withdrawn. Immaterial now: we are on `tts-1`, which the same catalog shows
with no deprecation label.)*

Ship the chosen design in M2.5 as a simplified precursor of M3's reservations, together with
per-user concurrent-job and requests-per-hour caps, and **retire `POST /api/speak` or route it
through the same per-user TTS budget** (P0-13). Note that "authenticate it" is not the fix —
every `/api/*` route is already behind the auth middleware; the gap is that it accepts
arbitrary-length text and fans it into many paid calls with no budget gate at all. Test that the
configured maximum genuinely cannot be exceeded.

**Risks.** Any later native-module addition (RevenueCat, M4) means a new build for testers — fine,
and it does not reset the 14-day opt-in clock as long as testers stay opted in. Data safety answers
must be revised whenever data handling changes (M3 usage events, M5 billing), and a mismatch
between the form and the privacy policy is a common rejection cause.

**Files/services.** `mobile/app.json` (`extra.apiBaseUrl` → M1 origin), `mobile/eas.json`; new
compliance routes/screens; hosted policy pages; Play Console configuration.

**Tests.** Build installs from the closed track on a clean device and completes a real turn against
the hosted backend. Two tester accounts cannot see each other's data. Report action persists.

**Rollback.** A closed track is invisible to the public and can be halted at any time.

**Done when.** ≥12 testers are opted in and the 14-day continuous clock is running.

**Human actions.** Finish Play account verification, H8 (create the app, accept agreements), H11
(approve privacy policy + terms), H13 (Data safety declarations), **H20** (provider spend limits —
already required at M1, and doubly so once 12 external testers can spend), H16 (recruit 12+ testers —
the pacing item; start recruiting during M2 so they're ready the day this lands), and H21 extended
with the testers' UUIDs if the allowlist is still the gate.

---

### M3 — Metering, quotas, and abuse controls

**Objective.** Every LLM call is attributed to a user, priced, and bounded by a hard ceiling.

**Rationale.** P0-4, P0-5, P1-3. Your marginal cost is Opus-class analysis over full paper text plus
TTS plus graph builds — dollars per paper. A subscription without hard caps is an open-ended
liability, and a compromised or looping account is a denial-of-wallet event.

**Scope.** **First, fix agentic cost attribution (P0-5).** Note the existing `reconcile` hook
(`usage.py:194`) is *not* usable as-is, contrary to the first draft of this plan: the agentic path
writes a single aggregate pending marker with `generation_id=None` for a run of up to 12 provider
requests (`agent_harness.py:96`), and `reconcile()` returns early on a falsy id (`usage.py:203`).
There is nothing to reconcile *against*. So the fix is one of: capture every agentic request's
generation id at the transport layer and emit one pending event per generation (then
generation-stats polling can resolve each), or route the agentic path through a client that
preserves OpenRouter's authoritative `cost`. Nothing else in this milestone is trustworthy until
turns are priced.

**Second, inventory every provider-spend entry point — "LLM calls" and "job-creating routes" do
not cover them (P0-13).** `tts.py` never touches `usage.py`, so *all* OpenAI speech spend is
currently unmetered; and `POST /api/speak` (`routers/audio.py:39-52`) synthesizes arbitrary
caller-supplied text synchronously, outside the job framework entirely. `/api/narrate` and the
plain/SSE turn-delivery paths in `routers/session.py` are likewise paid work that is not a
`JobRegistry` job. Enumerate all of them, meter TTS as a first-class operation in the ledger, and
put every one behind the same ownership + rate-limit + reservation guard — or retire it. The
blocking/SSE endpoints should additionally be migrated or disabled in production, since their
existence contradicts invariant 1.

Then: append-only `usage_events` (user, project, operation, model, tokens, nano-USD cost,
timestamp, generation id) written alongside the existing aggregate. Per-user rate limits
(requests/minute, concurrent jobs). Daily and monthly quotas by tier. **Pre-spend reservations per
architectural rule 5** — atomically reserve a pessimistic maximum against the user's remaining
budget before admitting work, settle to actual cost when it finishes, release on failure; a
reservation that cannot be taken (or a quota store that is unreachable) refuses the work rather
than letting it through.

**Reservations need a crash lifecycle, defined here rather than assumed.** Jobs live in memory
(invariant 6) but reservations live in Postgres, so a process death between reserve and settle
leaves an orphan that would permanently consume a customer's quota — and blindly releasing orphans
on boot would instead under-count real spend that already happened upstream. Specify: durable
reservation ids, explicit states (reserved → settled/released/expired), a lease with expiry,
linkage to the job and to any generation ids issued under it, and an **idempotent startup
reconciliation**. M6 consumes these same records when it marks interrupted jobs.

**Settlement is provider-specific — one strategy does not cover both.**

- *OpenRouter (LLM):* each call has a generation id, so an orphan can be resolved authoritatively
  by querying generation stats. This is the path the pending/`reconcile` machinery was designed for.
- *OpenAI (TTS):* **nothing to reconcile, by construction.** With `tts-1` (H22) the price is
  `characters_sent × rate`, so the ledger computes the exact figure at dispatch and no provider
  number is ever needed. Do not build reconciliation for audio. The one ambiguity is a dispatch
  that may or may not have been billed — a read timeout where OpenAI synthesized anyway — and the
  safe treatment is to charge it: over-counting a possibly-billed attempt beats silently losing
  spend, which is the property that matters for a ceiling. (The provider usage API could not settle
  this anyway: it reports aggregated time buckets by project/key/model, with no per-request id.)

An instance-wide kill switch. Soft warnings at 80%.
Max-token and timeout caps per operation. Audio cache eviction with an LRU/size bound (P1-1).
Prompt-injection hardening on the tool loop (P1-4): explicit provenance framing for paper text,
tool-call budget already in place, plus an egress review covering **every** outbound-fetch path,
not just `web_fetch` — the retrieval path was the one missing its guard entirely (P0-14, closed in
M1), so the review's job is to confirm no third path exists rather than to re-check the one that
was already guarded.

**Files/services.** New `app/metering.py`, `app/quotas.py`; `app/usage.py`, `app/llm.py`,
`app/agent_harness.py`, `app/jobs.py`, `app/audio_jobs.py`, `app/research_tools.py`; all
job-creating routers; new `docs/production/04-ai-costs-quotas-and-abuse.md`.

**Risks.** A quota bug that blocks legitimate paid users is worse than a mild overspend — fail
toward a logged soft-warning on ambiguity, but never on the hard ceiling. Keep the two mechanisms
distinct (rule 5): **analytics** recording stays best-effort and never fails a turn, preserving the
existing `usage.py` discipline; **reservations** are authoritative and fail closed. Conflating them
is what makes a ceiling unenforceable.

**Tests.** Cost recorded for both agentic and single-shot paths, with no `estimated` flag on the
default path. TTS spend appears in the ledger. **No endpoint can initiate paid work without
passing ownership, rate-limit, and reservation checks** — enumerate them and assert it per route,
including `/api/speak` and `/api/narrate`. Quota exhaustion returns a clean, actionable error.
Rate limiter under concurrency. **Concurrent admission cannot collectively exceed the ceiling** —
the race the reservation design exists to close, so test simultaneous admissions, not sequential
ones. Quota store unavailable ⇒ paid work refused. **Kill the process immediately after admission,
and again mid-provider-call, and assert startup reconciliation neither strands the quota nor
under-counts the spend.** Cache eviction respects the bound. Per-user attribution correct inside
job threads *and* inside nested graph/affiliation workers (rule 3).

**Manual.** Drive a real account to its quota on staging and confirm the client message is honest
and the spend stops.

**Rollback.** Limits are config-driven; set them permissive to disable without a deploy.

**Done when.** Cost-per-user/feature/day is queryable, no unpriced default-path call remains, and
no single account can exceed its ceiling.

**Human actions.** Decide the actual tier limits — needs your real cost-per-paper numbers, which
this milestone's event data produces. Expect to set them provisionally and revise at M10.

---

### M4 — RevenueCat foundation

**Objective.** Products, entitlements, and a stable cross-platform identity, with sandbox purchases
working.

**Scope.** RevenueCat project and Play app configuration. Entitlement (`pro`), Offerings, monthly
and annual packages. `react-native-purchases` in the Expo dev-client build (native module — already
supported, `expo-dev-client` is in place). **App User ID = Supabase auth UUID**, never email.
Login/logout/account-switch identity handling. Restore Purchases. Paywall via the current Offering
rather than hardcoded product logic. Evaluate the official RevenueCat MCP for agent-operable
configuration, scoped least-privilege and documented without credentials.

**Files/services.** `mobile/package.json`, `mobile/app.json`, new purchase/paywall modules under
`mobile/src/`; new `docs/production/03-monetization-and-entitlements.md`.

**Risks.** Play Billing Library version must be currently supported — Google's deprecation schedule
retires Billing 7 for new apps/updates on **2026-08-31**, so verify the transitive version
RevenueCat ships at implementation time rather than trusting this note.

**Tests.** Identity stability across login/logout/switch. Restore on a fresh install. Offering
fetch failure degrades gracefully.

**Manual.** Sandbox purchase of both packages on a real device via the internal track.

**Rollback.** Paywall behind a flag; entitlement checks default closed but the app remains usable
on the free tier.

**Done when.** A sandbox purchase grants the entitlement and survives reinstall via Restore.

**Human actions.** Create the RevenueCat account; create the Play app; accept Play agreements;
complete tax/banking setup; generate the Play service credential; author store product IDs.

---

### M5 — Subscription-backed access

**Objective.** Server-side entitlement enforcement with a reconciled, idempotent projection.

**Scope.** RevenueCat webhook endpoint — authenticated per current RevenueCat guidance, idempotent
on event id, tolerant of duplicate and out-of-order delivery, handling expiration/refund/
cancellation/grace/billing-retry. Normalized `entitlements` projection in Postgres with documented
source-of-truth rules (RevenueCat is authoritative; the projection is a cache with a reconciliation
job). Wire tier → quota from M3. Customer Center for self-service management.

**Files/services.** New `app/routers/billing.py`, `app/entitlements.py`; `app/quotas.py`;
migrations; mobile paywall and subscription-management surfaces.

**Risks.** Two sources of truth is the classic failure — the projection must be rebuildable from
RevenueCat at any time, and there must be a reconciliation command to prove it.

**Tests.** Duplicate webhook is a no-op. Out-of-order delivery converges. Expiration revokes access.
Refund revokes. Grace period retains access. Spoofed webhook rejected. Entitlement cannot be
spoofed from the client.

**Manual.** Full sandbox lifecycle: purchase → cancel → expire → restore.

**Rollback.** Projection is derived; it can be dropped and rebuilt.

**Done when.** Access is server-enforced, no client claim is trusted, and reconciliation is a
single documented command.

---

### M6 — Durability: job persistence and backups

**Objective.** A restart or crash never silently destroys paid work, and data survives host loss.

**Rationale.** P0-10, P0-11. This becomes a refund-and-support problem the moment money changes
hands. `docs/improvements.md` §1.4 already specifies the job-persistence approach and the unified
`JobRegistry` (§1.1) made it a one-place fix.

**Scope.** Persist job state so an interrupted job is either resumed or reported as failed rather
than vanishing. **Add a graceful-shutdown drain** (found reviewing PR #218): jobs run in daemon
threads and the app has no shutdown hook, so a `fly deploy` — or a Fly host migration, which stops
the machine first — kills in-flight work. `auto_stop_machines = "off"` does not help; it only
disables Fly Proxy's *idle* shutdown. The drain is a FastAPI lifespan hook that stops admitting new
jobs on SIGTERM and waits for tracked workers within the configured `kill_timeout` (raised to the
300s maximum in `fly.toml` so the hook has room). Until it exists the operational rule is: check
for active jobs before deploying. **Reconcile against M3's reservation records rather than inventing a second
lifecycle** — an interrupted job and its orphaned reservation are the same event, and resolving
them separately is how a customer's quota gets stranded or their real spend under-counted. Use the
reservation ids and generation linkage M3 defines. Automated backups of the volume (project git
repos + `.app-state/`) and Postgres, off-host, with a **tested restore**. Retention policy.

**Risks.** Resume semantics for a half-spent LLM turn are subtle — reporting an honest failure with
the partial spend recorded is acceptable and much simpler than true resumption. Prefer that.

**Tests.** Kill the process mid-job; on boot the job is `failed` with its partial usage recorded,
never stuck `running`, **and its reservation is settled to actual spend rather than left reserved
or blindly released**. Restore drill from backup into a clean environment.

**Done when.** A restore has actually been performed, not just configured.

---

### M7 — Remaining compliance, safety, and legal surfaces

**Objective.** Everything Google Play requires that isn't a build artifact and wasn't already
forced forward into M2.5.

**Rationale.** P0-7, P0-8. Several are hard submission blockers. **Note the split:** the privacy
policy, terms, Data safety inventory, in-app AI-content report action, and the account-deletion
workflow all moved into **M2.5**, because a closed testing track requires them. What remains here
is the operator-facing and lower-urgency remainder.

**Scope — only what M2.5 did *not* already ship.** The privacy policy, terms, data inventory,
Data safety answers, account-deletion workflow, and in-app AI-content report action are **M2.5
deliverables** (a closed track requires them) and are deliberately *not* repeated here. What
remains:

- **Support contact** surfaced in-app and in the store listing.
- **Operator review queue** for the content reports M2.5 begins collecting — M2.5 ships the report
  path and somewhere for reports to land; M7 ships the workflow for acting on them.
- **AI-limitations disclaimer** with appropriate UX framing: the product presents model analysis of
  scientific papers and must not frame it as authoritative. Preserve source citations and links.
- **Paper-source terms audit** (P1-7): arXiv, Semantic Scholar, and OpenAlex, for commercial
  storage and redistribution of full text and figures.
- **Extending the M2.5 inventory and Data safety answers** to cover everything added since — M3's
  usage events and M5's billing data both change what is collected, and a mismatch between the form
  and the policy is a common rejection cause.

**Files/services.** New `app/routers/compliance.py`; migrations; both clients (settings/legal
screens, report action); new `docs/production/02-security-and-privacy.md`; hosted policy pages.

**Risks.** The paper-source terms audit could genuinely constrain the product — if commercial
redistribution of extracted full text isn't permitted, caching strategy or tiering may need to
change. Do this audit **early in the milestone**, not last.

**Tests.** Deletion removes every artifact and is idempotent. Report submission persists and
surfaces to the operator queue. Policy links resolve.

**Manual.** Delete a real staging account and verify nothing remains.

**Human actions.** Approve the privacy policy and terms text (legal consequence — yours to make).
Provide a support email. Make the Data Safety declarations in Play Console.

---

### M8 — Observability and operator tooling

**Objective.** The smallest stack that lets you tell within minutes that a release is broken.

**Scope.** Sentry for backend exceptions and React Native crashes. Structured `rc.*` log shipping
from the container. A minimal operator screen (or dashboard queries) covering: AI spend by day and
user, failed jobs, failed webhooks, quota breaches, content reports, deletion requests, subscription
state. Alerts on genuinely actionable conditions only — sustained error spike, webhook failure, AI
cost anomaly, provider outage, budget threshold.

**Risks.** Scrub secrets and paper content from Sentry payloads — the log filter already stamps the
active project; extend the same discipline to redaction.

**Done when.** You can answer "is production healthy and what did it cost today" without SSH.

---

### M9 — Android release automation

**Objective.** A reproducible, agent-operable path from commit to internal track.

**Scope.** EAS production build (`.aab`), signing, version code strategy (`appVersionSource: remote`
already set). `targetSdkVersion` already resolves to 36 (M1, P2-4) and is deliberately left unpinned, so
the **2026-08-31** Play floor needs no action here — re-verify against current documentation at
implementation time in case the floor has moved again. Play service account for EAS Submit. EAS Workflows for CI → build → submit to internal track.
EAS Update policy with runtime versioning and a rollback procedure — deliberately conservative, no
auto-submit on every merge to `main`.

**Risks.** Native module additions from M4 mean dev-client rebuilds — plan a device pass. (CI
billing, formerly a prerequisite here, was resolved as H1 on 2026-07-24.)

**Done when.** `main` → internal track is one documented command, and rollback is documented and
drilled.

**Human actions.** Create/verify the Play developer account; accept agreements; create the app
listing; generate and authorize the service account credential.

---

### M10 — Launch rehearsal

**Objective.** Prove the whole thing before strangers touch it.

**Scope.** Full regression including the E2E scenarios (auth lifecycle, cross-user isolation, quota
exhaustion, purchase/cancel/expire/restore, webhook duplication and reordering, provider timeout,
PDF failure, content report, account deletion, upgrade, OTA rollback). Evaluate Maestro for a small
number of mission-critical mobile flows. Store assets: name, descriptions, screenshots, feature
graphic, icon, content rating, target audience, ads declaration, reviewer credentials. The closed-testing
requirement **applies** (confirmed 2026-07-25) — by this point the 14-day clock should long since
have been satisfied via M2.5, so what remains here is applying for production access and its ≤7-day
review. Rollback drill. Revise M3 quota limits against real observed cost.

**Done when.** No known P0 remains and every launch-ready criterion is met.

**Human actions.** Recruit testers if the closed-test requirement applies; author store listing
copy; final policy attestations.

---

### M11 — Production release

Controlled rollout with staged percentage, active monitoring, and a rehearsed rollback.

---

## Document set

Five living documents plus human actions — deliberately fewer than the external brief's eleven,
because `docs/` already holds 28 files and stale documentation is worse than none. Play, iOS, and
web checklists live inside the milestones that action them rather than as standalone documents.

| Document | Status | Written during |
|---|---|---|
| `00-current-state-audit.md` | ✅ done | now |
| `10-roadmap.md` (this file) | ✅ done | now |
| `HUMAN_ACTIONS.md` | ✅ done | now |
| `01-architecture.md` | queued | M1 |
| `02-security-and-privacy.md` | 🚧 M2.5 code-derived inventory + Data Safety draft written; implementation and M7 expansion open | M2.5, expanded in M7 |
| `03-monetization-and-entitlements.md` | queued | M4 |
| `04-ai-costs-quotas-and-abuse.md` | queued | M3 |

**Rule:** every architecture or configuration change updates the relevant document in the same PR.
These are project memory — a future Claude or Codex session must be able to operate from them
without reconstructing context from chat history.

## Policy verification rule

Store policies change and this plan encodes a July 2026 snapshot. Before implementing or submitting
anything policy-sensitive, check the current official source and record the URL, date checked,
requirement, and implementation impact in the relevant milestone. Do not treat the dates in this
document (API 36 and Play Billing 7 on 2026-08-31; the 12-tester/14-day closed-test rule) as
verified — they are flags to check, and two of them are roughly five weeks out.
