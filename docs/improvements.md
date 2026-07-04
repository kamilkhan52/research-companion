# Architecture review: improvements for scalability, agent-friendliness, and best practices

*Reviewed 2026-07: full backend (`app/`), mobile client (`mobile/src/`), tests, and repo tooling.*

## Where the codebase stands

The design is genuinely strong in the places that matter for this product: a deterministic
"spine" (`store.py`, `sessions.py`, `committer.py`) that never touches the network, LLM calls
isolated behind narrow seams, the job+poll pattern applied consistently after real production
failures (documented in module docstrings), injectable dependencies everywhere tests need
them, and an "agent proposes, human commits" invariant enforced structurally rather than by
convention. The docstrings are unusually good — they record *why*, including war stories.

The improvements below are about the gap between "excellent personal tool" and "codebase that
scales in users, contributors, and coding-agent sessions." Ordered by theme, with a suggested
sequencing at the end.

---

## 1. Backend architecture

### 1.1 Unify the five job modules into one framework (highest-leverage refactor)

`chat_jobs.py`, `audio_jobs.py`, `notes_jobs.py`, `graph_jobs.py`, and `discovery_jobs.py`
are five hand-rolled copies of the same machine: a dataclass with `status/started_at/
finished_at/error`, a module-level `_jobs` dict + `threading.Lock`, `_now()`, `_register()`
with `_MAX_FINISHED` pruning, `get_job`/`snapshot`/`active_for`, a `threading.Thread` runner
that must remember to rebind the project contextvar, and a broad `except Exception` that
truncates the error to 400 chars. That's ~600 lines of duplicated scaffolding, and each copy
has drifted slightly (e.g. `graph_jobs`/`discovery_jobs` key jobs by `pid` while the others
use UUIDs; `chat_jobs._run` calls `config.set_active_project(pid)` without keeping the token
to reset, while `graph_jobs._run` does it correctly with `try/finally`).

✅ **DONE** (branch `quality/job-framework`). Extracted `app/jobs.py`:

```python
class Job:            # id, status, error, timestamps, to_dict()
class JobRegistry:    # start_or_join(key, factory, work), get/snapshot(id), active_for(key),
                      # put(key, job) for cache-hit results, pruning
```

The registry owns the lock, the pruning, the thread spawn, the project-context rebind (1.2),
error capture, and a **persist-before-done** finalize (status flips to done only after `work`
returns, so a poller that sees "done" has always seen the side effects — this also structurally
fixed the discovery save/done race from Phase 1). All five modules migrated; each now defines
only its payload dataclass (a `Job` subclass) + a `work(job)` function. Public APIs and wire
shapes preserved; `test_jobs` covers the registry in isolation. This is also the precondition
for job persistence (1.4) — restart-amnesia can now be fixed once instead of five times.

### 1.2 Centralize the "carry the active project into a thread" invariant

✅ **DONE** (folded into 1.1): `JobRegistry.start_or_join` captures `active_project_id()` at
call time and rebinds it inside the worker thread, so feature code can no longer forget it. The
paragraph below is the original description.

The active-project contextvar (`config._active_project`) is the load-bearing piece of the
multi-project design, and every background thread must manually rebind it. The docstrings in
`graph_jobs._run` and `discovery_jobs._run` both warn "getting this wrong would silently
read/write the wrong project's data" — which is exactly the kind of invariant a future
contributor (or coding agent) will miss. Provide one helper and use it everywhere:

```python
def run_in_project(pid: str | None, fn, *args, **kwargs):
    token = config.set_active_project(pid)
    try:
        return fn(*args, **kwargs)
    finally:
        config.reset_active_project(token)
```

If the `JobRegistry` from 1.1 captures `active_project_id()` at start and wraps the runner,
the invariant becomes impossible to violate from feature code.

### 1.3 Extract a single LLM client module

