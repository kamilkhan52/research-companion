# Discover: skip-to-next-step (DR-067) — design

*2026-08-14. Kamil, via a remark on DR-002: "Maybe we can have an option to skip to next step
which stops the current step early and proceeds to next step with whatever work is available
for next step." Distinct from cooperative Stop (#310), which halts the whole run and keeps
the prior result.*

## Semantics

**Skip ends the CURRENT stage at its next event boundary and continues the run with whatever
that stage has produced so far.** One-shot: a skip applies to exactly one stage; skipping
twice requires two presses. Nothing is discarded — a skipped search stage feeds its partial
candidate set to the funnel exactly as a completed one would.

Stage applicability (the run's phases, `discovery_jobs.DiscoveryJob.phase`):

| Phase | Skippable? | What skip means |
|---|---|---|
| `queries` | no | one LLM call — nothing to end early (a skip pressed here applies to the NEXT stage; see "arming" below) |
| `searching` | **yes** | stop issuing remaining arXiv queries; proceed with candidates found |
| `library` / `gated` | no | fast deterministic merges — over before the button matters |
| `triage` | no | one LLM call over the gathered set |
| `citations` | **yes** | stop remaining citation lookups; proceed with what enriched |
| `evidence` | **yes** | stop remaining evidence fetches; rank on what's fetched |
| `scoring` | no | the final ranking call — skipping it would mean no result |

## Mechanism

Mirror of cancellation, scoped to a stage:

- `DiscoveryJob.skip_requested: bool` (+ `skips: int` counter for the snapshot/debugging).
- `POST /api/projects/{pid}/discover/skip` → sets the flag on the running job (404 when no
  run; no-op returning the snapshot when already set). Same tenancy/scope handling as
  `cancel_discovery`.
- `discovery.run` already threads `should_cancel` into its paced loops; it gains a
  `should_skip` callable checked at the same boundaries. On observing it, the loop breaks,
  the worker **clears the flag** (one-shot, under the same lock that guards
  cancel-vs-complete), and the run advances the phase. `should_cancel` still wins over skip.
- **Arming**: the flag is NOT cleared by non-skippable stages — a skip pressed during
  `queries`/`triage` applies to the next skippable stage. This matches the reader's intent
  ("get on with it") and avoids a press racing a phase flip into a dead no-op. The snapshot
  carries `skip_requested` so the client can show "skipping at the next boundary…".

## Client

Next to the existing Stop affordance on the Discover run screen: a quiet "Skip step" button,
visible while `status == running`, disabled (with the armed state shown) once
`skip_requested` is true. Copy on press: none — the phase timeline already animates the
advance, which is the feedback. The button label can name the stage ("Skip search") from the
snapshot's phase for clarity.

## Accounting

No admission change: the run's reservation was taken at start; skipping only reduces actual
spend (fewer paced provider calls, smaller evidence set). `per_unit` gating is untouched —
skipped units simply never start.

## Tests

- Unit: a `should_skip` that fires mid-`searching` ends the query loop, clears the flag, and
  the funnel proceeds with the partial set; the same for `citations`/`evidence`.
- One-shot: two stages cannot be skipped by one press.
- Cancel-beats-skip: both flags set → the run stops, result unchanged from Stop's contract.
- Route: skip with no run → 404; skip twice → idempotent snapshot.

## Status

Design only (this ledger row was "not designed or scoped"). Implementation is a
moderate-sized PR over `discovery.py`'s paced loops + `discovery_jobs.py` + one route + the
run screen's button; nothing blocks it on other work.
