# AGENTS.md — Research Companion

FastAPI backend (`app/`) plus an Expo/React Native client (`mobile/`) and a React+Vite SPA
(`web/`). You read a corpus of papers *with* an LLM. The record is markdown-in-git: every project
is its own git repository, and Postgres holds ownership and index rows only.

**Read `CLAUDE.md` first.** It carries the full working guidance, the module map, and the six
load-bearing invariants. This file is the review contract layered on top of it.

## Orienting a review: read these before judging a diff

A diff in this repo is almost never self-explanatory, because most of the risk is in an invariant
the changed file does not mention. Before reporting findings, establish *which milestone the change
belongs to* and *what it is allowed to assume*:

| Read | For |
|---|---|
| `CLAUDE.md` | The six invariants, the module map, and why each module is shaped the way it is. Non-negotiable context. |
| `docs/production/10-roadmap.md` | The live execution ledger. Its "Current position" section says what has landed, what is deliberately deferred, and which milestone the branch is serving. **Check a suspected omission against this before reporting it** — a gap that the ledger records as a later milestone's work is not a finding. |
| `docs/production/00-current-state-audit.md` | The numbered P0–P3 findings. If a diff closes one, verify it actually closes it; if it touches the area of an open one, say which. |
| `docs/production/02-security-and-privacy.md` | The code-derived data inventory and the Play Data Safety draft. A change to what is stored, logged, or sent off-device must keep this true. |
| `docs/improvements.md` | The standing code-quality plan, for anything structural. |

Two habits matter more than volume here:

1. **Verify a finding against the code before reporting it.** Sixteen review rounds on PR #220
   produced thirty-one defects, and essentially all of them were in the *fix* rather than in the
   code it replaced. A confidently wrong finding costs more than a missed nit.
2. **Distinguish "not done" from "not done here."** This repository is mid-way through a ten-
   milestone production plan. Metering, quotas, billing, and job persistence are scheduled work,
   not oversights.

## What counts as a serious finding

Report P0/P1 risk. Minor style, naming, formatting, or doc nits should not be reported unless they
mask one of the risks below.

### The six invariants (`CLAUDE.md` states them in full)

- **Long or LLM-touching operations are background jobs + polling** — never a blocking request or
  a connection-tied SSE stream. The deployment sits behind a proxy that kills any request at ~100s
  while the server keeps working, so a blocking endpoint silently discards a result it produced.
- **A background thread must rebind the active-project *and* active-user contextvars** before
  touching store/sessions/graph/settings. `threading.Thread` does not inherit contextvars, so a
  raw `Thread`, a `ThreadPoolExecutor.submit`, or an orphan worker that skips
  `config.bound_scope(pid, uid)` reads and writes the wrong user's files. `JobRegistry` does it
  correctly; anything spawning its own worker must too.
- **`app/store.py` stays deterministic** — no LLM calls, no network calls, and now no database
  calls either.
- **Nothing reaches the git record without human approval.** The agent proposes; a human approves;
  only then does `committer.py` / `notes_jobs.save` write and commit.
- **Keep the section-marker output protocol** (`###CANONICAL###` and friends) — do not convert
  analysis turns to JSON.
- **Single uvicorn worker.** Job registries, dedup, tombstones, and file writes are in-process.
  Do not introduce multi-worker assumptions without making that state process-safe.

### Tenancy and isolation (M2 — the highest-risk area in the repo)

- **The scope key is the composite `(user, project)`, everywhere** — job keys, locks, tombstones,
  caches, and path resolution alike. Two users will both plausibly have a project called `default`,
  so a pid-only key lets one join, poll, or cancel the other's work.
- **`may_access` is the gate.** `use_project` applies it for routes that name the project in the
  URL path. A route that names a project anywhere *else* — a request body, a `?project=` query, a
  cross-project scan — does not get it for free and must call it itself. That was the source of
  every miss when enforcement landed.
- **`projects.project_path` / `_safe_pid` is the trust boundary** that turns an untrusted id into a
  path. Every id-to-path caller must go through it.
- **Per-user paths are the isolation mechanism for audio**, not a check: `audio_jobs.user_audio_dir()`
  and `config.user_scope_dir()`. A new file under `.app-state/` that skips them is a leak.
- **Every `rc_*` table must be unreachable from Supabase's Data API.** The anon key ships inside
  the mobile app, so a table with no RLS and un-revoked `anon`/`authenticated` grants is publicly
  writable. `db._enforce_data_api_lockout` handles this for new tables automatically — flag
  anything that bypasses or disables it.
- **Guard against the *absence* of configuration, not a wrong value.** An unset variable must never
  be the permissive case. This has bitten three times (`auth.mode()` defaulting to open, `RC_ENV`
  defaulting to dev, a client capability flag defaulting to true).

### Destructive and irreversible paths

- Account deletion, project deletion, and the deployment guard remove data that git cannot restore.
  Exclusivity that was proven once and then assumed, an unbounded wait, or a drain that returns
  before the work it is draining has stopped are all P0-shaped here.
- A path that removes a tree must not follow a symlink out of the attributable store.

### Spend, secrets, and untrusted input

- Flag any new provider call that can be reached without an ownership check, and any path where one
  logical operation fans out into an unbounded number of paid calls.
- **Every outbound fetch of a URL the app did not choose itself goes through `app/safe_fetch.py`** —
  a client-supplied `pdf_url`, an LLM-proposed candidate, a stored `source_url`. A second
  hand-rolled fetcher is the exact shape of the SSRF that took sixteen rounds to close.
- Flag secrets, API keys, PII, paper content, or private commit summaries reaching logs or error
  responses. Never print a connection URL; `db.safe_target()` exists for that.

### Contract and integration risk

- Mobile/backend contract drift, stale endpoint behaviour, and unhandled async job error states.
- A change to an endpoint's shape needs `shared/api-types.ts` regenerated
  (`scripts/gen-api-types.sh`).
- A change under `web/src/` needs `web/dist/` rebuilt and committed — CI verifies this.

## Tests are part of the diff

Hold new tests to the standard the code is held to. Three failure modes recur and each has shipped
here:

- **A test that passes for the wrong reason.** The habit that catches it: revert the fix, require
  the test to go red, and confirm it reddens on the actual hazard rather than on a status string or
  a setup error. Verify the revert applied.
- **A test that has gone vacuous** — a loop or callback that no longer runs at all still passes
  every assertion inside it. Assert the thing ran.
- **Absence.** A bulk edit to a test file once silently deleted twenty-seven tests, including every
  SSRF regression, and the suite stayed green for two commits. Flag a diff that removes tests
  without saying so.

Isolation tests must give both users the **same** project id and the same paper slug and run
concurrently; a test that gives them different ids proves nothing.

## Running things

- Backend: `.venv/bin/python -m pytest -q` — the suite makes no external network calls, and must
  stay that way. Tenancy tests need `RC_TEST_DATABASE_URL`; they skip without it, so a review of
  database code should note when a claim is only covered by a skipped test.
- Lint: `.venv/bin/ruff check .`
- Mobile: `npm test` and `npx tsc --noEmit` in `mobile/`. Web: the same in `web/`.
- `RC_ENV` is required and has no default; `run.sh` and `tests/conftest.py` set `dev`.
