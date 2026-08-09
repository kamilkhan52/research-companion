# Production launch roadmap

*Written 2026-07-24 against `origin/main` @ `e5fe869`. Evidence base: `00-current-state-audit.md`.
This is the execution ledger — update the Status column as milestones land, same convention as
`docs/product-roadmap.md`.*

**Workflow per milestone:** branch → Opus implements → codex CLI review (GPT 5.6 Sol, high
reasoning) in `/loop` → fix findings → PR → merge. Milestones that change external billing
configuration, the production database, or store configuration need explicit human approval
before execution.

**Scope of this file:** what is open, and the decisions that bind future work. Completed milestone
detail, dated handoffs, and the R14 device pass moved to [`90-history.md`](90-history.md) on
2026-08-09; the device-test procedure moved to
[`40-device-test-runbook.md`](40-device-test-runbook.md). Device feedback belongs in
[`../device-review-ledger.md`](../device-review-ledger.md), not here.

---

## Current position (updated 2026-08-09, after M3 enforcement landed and deployed)

**M1 is complete and production is LIVE, running Kamil's real corpus.**
`https://research-companion.fly.dev` in `sjc`: volume attached, database connected, all migrations
applied, tenancy lockout verified against the live schema (RLS on, 0 policies, 0
`anon`/`authenticated` grants), two accounts allowlisted, five of his projects imported with full
git history, and his own prompt overrides and model picks in place. H26/H27/H28 are all
closed.

**M2.5 is code-complete and the app is in continuous production-device review.** What gates the
AAB is Kamil's sign-off plus H13, followed by the first production-profile build. Uploading before
there are testers does not bank closed-test time and prematurely freezes the Android package name.

**Fifteen reviewed PRs had accumulated unmerged since 2026-08-01** in two independent stacks; both
landed on 2026-08-05. Discovery: **#310** cooperative Stop, **#311** slice 2, **#324** the
device-review ledger. M3: **#312**–**#323** — exact-cost
metering for the agentic and speech paths, the retirement of the legacy blocking paid routes,
per-user usage events, durable reservations with quota-gated job admission, an emergency
provider-spend stop, audio-cache eviction, prompt-injection framing with bounded tool egress, and
price-sorted OpenRouter routing. Every one carried a clean GPT-5.6 Terra review before merge.

**Two migrations ship with this: `0007_usage_events` and `0008_usage_reservations`** — three new
tables, their indexes, and two state-transition guard triggers. Purely additive, no drops; `main`
applies them on boot.

**Merging the stacks was not mechanical, and the reason matters for the next one.** Parents were
squash-merged, so a parent's commits are never ancestors of `main`; git then falls back to a stale
merge base and re-conflicts the parent's whole new files even though the child already contains
them. The safe resolution was to keep the child's side and then require the result to be
byte-identical to that branch's own pre-merge version — if it is not, `main` genuinely changed the
file and a human has to read it. Two conflicts were real rather than artefacts: **#314** retires
`/api/speak` while **#313** was still editing it (the deletion looks exactly like an empty
conflict side), and **#317** deliberately makes dispatch completion independent of cost
resolution, which reads as a regression against **#316** until you check its tests. One test —
#313's `/api/speak` billing case — merged *cleanly* and only failed in CI, because #314's branch
never saw it; its guarantee survives on the job path.

**Immediate handoff:**

1. Continuous device feedback is reconciled in
   [`../device-review-ledger.md`](../device-review-ledger.md); that ledger distinguishes genuinely
   open work from merged behavior that only needs device acceptance. Landing these stacks did not
   close a single row there — merging is not acceptance.
2. Discovery slice 2 is merged but **unmeasured**: run one cold and one incremental production
   search and record reservoir size, elapsed time, spend, resume behavior, and result quality. The
   durable plan is `~/.claude/plans/keen-finding-rabin.md`.
3. Discovery slice 3 adds the comparative reading path and its client surface after slice 2's
   reservoir is measured. Quick mode remains explicitly deferred until the optimized default has
   enough real timing/quality evidence to set a meaningful target.
