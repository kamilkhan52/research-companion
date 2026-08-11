# Scheduled background discovery (DR-051)

*Drafted 2026-08-10 from Kamil's device-pass request: weekly discovery runs per project,
"monthly on cheaper tiers, weekly or daily for more expensive plans," with a notification when a
background run finds something worth seeing. **This supersedes the "Discovery stays
user-triggered — no scheduler" decision** (recorded in `production/90-history.md`, R14 notes,
now annotated there). That decision rested on two objections: spend caps — answered, a scheduled
run takes the same admission hold and settles against the same monthly ceiling as a manual one —
and invariant 6, answered below by making the schedule persisted data checked by one thread in
the one process, rather than any second scheduler process. Status: design — nothing here is
built.*

## The shape: a persisted next-run time, checked by a tick — not a timer

Invariant 6 (single process) and the deployment reality (a Fly deploy restarts the machine and
kills everything in-process) rule out in-memory schedulers outright: an `asyncio` timer or a
cron thread loses its state on every deploy, and "the weekly run silently stopped happening
after a deploy" is the worst failure mode a scheduled feature can have — invisible until the
user notices staleness.

So the schedule is **data, not a timer**:

- The schedule splits by nature, following the codebase's own convention: `frequency` (a user
  CHOICE) lives in `project.json` alongside `goals`; `next_run_at` (machine-advanced state) lives
  in `.state/discovery-schedule.json`, gitignored like every derived artifact. Putting the
  timestamp in `project.json` would sweep every tick's write into the next human-approved notes
  commit — `committer.py` and `notes_jobs.save` both run `git add -A` — violating invariant 4's
  spirit with machine noise in the human record.
- A single lightweight **tick** — one daemon thread started at app boot, waking every ~15
  minutes — scans enabled schedules and, for any `next_run_at <= now`, starts the ordinary
  discovery job through the exact machinery the button uses (`discovery_jobs`, same admission,
  same hold, same registry), then advances `next_run_at = now + frequency` **before** starting
  the run, so a crash-and-restart cannot double-fire. Two caveats that must be designed, not
  assumed: (a) a ROLLING deploy can briefly run two processes (`deploy_guard.py` exists because
  of exactly this window), so the advance is written with an atomic compare-and-swap on the
  file's prior value — the second process's stale read loses and skips; if verification shows
  the single-machine deploy never overlaps, the CAS is cheap insurance rather than load-bearing.
  (b) A boot after downtime finds every overdue schedule due at once: the tick processes at most
  ONE due schedule per wake, with jitter, so a backlog drains over hours instead of stampeding
  the rate limiter (`discovery_jobs` is `metered=True`, so `RateLimited` — not only `QuotaError`
  — is a refusal the tick must treat as `skipped`, never as retry-now).
- The tick is idempotent and stateless: after a deploy, the new process reads the persisted
  timestamps and is exactly where the old one was, at most one tick late. A run that was killed
  mid-flight by the deploy is simply re-run at the next due time — Discovery's ledger already
  makes an incremental re-run cheap.

The tick must **rebind scope per schedule entry** via `config.bound_scope(pid, uid)`
(invariant 2 — binding a subset fails open), with `uid` from `tenancy.owner_of(pid)` — the run
is billed to the account that enabled the schedule, admitted through `spend_ceiling.hold` like
any paid job. The tick's enumeration is itself a cross-user, cross-project scan: it reads
ownership rows directly and never goes through `may_access` (there is no requesting user), which
is exactly the kind of path AGENTS.md says must be written deliberately, with a test proving one
user's schedule cannot run under another's binding. ANY refusal — `QuotaError` (allowance
exhausted, ledger down) or `rate_limits.RateLimited` — records `skipped` with its reason on the
schedule state and waits for the next DUE time, never the next tick, or an exhausted account
gets hammered every 15 minutes.

## Frequency binds to the plan

`plans.Plan` gains `discovery_frequencies: tuple[str, ...]` — the frequencies a plan may
*select*, not a hidden behavior difference:

| plan   | selectable                | rationale                                          |
|--------|---------------------------|----------------------------------------------------|
| free   | `("monthly",)`            | one scheduled run ≈ 13–20 credits of a 200 budget  |
| basic  | `("monthly", "weekly")`   | ~4 runs/month ≈ 52–80 credits of 2,500             |
| tester | all, including `"daily"`  | testing affordance                                 |

Credits are from the MEASURED slice-1 run (~$0.0131 ≈ 13 credits; incremental runs cheaper,
cold ones nearer 20). Note the pricing analysis §1 predates the discovery rebuild and budgets
"2 runs = 2 credits" on Free and ~50 credits for ALL ancillary operations on Basic — both stale
against the rebuilt pipeline's measured cost. **Reconciling §1's line items is part of shipping
this feature**, not an afterthought: weekly scheduling on Basic consumes most of the old
ancillary budget by itself, which is affordable (2,500-credit month) but must be priced
honestly in the doc that claims to be checkable.

Enforcement at **schedule-set time** (the route refuses a frequency outside the plan) and at
**tick time** (a downgraded account's stored `weekly` degrades to its plan's best, with a note
on the schedule — never silently keeps the old cadence). The credit peg does the real cost
containment; frequency tiers exist so a plan's headline allowance is not quietly consumed by
automation the user forgot about.

## "Interesting enough to notify"

A scheduled run that notifies on every completion is spam; the signal is **new since the reader
last looked**. Discovery's ledger tracks `first_seen` per candidate today and has a
`surfaced_in` field (see the unbuilt-work note below), giving a cheap, deterministic definition
with no extra LLM pass:

> Notify iff the run's results contain ≥1 candidate that has never been surfaced in any run the
> reader has OPENED, and it ranks in the run's top 10.

"Opened" must be an EXPLICIT client signal, not the poll endpoint: `GET /discover` is polled
every ~1.5s and returns the persisted result on every call, so marking seen there would mark a
scheduled run opened by any tab visit or unrelated poll. The Discover screen sends a small
`POST /discover/seen` when it actually renders a result set to the reader.

One piece of this predicate is UNBUILT today and is part of this feature's work, not a
prerequisite that exists: `discovery_ledger.mark_surfaced` has no callers, so `surfaced_in` is
never written. Slice 1 of this feature wires `mark_surfaced` into run persistence; without it
the predicate degenerates to "always notify" — the exact spam this section exists to prevent.

The notification itself rides DR-050's channel and
inherits its content rule: counts and project name only, never titles. A run with nothing new
completes silently — the schedule's job history still shows it ran.

## Client surface

On the Discover tab, one row under the goals field: frequency picker (Off / Monthly / Weekly /
Daily-if-plan) + "next run" line + the last scheduled run's outcome ("ran Tuesday — nothing new"
/ "ran Tuesday — 3 new suggestions"). No new screens.

## Order of work

1. Schedule storage + tick + admission/refusal handling (backend only, feature-flag off) —
   including wiring `mark_surfaced` so `surfaced_in` starts accumulating before anything reads
   it.
2. Plan binding + routes + the degrade-on-downgrade rule.
3. "Seen" tracking + the notify predicate (depends on DR-050's delivery existing).
4. Client row.

## Test surface

Tick idempotence across a simulated restart (persisted `next_run_at` honored, no double-fire);
advance-before-run; refusal → `skipped` + no retry until next due; contextvar and user binding
(the wrong-project failure is silent, so this test matters most); plan gating at set-time and
the downgrade degrade; the notify predicate against ledger fixtures (never-surfaced vs
previously-opened). All offline; the tick's clock is injected.
