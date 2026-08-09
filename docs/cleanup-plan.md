# Docs and comment cleanup plan

> **Written to survive a context clear.** Everything needed to execute this is here or named by
> path. Written 2026-08-09, after the M3 enforcement stack (#325–#329) shipped to production.

## The problem, measured

Not an impression — these are counts taken on 2026-08-09.

| Surface | Size | Observation |
|---|---|---|
| `docs/**.md` | **9,271 lines across 40 files** | 10 files are referenced by nothing at all |
| `docs/production/10-roadmap.md` | **1,740 lines** | CLAUDE.md calls it "the live ledger"; ~60% is historical archive |
| `docs/production/HUMAN_ACTIONS.md` | 829 lines | untouched since 2026-07-29 |
| `docs/product-roadmap.md` | 775 lines | overlaps the device-review ledger and round-queue files |
| `app/**.py` | 30,978 lines, **8,261 prose (27%)** | `prompts.py` 49%, `jobs.py` 42%, `config.py` 39%, `agent_harness.py` 38% |

**The failure mode this causes is not verbosity, it is contradiction.** While surveying for this
plan I found `_NOT_BILLED_STATUSES` in `app/agent_harness.py` carrying *two stacked rationales
reaching opposite conclusions* about 5xx statuses — an edit had added a new explanation without
removing the one it replaced. The code followed the second; a reader hitting the first would
conclude the code was wrong. Fixed in **#331**. That is the concrete cost: comments that grow by
accretion stop being a description of the code and become a second, competing source of truth.

## Principles to apply

Judgement calls, so the rule matters more than any individual edit:

1. **Keep the non-obvious "why", delete the derivation.** "OpenRouter commits the 200 status once
   the first token is written, so a non-200 never carries a billed completion" earns its place. The
   arithmetic showing $0.15 × 33 turns does not — that belongs in the commit that derived it, which
   is still reachable via `git log -S`.
2. **A comment that restates the code is worse than none**, because it has to be maintained.
3. **One fact, one home.** If it is in the roadmap it does not also go in CLAUDE.md, the ledger, and
   a design doc. Cross-reference instead.
4. **Ledgers hold what is live; history goes to an archive file or stays in git.** A 1,740-line
   "live ledger" is not one.
5. **Never delete the war stories that encode an invariant.** The docstrings in `graph_jobs.py`,
   `audio_jobs.py`, `chat_jobs.py` explaining why long ops are jobs (invariant 1) are load-bearing;
   so is `db.py`'s explanation of why the Data-API lockout is not a migration. Distinguish "this
   explains a trap that will otherwise be re-entered" from "this narrates how we got here."
6. **When in doubt, keep it.** Deleting a hard-won explanation is expensive; a slightly long comment
   is cheap. The bar for deletion is redundancy or contradiction, not length alone.

## Phase 1 — Docs: delete and archive (highest value, lowest risk) — **DONE 2026-08-09**

**1a. Retire superseded plan documents.** The plan claimed seven were "referenced by nothing."
**Three of them were**, which is why the sweep runs before the delete and not after:

| File | Lines | Outcome |
|---|---|---|
| `docs/mobile-ui-polish-plan.md` | 329 | **deleted** — its "Round 2 is next" framing was ten rounds stale, and phase D's label-LOD lever is contradicted by the code that cites it |
| `docs/round12-queue.md` | 56 | **deleted** — every row reconciled into the ledger; the mapping for its secondary-polish backlog was written into the ledger first |
| `docs/web-mobile-parity.md` | 38 | **deleted** — describes the web client the rebuild is replacing |
| `docs/device-pass-mobile-auth.md` | 38 | **deleted** — one-off, resolved; duplicates CLAUDE.md's device section |
| `docs/device-test-r12-followups.md` | 270 | **kept** — four `implemented — verify` ledger rows point at it for the actual acceptance steps, and the ledger's own header names follow-up files as part of its design |
| `docs/discovery-quality-evaluation.md` | 60 | **kept** — it is the only prose explaining what the live `tests/fixtures/discovery_quality.json` proves, and the rebuild deliberately reuses its blended score. Given a header marking the pipeline half as history |
| `docs/initial-plan.md` | 282 | **kept** — labeled history with an accurate staleness warning, so it is neither redundant nor contradictory: it does not meet the bar in principle 6 |

Deletion is safe **because git keeps them** — that is the whole argument. One PR, every deleted file
listed in the commit body with one line on why.

**1b. Split `10-roadmap.md`.** **Done: 1,740 → 480**, with `docs/production/90-history.md` (1,271)
for completed milestones M1/M2/M2.5/M3, the bring-up handoffs and the R14 pass, and
`docs/production/40-device-test-runbook.md` (28) for the procedure. The roadmap keeps current
position, what is still open, locked decisions, architectural rules, the milestone table, and
M4–M11.

Two things that split badly and will again: the roadmap's headings had **drifted from its content**
— 188 lines of staging/cost history sat under the "Device-test runbook" heading, so a line-range
split by heading silently mis-files them. And the milestone table's statuses were stale in the
direction that matters (M3 read `queued` after it shipped). **Verify a split is lossless by set
difference, not by eye**: every non-blank original line must appear somewhere in the outputs, and
each one that does not must be a rewrite you can name.

**1c. Audit `HUMAN_ACTIONS.md`.** Done — and it held the **most consequential contradiction in the
repo**. H8 told Kamil to create the Play listing for `com.kamilkhan.researchcompanion`; the app has
shipped `io.scholiast.app` since the rebrand, and **Play freezes the package name on first upload**.
A stale doc would have caused an irreversible mistake in the one place this project cannot take one.
The same name was wrong in `00-current-state-audit.md` and in H5's OAuth note, along with the
`researchcompanion` deep-link scheme (now `scholiast`). Also refreshed: the "waiting on Kamil"
summary (11 days stale, pointing at a roadmap section that no longer exists) and H15, which M3
narrowed from "set the tier system" to "set the numbers".

Not moved to history. The done H-items are mostly operational traps — the `@` in the Postgres
password, the Supabase bootstrap ordering — and they are worth more where an operator will hit them
than filed as history.

**1d. Resolve the four-way overlap.** Mostly already resolved by the ledger's own header. Made
explicit both ways: `current-device-test-checklist.md` now opens with a "what lives where" note
saying a failure recorded there opens a `DR-###` row rather than becoming a queue of its own.

**1e. The orphans: indexed, not deleted.** All five are live or are rationale for shipped features —
`plan-usage-surface-spec.md` is the open remainder of M3. Being referenced by nothing is the actual
defect, and deleting them would be treating the symptom: an unreachable design doc is one that gets
re-derived rather than read. **`docs/README.md` now indexes every file** with the authority order
between them, and a scripted check confirms all 35 links resolve and no `.md` under `docs/` is
missing from it.

## Phase 2 — Comments: the four densest modules

Target `prompts.py` (49%), `jobs.py` (42%), `config.py` (39%), `agent_harness.py` (38%).

`prompts.py` at 49% is likely fine and possibly should not be touched — it is mostly prompt *text*,
which is the product, not commentary. **Verify that before editing it**, and if so say so in the PR
rather than silently skipping it.

For the other three, the specific pattern to remove is **stacked rationale**: a fix explained, then
a later fix explained beneath it, with the earlier one never removed. `#331` is the worked example.
Search for it with consecutive-comment-run detection:

```
# blocks of >=8 consecutive comment lines are the candidates, not automatically wrong
```

Known long blocks as of writing: `agent_harness.py:79` (13 lines), `jobs.py:155` (18),
`jobs.py:580` (10), `spend_ceiling.py:295` (11).

**Do not bulk-edit.** Every removal is a judgement call against principle 5.

## Phase 3 — CLAUDE.md (304 lines)

It is doing two jobs: invariants (load-bearing, keep every word) and a module map that has drifted
toward prose. Tighten the module map to one or two lines per module with pointers, and let the
detailed rationale live in the modules' own docstrings. **Do not touch the six invariants or the
"Environments and deployment" section.**

## Verification

Docs have no test suite, so the checks are:

- `git grep -n "<deleted-filename>"` returns nothing after each deletion — a dangling reference is
  the only way a docs PR actually breaks something.
- For comment edits: **full suite green** (`RC_TEST_DATABASE_URL=… .venv/bin/python -m pytest -q`,
  unpiped exit code) and `ruff check app tests`. A comment-only change that fails either means a
  docstring was load-bearing — likely a doctest or a prompt string.
- **Read the diff of every comment deletion.** If the removed text explains a trap, restore it.
- One PR per phase, so any single revert is clean.

## Known traps

- **CI is path-filtered** (`.github/workflows/ci-*.yml`); a docs-only PR reports *no checks*, which
  is correct and not a billing block. A billing block looks like ~3s runs with 0 steps.
- `main` is checked out in `.claude/worktrees/device-main`, so `git checkout main` in the primary
  clone fails. Work on a branch off `origin/main`.
- **`web/dist` must be rebuilt and committed** if `web/src` changes — not expected here, but CI
  verifies it.

## Explicitly out of scope

The AAB and any store/release packaging — the app needs a new name first (`scholy-name-research`).
