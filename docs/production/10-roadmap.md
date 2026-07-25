# Production launch roadmap

*Written 2026-07-24 against `origin/main` @ `e5fe869`. Evidence base: `00-current-state-audit.md`.
This is the execution ledger — update the Status column as milestones land, same convention as
`docs/product-roadmap.md` and `docs/round12-queue.md`.*

**Workflow per milestone:** branch → Opus implements → codex CLI review (GPT 5.6 Sol, high
reasoning) in `/loop` → fix findings → PR → merge. Milestones that change external billing
configuration, the production database, or store configuration need explicit human approval
before execution.

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
| M1 | Hosting, environments, and secrets | — | L | queued |
| M2 | Identity, tenancy, and per-user isolation | M1 | L | queued |
| M2.5 | Closed-track compliance minimum (incl. account deletion) + first build — starts the 14-day tester clock | M1, M2 | L | queued |
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

**Done when.** Staging and production both reachable over HTTPS on a real domain, restart-safe,
volume-backed, secrets out of the repo, prod provably refusing dev bypasses, API-36 answer recorded.

**Human actions.** H1 (Actions billing) ✅ and H2 (Fly account) ✅ are done. Remaining: add a
payment method to Fly (persistent volumes are not in the free allowance), and **H4 — create the
production and staging Supabase projects**, pulled forward from M2 because prod now refuses to boot
without Supabase auth configured. No domain purchase needed: `research-companion.fly.dev` ships
with TLS (H2b defers a custom domain to M10).

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
`app/routers/audio.py`, `app/main.py`; both clients' settings screens.

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
inventory derived from actual code, truthful Data safety answers, a published privacy policy and
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
Confirm `targetSdkVersion` satisfies API 36 here — the cheap moment to discover an Expo SDK 56
problem, months before M9 depends on it.

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
ceiling is a real ceiling — but note a correction to an earlier draft of this plan, which claimed
TTS cost is exactly computable before dispatch:

- The configured default is **`gpt-4o-mini-tts`** (`config.py:360`), which OpenAI prices on input
  text tokens **plus generated output audio tokens**. Audio token count depends on synthesized
  duration, so it is not knowable *before* the call — which is what the reservation must cover.
  It *is* knowable afterward: the current implementation requests raw mp3 and so sees no usage,
  but `stream_format: "sse"` emits a terminal `speech.audio.done` event carrying token usage, so a
  completed synthesis settles to real cost (see the settlement rules below and H22).
- Only the older character-priced models (`tts-1`, `tts-1-hd`) give exact pre-dispatch cost.

Two workable designs, and this is a product decision (see H22): **(a)** pin production TTS to a
character-priced model and keep exact per-dispatch accounting, at some cost in voice quality; or
**(b)** keep `gpt-4o-mini-tts` and reserve a **conservative upper bound** derived from the
character count, settling at the bound. (b) deliberately over-counts, which is safe for a ceiling
but imprecise as a billing ledger. Recommendation: (b), since audio quality is a headline feature —
revisit if the over-count proves material at M10.

**Two things make the *reservation unit* wrong if taken naively, and both must be handled:**

1. **Retries multiply the billable dispatches.** `tts.py:101-116` retries up to `_TRIES` (3) times
   per segment, and `except httpx.HTTPError: continue` retries on **any** network error — including
   a read timeout where OpenAI may already have synthesized and billed the audio. 500/502/504 are
   likewise ambiguous. So one logical narration can cost up to 3 × (number of segments) dispatches.
   Reserve **per attempt**, not per logical operation — or make the retry unambiguous (no retry
   after a read timeout) and accept the reliability cost. Reserving per logical operation would
   silently under-reserve by up to 3×.
2. **The upper bound is an engineering estimate, not a provider guarantee — but it only has to
   cover the failure case.** OpenAI documents no per-request cap on output audio tokens or
   duration, and `speed` is not a billing bound. What *is* hard is the input cap (OpenAI 4096
   chars; we split at `MAX_TTS_CHARS` = 3800), which bounds plausible audio duration in practice.
   So derive the bound from segment length with an explicit, documented safety factor and validate
   it against observed spend at M10.

   Crucially, **a successful attempt need not stay at the estimate.** `gpt-4o-mini-tts` supports
   `stream_format: "sse"`, whose terminal event reports input/output token usage — so reserve the
   conservative bound, then **settle to the observed usage** when the attempt completes, keeping
   the bound only for attempts that time out or die before their usage event. That makes the
   ledger accurate for the normal path and conservative only where it must be. (The terminal usage
   event is present in OpenAI's published OpenAPI specification; still confirm the exact payload
   shape when implementing, as with anything in this plan touching money mechanics.)

   Note this **inverts the H22 tradeoff**: SSE usage reporting is available on `gpt-4o-mini-tts`
   and *not* on `tts-1`/`tts-1-hd`. So the token-priced model gives better real accounting than the
   character-priced one, which strengthens the recommendation to keep `gpt-4o-mini-tts`.

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
(approve privacy policy + terms), H13 (Data safety declarations), H16 (recruit 12+ testers — the
pacing item; start recruiting during M2 so they're ready the day this lands).

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
- *OpenAI (TTS):* there is **no per-request identifier to reconcile against** — the usage API
  reports aggregated time buckets grouped by project/key/model, so under concurrency a crashed
  synthesis cannot be matched to one reservation. Do not specify provider reconciliation here.
  A *successful* attempt is not affected — with `gpt-4o-mini-tts` it settles to the usage reported
  in the SSE terminal event (see M2.5). The unresolvable case is narrower than earlier drafts of
  this plan claimed: only an attempt that **crashed or timed out before its usage event** cannot be
  priced from the provider. Settle those from the reservation's conservative bound, which
  over-counts a crashed request rather than under-counting it. The ledger therefore errs toward
  charging us, never toward silently losing spend — the property that matters for a ceiling.

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
than vanishing. **Reconcile against M3's reservation records rather than inventing a second
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
already set). Confirm and, if needed, raise `targetSdkVersion` to API 36 — Google requires it for
new apps and updates from **2026-08-31**; verify against current documentation at implementation
time. Play service account for EAS Submit. EAS Workflows for CI → build → submit to internal track.
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
| `02-security-and-privacy.md` | queued | M7 |
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
