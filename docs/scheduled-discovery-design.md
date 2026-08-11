# Scheduled background discovery (DR-051)

*Drafted 2026-08-10 from Kamil's device-pass request: weekly discovery runs per project,
"monthly on cheaper tiers, weekly or daily for more expensive plans," with a notification when a
background run finds something worth seeing. **This supersedes the discovery rebuild plan's
"Discovery stays user-triggered — no scheduler" decision**: that decision predates the metering
stack, and its spend-cap objection is answered — a scheduled run takes the same admission hold
and settles against the same monthly ceiling as a manual one. Status: design — nothing here is
built.*

## The shape: a persisted next-run time, checked by a tick — not a timer

Invariant 6 (single process) and the deployment reality (a Fly deploy restarts the machine and
kills everything in-process) rule out in-memory schedulers outright: an `asyncio` timer or a
cron thread loses its state on every deploy, and "the weekly run silently stopped happening
after a deploy" is the worst failure mode a scheduled feature can have — invisible until the
user notices staleness.

So the schedule is **data, not a timer**:

- Each project stores `discovery_schedule: {frequency, next_run_at}` — in `project.json`
  alongside `goals` (per-project git-tracked config is where goals already live; the schedule is
  a preference *about* those goals).
- A single lightweight **tick** — one daemon thread started at app boot, waking every ~15
  minutes — scans enabled schedules and, for any `next_run_at <= now`, starts the ordinary
  discovery job through the exact machinery the button uses (`discovery_jobs`, same admission,
  same hold, same registry), then advances `next_run_at = now + frequency` **before** starting
  the run, so a crash mid-run cannot double-fire.
- The tick is idempotent and stateless: after a deploy, the new process reads the persisted
  timestamps and is exactly where the old one was, at most one tick late. A run that was killed
  mid-flight by the deploy is simply re-run at the next due time — Discovery's ledger already
  makes an incremental re-run cheap.

The tick must **rebind the project contextvar per schedule entry** (invariant 2) and must bind
the OWNER's user id — the run is billed to the account that enabled the schedule, admitted
through `spend_ceiling.hold` like any paid job. A refusal (allowance exhausted) records
`skipped: out_of_allowance` on the schedule and tries again at the next due time; it must NOT
retry on the next tick, or an exhausted account gets hammered every 15 minutes.

## Frequency binds to the plan

`plans.Plan` gains `discovery_frequencies: tuple[str, ...]` — the frequencies a plan may
*select*, not a hidden behavior difference:

| plan   | selectable                | rationale                                        |
|--------|---------------------------|--------------------------------------------------|
| free   | `("monthly",)`            | one scheduled run ≈ 13–20 credits of a 200 budget |
| basic  | `("monthly", "weekly")`   | ~4 runs/month ≈ 60–80 credits of 2,500            |
| tester | all, including `"daily"`  | testing affordance                                |

Enforcement at **schedule-set time** (the route refuses a frequency outside the plan) and at
**tick time** (a downgraded account's stored `weekly` degrades to its plan's best, with a note
on the schedule — never silently keeps the old cadence). The credit peg does the real cost
containment; frequency tiers exist so a plan's headline allowance is not quietly consumed by
automation the user forgot about.

## "Interesting enough to notify"

A scheduled run that notifies on every completion is spam; the signal is **new since the reader
last looked**. Discovery's ledger already tracks `first_seen` per candidate and `surfaced_in`,
which gives a cheap, deterministic definition with no extra LLM pass:

> Notify iff the run's results contain ≥1 candidate that has never been surfaced in any run the
> reader has OPENED, and it ranks in the run's top 10.

"Opened" comes from the existing result-read path (the Discover screen fetching a run marks it
seen — one boolean on the persisted result). The notification itself rides DR-050's channel and
inherits its content rule: counts and project name only, never titles. A run with nothing new
completes silently — the schedule's job history still shows it ran.

## Client surface

On the Discover tab, one row under the goals field: frequency picker (Off / Monthly / Weekly /
Daily-if-plan) + "next run" line + the last scheduled run's outcome ("ran Tuesday — nothing new"
/ "ran Tuesday — 3 new suggestions"). No new screens.

## Order of work

1. Schedule storage + tick + admission/refusal handling (backend only, feature-flag off).
2. Plan binding + routes + the degrade-on-downgrade rule.
3. "Seen" tracking + the notify predicate (depends on DR-050's delivery existing).
4. Client row.

## Test surface

Tick idempotence across a simulated restart (persisted `next_run_at` honored, no double-fire);
advance-before-run; refusal → `skipped` + no retry until next due; contextvar and user binding
(the wrong-project failure is silent, so this test matters most); plan gating at set-time and
the downgrade degrade; the notify predicate against ledger fixtures (never-surfaced vs
previously-opened). All offline; the tick's clock is injected.