✅ **DONE** (branch `quality/llm-client`). Added `app/llm.py` with `complete()` / `stream()`
owning auth headers, content-list flattening, empty/`finish_reason` (+ reasoning-token
exhaustion) diagnostics, error normalization to one `LLMError`, and **retry-with-backoff on
transient failures** (connect/read errors, 429/5xx) — so a single 502/timeout no longer kills a
whole paid turn or build. All four raw-HTTP callers migrated onto it: `agent` (analysis +
narration + streaming, translating `LLMError`→`AgentError`), `discovery._default_llm`
(→`DiscoveryError`), `graph.extract_references_for_paper` (→ per-paper error dict, still wrapped
in its wall-clock hard deadline). The Pydantic AI path in `agent_harness` keeps its framework
client by design. The model catalogue is now fetched once through a TTL-cached `llm.catalogue()`
(with `newest_matching()` for family resolution), shared by `/api/models`,
`/api/favorite_models`, and `graph.resolve_model()` instead of three separate uncached fetches;
a fetch failure serves the last-good catalogue rather than erroring. `test_llm` covers it in
isolation (network faked). This is also the single seam where token/cost accounting (§3.3) will
attach. Original description below.

OpenRouter is called through four separate hand-rolled paths:

- `agent._call_openrouter` / `agent._stream_openrouter` (headers, error normalization,
  content-as-list handling, empty-response detection — duplicated between the two),
- `graph.extract_references_for_paper` (its own httpx.post, its own headers, its own
  empty-content/reasoning-token diagnostics),
- `discovery.py`'s calls,
- Pydantic AI's `OpenAIChatModel` in `agent_harness`.

Consolidate the raw-HTTP paths into one `llm.py` with `complete()` and `stream()` that own:
auth headers, timeout policy, the content-list flattening, the empty/`finish_reason=length`
diagnostics, error normalization to one exception type, and **retry with backoff for
transient failures** (a single 502/timeout currently kills a whole turn; jobs made failures
survivable, retries would make many invisible). This is also the single point where token
usage and cost accounting can be recorded (see 3.3), and where a future second provider
would plug in.

The model catalogue is fetched from OpenRouter on every `/api/models`, `/api/favorite_models`
call and every `graph.resolve_model()` — three separate fetches, no cache. Give `llm.py` a
TTL-cached `catalogue()` and derive all three from it.

### 1.4 Job persistence and the single-process constraint

All job state is in-process memory. Two consequences worth addressing explicitly:

- **Server restart mid-job loses the job record** (the client's 404 handling papers over it,
  but a graph build or discovery run dies silently partway). Since graph/discovery already
  persist *results* incrementally, the missing piece is small: persist job snapshots to
  `.state/jobs.json` on transition (start/progress-milestone/finish) so a restarted server can
  report "interrupted" instead of nothing, and clients can distinguish "done while I was away"
  from "vanished".
- **The app is only correct with one uvicorn worker.** In-memory registries, the
  `active_for()` dedup, and file writes without locking all assume a single process. That's a
  fine choice for this product — but it is nowhere written down and nothing enforces it.
  Document it (CLAUDE.md, run.sh comment) and/or assert `workers == 1` at startup. If
  multi-user ever becomes real, this is the line item that becomes "move jobs to a persistent
  queue (SQLite table is enough) and poll it from any worker."

### 1.5 Harden the file store: atomic writes, locking, and cheap reads

The markdown-in-git store is the right call for this product, but the I/O layer under it has
three growing pains:

- **Non-atomic writes.** `settings.json`, `.state/sessions.json`, `reading-list.md`,
  `working-notes.md` are all written with `Path.write_text` — a crash mid-write corrupts the
  file (and several readers silently swallow `JSONDecodeError`, so corruption would present
  as "my settings/sessions disappeared"). Add one `atomic_write_text()` (write temp file in
  the same dir + `os.replace`) and use it for every write.
- **Read-modify-write races.** `config.save_settings`, `sessions.set_state` /
  `_save_index`, and `store.add_entry` each do load→mutate→save with no lock. A background
  job finishing (writes session state) while a request saves a setting or two turn-jobs for
  different papers finishing together can drop updates. A per-file (or per-project)
  `threading.Lock` in the single-process world is sufficient; combine with 1.4's constraint
  note.
- **O(everything) reads on hot paths.** `store.list_papers()` reparses `reading-list.md` and
  stats/reads corpus files on every call; `get_paper()` is `list_papers()` + linear scan and
  is called several times per request; `has_notes()` reads the **entire corpus file**
  (which contains the full paper text — often hundreds of KB) to look for `"\n## Notes"`;
  `projects.list_projects()` does this for every project. At 20 papers this is fine; at 200
  papers × several projects it's a visible tax on every poll. A tiny mtime-keyed cache of
  parsed entries (and reading only the file tail for the Notes marker) removes the whole
  class. Similarly, the narration cache (`.app-state/narration-cache.json`) is loaded and
  rewritten wholesale per lookup/insert and grows without bound — cap it or move it to
  per-hash files like the audio cache already does.