4. **M3 enforcement landed across 2026-08-06 to 2026-08-09 in #325–#329**, closing what point 4
   used to describe as the remaining gap. Per-account rate limits (**#325**), the spend ceiling
   actually connected — reserve on admission, settle to actual (**#326**), per-call token and
   timeout ceilings (**#327**), named plans with `tester` as the default at 5,000 credits
   (**#328**), and the metering of paths that held budget while charging nothing (**#329**).

   Three things in that stack are worth carrying forward as lessons rather than line items. Spend
   escapes through **unenumerated seams** — a pool thread, a registry hop, a partially-bound worker
   — and binding a subset of contextvars fails OPEN, so `config.bound_scope` carries project, user
   and reservation together or not at all. A job that loops cannot be gated by its admission ticket
   alone, which is why `spend_ceiling.per_unit` exists and why the graph build's per-paper gating
   became the pattern for labs-per-author and the retrieval hunt. And **#329 uncovered a production
   defect unrelated to spend**: `AgentRunResult.usage` became a property in pydantic-ai 2.x, and
   because the call sat inside `lab_research`'s own `try`, every Labs pass had failed silently
   since 2026-07-17 — see DR-008 in `docs/device-review-ledger.md`.

   **Deployed to staging and production on 2026-08-09** (`03c1c87`). Code-only — 0007/0008 were
   already applied — and verified on both: health 200, `/api/plan` answering 401 rather than 404
   (so the new routes are live, not a stale image), and the data-API lockout asserting on 10/10
   tables.

   **#329 took ten review rounds**, and the shape of that is worth recording because it will repeat.
   Five Opus passes converged on "mergeable"; GPT-5.6 Sol then found two P1s immediately, and four
   more over the next three passes. Running one reviewer repeatedly stopped being useful around
   pass three — later passes were checking whether the previous pass's fixes were right rather than
   questioning the design, and it took a different model to ask whether `per_unit` was papering
   over the fact that admission and per-unit gating are two mechanisms wearing one name. **Switch
   reviewers before running the same one a fourth time.**

   The other repeated lesson: three separate times a fix introduced an OVER-charge that no test
   caught, because the tests all drove failure paths and none drove a successful one. The worst
   would have settled every streamed turn at its maximum — $0.15 for a $0.004 turn, a Tester's
   whole month in thirty-three turns. **A bound needs a test proving the ordinary case still
   passes through it**, not only that the exceptional case is caught.

   The plan/usage CLIENT surface shipped in [#336](https://github.com/kamilkhan52/research-companion/pull/336) —
   a `Plan & usage` screen showing the spent percentage, the reset date and the plan's promise, with
   held work on its own card so a reader with jobs in flight is never told their month is nearly
   gone. Awaiting a device check as DR-038.

   Still open in M3: a per-account plan override for Kamil; the mid-flow 402/429 refusal handling
   (DR-034); and `research_tools` web search, which is external API spend with no per-call cost the
   app can see and needs a provider-side decision rather than a code change.

### Still open, in order

*The done items that used to head this list are in [`90-history.md`](90-history.md).*

1. **Data safety answers in Play Console** (Kamil, H13). `02-security-and-privacy.md` holds the
   code-derived inventory they must match, and the policy now published must match both.
2. **Then the AAB and the closed track** — one production-profile EAS build with `app.json` pointing
   at that origin and cleartext removed, which is the last piece of "encrypted in transit".

   **Correction, 2026-07-29 — earlier revisions of this file overstated the urgency of this step,
   and the plan was ordered around the overstatement.** They said the AAB "starts the 12-tester /
   14-continuous-day clock" and that everything else was therefore on its critical path. Checked
   against Google's live requirement rather than repeated from memory: the rule is **12 testers who
   have each been opted in continuously for at least 14 days**, where "opted in" means the person
   opened the link, accepted, and installed from Play under that Google account. The clock is
   counted per tester and therefore effectively starts when the **twelfth** tester is in — not at
   upload.

   So **uploading an AAB with only Kamil on the track banks no clock time whatsoever.** It buys
   exactly one thing: permanently freezing `io.scholiast.app`. All cost, no benefit, taken early.
   What actually starts the clock is recruiting the twelve people (H16) — and they cannot sensibly
   be invited to something that has not passed its own author's sign-off.

   Practical consequence: **do the device-pass fix list and the cheap metering work first.** With
   no per-user cap, no TTS metering and no web-search metering (§8 of `20-pricing-analysis.md`),
   twelve testers read against Kamil's personal provider keys with nothing bounding the spend. The
   default models were pinned to DeepSeek in #281 for exactly this reason, which removes the worst
   of it; the stacked `listening_preview` prompt budget removes repeated context while preserving
   the deliberately uncapped cue cadence.
   Source: <https://support.google.com/googleplay/android-developer/answer/14151465>.

**On tester sequencing (Kamil's call, 2026-07-28):** he wants to test himself before involving
friends, which is right — a bad first impression from twelve people is expensive. The agreed shape
is to do that testing **on the closed track with himself as the only tester**, not on staging: an
install from Play exercises app signing, the production origin, and store distribution, none of
which staging touches. The 14-day clock is effectively gated on the twelfth tester opting in, so
being first on the track costs nothing and finds a real class of bug earlier.

Deferred deliberately, with the reasoning recorded where it belongs: the operator review queue for
content reports (M7 — `content_reports.pending_count()` is its seam), audio cache eviction, and
P0-17 (`DeliveryReq.model` bypassing settings, which is M3's tier check).

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
| M1 | Hosting, environments, and secrets | — | L | ✅ **complete** — production live on Fly, running Kamil's real corpus |
| M2 | Identity, tenancy, and per-user isolation | M1 | L | ✅ **complete** — ownership enforced, per-user settings, verified against the live schema |
| M2.5 | Closed-track compliance minimum (incl. account deletion) + first build | M1, M2 | L | **code-complete** — deletion, reporting and legal surfaces shipped; the AAB and Play Data Safety answers are the remainder |
| M3 | Metering, quotas, and abuse controls | M2, M2.5 | L | **shipped, with a remainder** — exact-cost metering, the reservation ledger, per-operation caps and plans are live; see "Current position" |
| M4 | RevenueCat foundation | M2 | M | queued — **next** |
| M5 | Subscription-backed access | M3, M4 | M | queued |
| M6 | Durability — job persistence and backups | M1, M3 | M | queued |
| M7 | Remaining compliance, safety, and legal surfaces | M2, M2.5 | M | queued |
| M8 | Observability and operator tooling | M1 | M | queued |
| M9 | Android release automation | M1, M7 | M | queued |
| M10 | Launch rehearsal | all | M | queued |
| M11 | Production release | M10 | S | queued |

**M1, M2, M2.5 and M3 have their full detail in [`90-history.md`](90-history.md)** — objective, work
items, verification, rollback, and the review lessons each produced. What is still open from them is
in "Current position" above, so nothing below M3 needs reading to know what to do next.

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

Deliberately fewer than the external brief's eleven, because stale documentation is worse than none.
Play, iOS, and web checklists live inside the milestones that action them rather than as standalone
documents.

| Document | Status | Written during |
|---|---|---|
| `00-current-state-audit.md` | ✅ done | now |
| `10-roadmap.md` (this file) — what is open | ✅ live | now |
| `40-device-test-runbook.md` — how to prove what is served | ✅ live | M2.5 |
| `90-history.md` — completed milestones and dated handoffs | ✅ live | split out 2026-08-09 |
| `HUMAN_ACTIONS.md` | ✅ live | now |
| `20-pricing-analysis.md` — unit costs behind the credit peg | ✅ done | M3 |
| `30-ui-layer-brief.md` | ✅ done | M2.5 |
| `02-security-and-privacy.md` | 🚧 M2.5 code-derived inventory + Data Safety draft written; implementation and M7 expansion open | M2.5, expanded in M7 |
| `04-ai-costs-quotas-and-abuse.md` | ✅ done | M3 |
| `01-architecture.md` | queued | M1 |
| `03-monetization-and-entitlements.md` | queued | M4 |

**Rule:** every architecture or configuration change updates the relevant document in the same PR.
These are project memory — a future Claude or Codex session must be able to operate from them
without reconstructing context from chat history.

## Policy verification rule

Store policies change and this plan encodes a July 2026 snapshot. Before implementing or submitting
anything policy-sensitive, check the current official source and record the URL, date checked,
requirement, and implementation impact in the relevant milestone. Do not treat the dates in this
document (API 36 and Play Billing 7 on 2026-08-31; the 12-tester/14-day closed-test rule) as
verified — they are flags to check, and two of them are roughly five weeks out.
