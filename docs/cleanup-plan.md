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
| `app/**.py` | 30,978 lines, 8,261 "prose" (27%) | **This number turned out to be misleading — see Phase 2.** It counts docstrings and prompt text as commentary; real `#` comments run 13–17%. |

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

## Phase 2 — Comments — **DONE 2026-08-09, premise corrected**

**The 27% "prose" figure was wrong, and the plan built a phase on it.** It counted docstrings and
string literals as commentary. Counting only lines that actually begin with `#`:

| Module | "prose" | real `#` comments |
|---|---|---|
| `prompts.py` | 49% | **2%** |
| `jobs.py` | 42% | 17% |
| `config.py` | 39% | 17% |
| `agent_harness.py` | 38% | 13% |

`prompts.py` is 49% *prompt text*, which is the product. The plan suspected this and said to verify
before editing; verified, and it should not be touched. The other three sit at 13–17%, which is
ordinary. **There was no comment-density problem to fix.**

The 46 comment blocks of ≥9 lines were read rather than trimmed. They hold measured evidence and
traps — `llm.py`'s routing block is the justification for a published privacy policy and records
that a `mappingproxy` in a request body raises `TypeError` on every LLM call. Principle 6 applies:
length is not the bar.

**The real defect class is the stale promise** — a comment describing a future that has since
arrived, which then describes the opposite of what the code does. `grep` for "not yet", "next
slice", "will attach", "cannot yet" found three, all fixed:

- `tenancy.py` — "this slice records ownership; it does not enforce it … no route calls it to gate
  anything yet", in the module whose job is refusing unauthorized access (fixed in Phase 3).
- `quotas.py` — "Route/job integration lands in the next slice", with nine modules calling it.
- `routers/settings.py` — clients "still gate their whole form on `is_operator`, so a reader cannot
  yet reach their own preferences", which both clients have read since #240.

**Use that grep, not a line-count threshold.** A long comment is usually someone who learned
something the hard way; a comment promising the future is one that has probably already expired.

## Phase 3 — CLAUDE.md — **DONE 2026-08-09**

**304 → 241 lines**, all of it from the module map; the invariants and the environments section
were not touched.

The plan said to "let the detailed rationale live in the modules' own docstrings", which assumed it
already did. **It did not.** `projects.py`'s import trust boundary, `db.py`'s Data-API lockout
argument, `tts.py`'s `tts-1` decision, `sessions.py`'s retry branches and mutation lock, and
`audio_jobs.py`'s per-user scoping existed *only* in CLAUDE.md. So Phase 3 was a **move**, not a
delete — and what revealed that was reading each docstring before deleting the bullet that was
supposed to duplicate it.

That move is the actual win, not the line count. CLAUDE.md is loaded into **every** session (~9.5k
tokens); a module docstring is read only by someone working in that module, which is exactly when
its traps matter.

`tenancy.py`'s docstring still said **"this slice records ownership; it does not enforce it … no
route calls it to gate anything yet"** — written before M2 slice 2a, describing the opposite of what
the module now does, in the file whose entire job is refusing unauthorized access.

Also fixed: `auth.py` had been appended to the end of the `tts.py` bullet, so the auth module was
invisible in the map; and `llm.py` still said token accounting "will attach here" after M3 shipped
it. Verified by set difference that no module named in the old map lost its entry — `figures.py`
did, and was restored.

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