### 1.6 Split `main.py` (1,088 lines) into routers

`main.py` currently holds middleware, 20+ request models, SSE helpers, favorite-model
resolution logic, and ~50 routes. Split by feature into `app/routers/` (settings, audio,
chat, notes, graph, discovery, projects), keeping `main.py` as app assembly + middleware.
Move the request models next to their router and `FAVORITE_FAMILIES` resolution into the
`llm.py` catalogue module. This is mostly mechanical and pays off every time a coding agent
has to find "the route that does X."

Also worth doing while there: the seven SSE turn endpoints (`*_stream`) and seven job turn
endpoints (`*_job`) are parallel implementations of the same flows. The README already calls
the web client legacy; once mobile is the only client, retire the SSE turn endpoints (and
`/reply`, `/continue`, `/finish`, `/request_changes` blocking variants) — that deletes
`_turn_stream`, `_agentic_turn_stream`, `_stream_for`, and half the prep/endpoint matrix.

### 1.7 Get project-specific data out of application code

`store.py` hardcodes two things that belong to one particular project's content:

- `CITATION_GRAPH` — a citation map for the LLM-inference-serving reading list,
- `_SLUG_SPECIALS` — slug overrides for three specific paper titles.

Both already have file-based equivalents (`<!-- cites: ... -->` and `<!-- slug: ... -->`
comments in `reading-list.md`, which the parser honors). Migrate the hardcoded data into
that project's `reading-list.md` (a one-time script) and delete the constants. As it stands,
every new project silently inherits an unrelated project's citation graph if slugs collide,
and app code changes are needed to curate content — the exact coupling the multi-project
refactor was meant to remove.

---

## 2. API contract and typing

### 2.1 Typed responses end-to-end

`scripts/gen-api-types.sh` generates TS types from the OpenAPI schema — but nearly every
endpoint returns a hand-built `dict`, so the schema says little and `mobile/src/api/types.ts`
(400 lines) is hand-written, with `endpoints.ts` carrying the comment "Keep these 1:1 with
app/main.py" — a manual discipline that *will* drift. Define pydantic `response_model`s for
the endpoints (the dataclasses in `models.py` and the job `to_dict()`s are already the
shapes; converting them to pydantic models or adding parallel response models is mostly
transcription). Then the generated `shared/api-types.ts` becomes authoritative, the mobile
types file shrinks to re-exports, and drift becomes a compile error instead of a runtime
surprise. Add the generation + a `git diff --exit-code` check to CI so the contract can't
silently rot.

### 2.2 Stop reaching across module privacy

Several modules call other modules' underscore-private functions: `main.py` →
`projects._read_meta`; `notes_jobs.py` → `committer._git`; `agent_harness` →
`agent._parse` / `agent._system_for`; `notes_jobs` → `agent._stream_openrouter`. Each is a
signal that the private thing is actually a public seam. Promote them (`projects.read_meta`,
a shared `gitio.run()` used by both committer and notes saves, `agent.parse` already exists —
use it) so the public surface of each module is honest. Coding agents lean on naming
conventions to know what's safe to call and change; violating them invites bad edits.

---

## 3. Agent-friendliness (for coding agents and contributors)

### 3.1 Add a CLAUDE.md that encodes the invariants

There is no CLAUDE.md / contributor doc, yet this codebase runs on a handful of non-obvious,
hard-won invariants that currently live scattered in docstrings:

- **Every LLM-touching or minutes-long operation must be a background job + polling** — never
  a blocking request or connection-tied SSE (the tunnel kills anything >100s; three separate
  modules document live failures).
- **Background threads must rebind the active-project contextvar** before touching
  store/sessions/graph.
- **`store.py` never calls an LLM and never makes network calls**; nothing reaches the git
  record without human approval via `committer.py` / `notes_jobs.save`.
- **The section-marker output protocol** (`### CANONICAL ###` …) is deliberate — not JSON —
  because long scholarly prose breaks JSON escaping; parsers tolerate marker drift.
- Single-worker assumption (1.4), the dev-server-has-no-reload gotcha, how to run tests,
  what `RC_AGENTIC` flips.

Write these down in a top-level CLAUDE.md (with a short module map). This is the cheapest
single improvement in the whole document, and the one with the most compounding value for
agent-driven development.

### 3.2 Repo tooling: pyproject, lint, types, CI

There is currently no `pyproject.toml`, no linter, no type checker, and no CI (`.github/`
doesn't exist), for a codebase that is ~5,500 lines of typed-annotation Python plus a TS
client. Minimum viable setup:

- `pyproject.toml` declaring the project + tool config (replaces the bare requirements
  files or wraps them),
- **ruff** (lint + format) — the code style is already consistent; ruff just locks it in,
- **pyright or mypy** — annotations are already everywhere; make them checked. This will
  immediately flag real things (e.g. `RunnerFn` string-typed unions, `dict` payloads that
  should be TypedDicts),
- **CI**: pytest (the suite is genuinely good and network-free — it just needs to run on
  every push), ruff, pyright, `tsc --noEmit` + `expo lint` for `mobile/`, and the
  api-types drift check from 2.1.

### 3.3 Observability: logging and token accounting

There is **zero logging** in `app/` — no `logging` import anywhere. Failures surface only as
400-char-truncated strings on job objects, and successful operations leave no trace. For an
app whose core operations are paid, minutes-long LLM calls this hurts twice: debugging (the
graph module's elaborate error-snippet embedding exists precisely because there are no logs
to check) and cost awareness.

- ✅ **DONE** (branch `quality/logging`): added `app/logging_config.py` — stdlib `logging`
  under the `rc.*` namespace, one handler installed by `configure()` (called in `main.py`),
  level via `RC_LOG_LEVEL`. A contextvar filter stamps the active project id on every line, so
  a background-thread log is attributable without threading the id through. Log points at the
  single highest-leverage seams: `jobs.JobRegistry` (start/join/done/error + duration — covers
  all five job types at once), `llm` (retry warnings + final failure + catalogue-refresh
  failure), and `committer.commit` (slug/rev/message). `test_logging` covers the setup, the
  filter, and that the registry emits lifecycle lines.
- ✅ **DONE (backend)** (branch `quality/usage-tracking`): `app/usage.py` records every LLM
  call's usage from the one seam that sees them all (`llm.complete`/`llm.stream`). Cost is
  requested from OpenRouter directly (`usage.include` → `usage.cost`) rather than a local
  pricing table, so it stays correct as prices change; tokens are still recorded if a provider
  omits cost. Aggregated per project into `.state/usage.json`: a lifetime total plus by-model
  and by-operation (analysis / narration / graph_extraction / discovery / notes) breakdowns —
  the shape the eventual **credits model** reuses (per-user is one more key, not a redesign).
  Exposed at `GET /api/projects/{pid}/usage`; graph rebinds the project contextvar into its
  extraction executor threads so their spend attributes correctly (invariant 2). Recording is
  best-effort (never fails the turn) and no-ops without an active project. `test_usage` covers
  accumulation, breakdowns, missing-cost, corruption tolerance, and the complete/stream feeds.
  *Follow-up:* a Settings readout in the mobile client (`quality/usage-mobile`), and — when the
  agentic path (`agent_harness`, Pydantic AI's own client) is used — routing its usage here too.

### 3.4 Prompt management

`prompts.py` centralizes the user-editable workflow prompts, but the graph-extraction system
prompt lives as a constant in `graph.py`, discovery's prompts in `discovery.py`, and
`TOOL_GUIDANCE` / `NOTES_TOOL_GUIDANCE` in `agent_harness.py`. Move them all under the same
registry (even if not all are user-editable — flag which are), so there is one place to see
and version everything a model is told.

---

## 4. Correctness and robustness details

Smaller, concrete issues found while reading; none are crashing today, all are worth fixing:

1. **Settings can never be un-set.** ~~`config.load_settings` filters falsy file values
   (`if v`), so writing an empty string via the UI persists it but it's ignored on load —
   the env default silently comes back. Deleting an API key or reverting `prior_notes_scope`
   is impossible from the UI.~~ **Fixed:** `save_settings` now treats `""` as an explicit
   unset (clears the override, reverting to the env default) distinct from an absent key
   (`None`, unchanged), and `load_settings` honors stored values without the falsy filter.
   Note the *mobile* client still omits blank fields rather than sending `""`, so a "clear
   key" affordance in the UI is a small follow-up to expose this from the app.
2. **Per-request writes to global settings.** `_prep_chat_start` and `_prep_retry` persist
   the request's `model` via `config.save_settings`. On closer reading this is *intended*
   sticky-model UX (the compose-screen / retry picker becomes the new default, which
   `opening_draft` reads back) — the real hazard was the unlocked read-modify-write racing
   with a concurrent settings save and silently dropping a change. **Fixed:** `save_settings`
   and `set_prompt_override` now serialize on a shared lock; the sticky behavior is preserved.
   If cross-project model bleed (a turn in project A changing the global default for project
   B) is ever unwanted, thread the model through the turn instead — but that's a UX decision,
   not a bug.
3. **TOCTOU on turn start.** `_no_turn_in_flight(slug)` → `_prep_*` (mutates the session
   file) → `start_turn`. Two near-simultaneous requests can both pass the check, both record
   a user message, then one joins the other's job — leaving a duplicated user turn in the
   transcript. Make check-and-start atomic (one registry call under one lock) and do the
   session mutation inside it.
4. **CORS misconfiguration foot-gun.** `RC_CORS_ORIGINS=*` is documented, but
   `allow_origins=["*"]` combined with `allow_credentials=True` is rejected by browsers
   (Starlette silently sends no `Access-Control-Allow-Origin`). Special-case `*` or document
   that it can't be combined with credentials.
5. **Token in query string.** `?token=` for audio/SSE is pragmatic, but tokens land in
   server/proxy logs. Mitigate where cheap: short-lived signed media URLs, or at least note
   it as accepted risk. Related: `settings.json` holds API keys world-readable-by-default —
   `chmod 600` on write costs one line.
6. **SSRF guard has a resolve/fetch gap.** `_assert_public_url` resolves the host, checks the
   IPs, then httpx re-resolves for the actual fetch — a DNS-rebinding window. Low stakes
   here (read-only fetch, personal deployment), but pinning the resolved IP (custom
   transport) or re-checking on redirect would close it; at minimum document the accepted
   risk. Also note the guard only protects `_direct_fetch` — by design, since Firecrawl/
   Parallel fetch from their infrastructure — worth one comment saying so.
7. **`graph.py` is doing four jobs** (LLM extraction + salvage parsing, normalization/
   matching, graph analysis/scoring, orchestration) in 724 lines. The seams are already
   clean; split into `graph/extract.py`, `graph/analyze.py`, `graph/build.py` when next
   touched.
8. **Dead/legacy code**: `assembler.paper_opening_message` is unused (history building went
   through `sessions.build_history`); the `/api/speak` blocking endpoint and non-stream
   `/reply` family are superseded (see 1.6); `web/` itself should get an explicit
   deprecation plan — every API change currently pays a "does the legacy client still work?"
   tax.
9. **`store.derive_slug` collisions are only handled at add-time** (`add_entry` raises
   `DuplicatePaperError`) but two hand-edited reading-list entries with colliding derived
   slugs silently alias to one corpus file. Cheap fix: detect duplicates in `_parse_entries`
   and surface a warning in `/state`.
10. **Git commits assume an ambient git identity — a fresh deploy breaks.** ✅ **FIXED**
    (branch `quality/phase-2-medium`): `config.git_identity_args()` pins the author via
    `git -c user.name=… -c user.email=…` (env-configurable `RC_GIT_AUTHOR_NAME` /
    `RC_GIT_AUTHOR_EMAIL`, default `Research Companion` / `companion@local`), applied in both
    `committer._git` and `projects._git`, so every app-issued commit succeeds regardless of
    host git config. `test_git_identity` proves create_project's baseline commit and a
    committer note-commit both succeed and are correctly attributed with no ambient identity.
    Original description below.

    Every write to the
    record shells out to `git commit` (`committer.commit`, `notes_jobs.save` via
    `committer._git`, and `projects.create_project` / `adopt_existing`) with no author
    configured, so it relies on the machine having a global `user.name` / `user.email`. On a
    fresh server, container, or CI runner that never ran `git config --global`, this fails:
    `committer._git` raises `CommitError` ("empty ident name") so **approving notes errors
    out**, and `create_project`'s initial commit silently no-ops (its `_git` uses
    `check=False`), leaving a project with no baseline commit. Surfaced live as 8 CI failures
    (fixed *in the tests* by giving the `temp_project` fixture a repo-local identity — but the
    production paths are still exposed). This must be fixed before serving users on clean
    infrastructure. **Fix (spec):**
    - Set a repo-local identity in `create_project` / `adopt_existing` right after `git init`
      (`git config user.email …` / `user.name …`), so every project repo can commit from
      birth regardless of global config. Default to a configurable app identity via env, e.g.
      `RC_GIT_AUTHOR_NAME` / `RC_GIT_AUTHOR_EMAIL` (default `Research Companion` /
      `companion@local`, matching what the existing project repos already use).
    - Make `committer._git` / `projects._git` commit with a `-c user.email=… -c user.name=…`
      fallback (from the same env) so *pre-existing* repos that lack an identity are also
      covered defensively, not just newly created ones.
    - This deliberately changes commit authorship for new project repos to the app identity
      rather than the operator's personal global git config — which is the *correct* behavior
      for a hosted app, and the natural hook for per-user attribution once projects are scoped
      per user (see §5: use the authenticated user's name/email as the commit author).

---

## 5. Scalability path (only if multi-user is ever a goal)

Auth already verifies real users (`request.state.user`), but everything behind it is
single-tenant: one global settings file (API keys shared by all users), projects owned by
nobody, one shared audio/narration cache. If Supabase auth is a prelude to multi-user:

- scope settings and projects per user (`projects/<user>/<pid>` or ownership in
  `project.json`, checked in `use_project`),
- move job registries to a persistent queue as in 1.4,
- rate-limit/queue LLM spend per user.

If it is *not* a goal — write that down in CLAUDE.md too. Half of the "is this OK?"
questions in this codebase (in-memory jobs, file locks, global settings) are answered by
"single household deployment, one uvicorn worker," and making that explicit prevents both
over-engineering and accidental under-engineering.

---

## 6. Mobile client

The client is in good shape (typed endpoint wrappers, react-query, the job-polling hooks
mirror the server pattern well). Gaps:

- **No tests and no typecheck gate.** `useStreamingTurn`, `useSmoothText`, and the graph
  layout math are pure enough to unit-test cheaply; at minimum put `tsc --noEmit` in CI.
- **Hand-maintained `types.ts`** — replace with generated types (2.1).
- **Polling loops are per-hook `while` loops with `sleep`** (`useStreamingTurn`,
  `useGraphBuild`, `useNotesAgent`, `useDiscoveryRun` each reimplement poll/miss-count/
  settle). Same story as the backend jobs: extract one `usePolledJob` hook with pluggable
  fetch + settle, and the four hooks become thin.
- The double-tap guard / reattach logic in `useStreamingTurn` is subtle and correct — move
  its rationale comments into a short doc or keep them, but don't let a refactor drop them.

---

## Suggested sequencing

**Quick wins (hours) — DONE (branch `quality/phase-1-quick-wins`):**
✅ CLAUDE.md (3.1) · ✅ pyproject + ruff + CI running the existing tests (3.2) · ✅ atomic
writes (1.5, the write-atomicity slice) · ✅ settings unset bug (4.1) · ✅ settings-write
locking instead of dropping per-turn model persistence (4.2, revised) · ✅ chmod 600 settings ·
✅ deleted hardcoded `CITATION_GRAPH`/`_SLUG_SPECIALS` after migrating into the project file
(1.7). Still open from 1.5: read caching and the remaining read-modify-write locks (sessions
index, `store.add_entry`).

**Production-readiness (do before serving users on clean infrastructure):**
✅ Git-identity hardening (4.10) — done on `quality/phase-2-medium`: the app pins an
env-configurable commit author, so a fresh deploy/container commits the record without a
global git config.

**Medium (a day or two each):**
✅ Generic job framework + project-context helper (1.1, 1.2) — done on `quality/job-framework`.
✅ `llm.py` with retries + cached catalogue (1.3) — done on `quality/llm-client`.
Remaining: logging + token accounting (3.3) · router split of `main.py` (1.6) · pyright
clean-up (3.2) · store read caching (1.5).

**Larger / when the need is real:**
Typed response models + generated client types in CI (2.1) · retire SSE turn endpoints and
the legacy web client (1.6, 4.8) · job persistence (1.4) · multi-user scoping (5) ·
`graph.py` split (4.7).
