# CLAUDE.md — working in this repo

Guidance for coding agents (and humans) working on the Research Reading Companion. Read this
before making changes; it encodes invariants that are load-bearing but not obvious from any
single file. `README.md` is the product overview; `docs/improvements.md` is the standing
code-quality plan; `docs/product-roadmap.md` is the execution ledger for the current product
experience work. Update its PR/status table as each phase is reviewed and merged.

## What this is

A FastAPI backend (`app/`) plus an Expo/React Native client (`mobile/`, the active client;
`web/` is being rebuilt as a React+Vite SPA — see `docs/web-rebuild-plan.md`). You read a corpus of papers *with* an LLM: scholarly discussion, listen-
friendly audio, reading notes that compound into context for the next paper, and a per-project
reference graph. Data is markdown-in-git: each project under the effective Projects root is its
own git repo. `RC_VAULT_ROOT` can place the actual `Projects/` and authoritative `Prompts/`
inside an Obsidian vault. App-global state (keys, model/TTS picks, legacy prompt overrides,
last-valid prompt state, caches) lives in `.app-state/`. Repo-local defaults are gitignored.

## The invariants (do not break these)

1. **Long or LLM-touching operations are background jobs + polling — never a blocking request
   or a connection-tied SSE stream.** The deployment runs behind a Cloudflare quick tunnel that
   kills any HTTP request after ~100s (524); the server keeps working, so a blocking endpoint
   "fails" on the client while succeeding server-side, silently discarding the result. Every
   minutes-long flow (chat turns, audio prep, graph builds, discovery, notes edits) runs in a
   background thread that persists its result server-side the moment it finishes, and clients
   poll a cheap snapshot endpoint. See the docstrings in `app/graph_jobs.py`,
   `app/audio_jobs.py`, `app/chat_jobs.py` for the war stories. New long operation ⇒ same
   pattern.

2. **Background threads must rebind the active-project contextvar before touching
   store/sessions/graph.** The active project for a request lives in `config._active_project`
   (a `contextvars.ContextVar`), set by the `projects.use_project` FastAPI dependency.
   `threading.Thread` does **not** inherit contextvars, so every job runner must call
   `config.set_active_project(pid)` first (and reset it in `finally`). Getting this wrong
   silently reads/writes the *wrong project's* files. `graph_jobs._run` / `discovery_jobs._run`
   do it correctly; follow them.

3. **`app/store.py` never calls an LLM and never makes network calls.** It is the pure
   deterministic spine (parse reading-list.md, derive slugs, read/write corpus + notes). Keep
   it that way — network/LLM logic belongs in the agent/retriever/graph layers.

4. **Nothing reaches the git record without human approval.** The agent *proposes* (a
   `ProposedCommit` on a turn); a human approves; only then does `committer.py` /
   `notes_jobs.save` write files and `git commit`. Adding a reading-list entry
   (`store.add_entry`) deliberately does *not* retrieve text or commit. Preserve "agent
   proposes, human commits."

5. **The section-marker output protocol is deliberate — not JSON.** Analysis turns return
   `###CANONICAL###` / `###STATE###` / `###COMMIT_SUMMARY###` / `###NOTES_BLOCK###` /
   `###SYNTHESIS###` (see `app/prompts.py`), parsed by `agent._parse`. Long scholarly prose
   with equations/quotes/links breaks JSON string escaping, so we use markers and a tolerant
   parser (accepts markdown-heading drift). Don't switch turns to JSON output.

6. **Single uvicorn worker.** Job registries, dedup, and file writes are in-process and assume
   one process. `./run.sh` starts one worker; don't add `--workers N` without first moving job
   state and file writes to something process-safe. This is a deliberate "single-household
   deployment" choice, not an oversight.

## Module map (`app/`)

Each module's own docstring carries its rationale — the traps, the decisions and why they went the
way they did. This is an index, not a substitute for reading them.

- `main.py` — FastAPI **app assembly only**: auth middleware, router registration, static SPA
  mount. Routes live in `routers/`.
- `routers/` — HTTP routes, one module per feature area, each owning its routes, request models and
  helpers. App-global routes hang off a plain `router`; per-project routes hang off
  `routers.make_project_router()`, which pre-binds the `/api/projects/{pid}` prefix and the
  `use_project` dependency (a module may expose both). Modules: `system`, `settings`, `catalogue`,
  `projects_api`, `usage`, `audio`, `session` (retrieval + every turn-delivery path), `notes`
  (notes + review/approve + add-paper), `discovery`, `graph`, `account`, `legal`, `covers`,
  `figures_api`. A new route goes in its feature module, or a new module registered in `main.py` —
  never in `main.py` itself.
- `config.py` — settings (app-global), the active-project contextvar, vault/path precedence.
- `auth.py` — Supabase / static-token / open auth, and `assert_environment_safe`.
- `projects.py` — multi-project registry; `use_project` binds the contextvar. Also project sharing
  by git bundle. **`project_path`/`_safe_pid` is the trust boundary** for untrusted project ids, and
  **import is a second one** — read the docstring before touching either.
- `tenancy.py` — who owns which project, and `may_access`, the gate. **A route that names a project
  anywhere but the URL path must call it itself.**
- `db.py` — the Postgres pool, the `:6543` pooler refusal, the migration runner, and the Data-API
  lockout. Ownership and index rows only; content stays in git (invariant 4). Optional: unset
  `RC_DATABASE_URL` and every caller falls back to single-tenant. Never log the URL — `safe_target()`.
- `store.py` — the deterministic spine (reading list, corpus, notes). No LLM, no network.
- `sessions.py` — per-paper session state, transcript JSONL, narration cache, retry branches.
  Transcript-rewriting routes hold `sessions.mutation_lock(slug)`.
- `assembler.py` — builds the per-turn reading context (method, working notes, prior notes).
- `agent.py` — analysis turn (single-shot + streaming), stage-2 narration, the marker parser.
- `agent_harness.py` — the agentic tool-loop turn via Pydantic AI. The default path; `RC_AGENTIC=0`
  opts out.
- `llm.py` — the one raw-HTTP OpenRouter client: `complete`/`stream` plus a TTL-cached
  `catalogue()`. Every raw LLM call goes through it and is metered there; `agent_harness` keeps its
  Pydantic AI client by design.
- `safe_fetch.py` — the guarded path for fetching any URL the app did not choose itself. Public
  destinations only, every redirect re-validated, a required byte ceiling, a wall-clock deadline,
  and no decompression. **A new outbound fetch of an untrusted URL goes through it.**
- `research_tools.py` — read-only tools the agent can call (project reads + web search/fetch).
- `figures.py` — figure extraction. Keeps its own fetchers (it pins hosts to arxiv/ar5iv) but uses
  `safe_fetch`'s `is_global` test.
- `model_provenance.py` — frames untrusted text before it reaches a model.
- `user_settings.py` — the per-user half of `/api/settings`, layered over the instance document.
  Adding a preference needs a migration: a CHECK constraint mirrors the allowed keys.
- `prompts.py` — prompt registry + live Markdown loader with last-valid fallback.
- `logging_config.py` — `rc.*` stdlib logging. Log at job lifecycle, LLM boundaries and commits —
  never in the deterministic store.
- `usage.py` — per-project token/cost accounting in exact nano-USD. Best-effort, never fails a turn.
- **The spend stack** (M3) — four modules, one job each. Keep the split; it is what stopped the
  ceiling growing a second source of truth.
  - `quotas.py` — the durable reservation LEDGER. Knows nothing about what anything costs. Fails
    CLOSED: a ceiling that opens when its store is down is not a ceiling.
  - `spend_limits.py` — the PRICES: monthly ceiling, per-operation maximum, per-operation lease.
  - `spend_ceiling.py` — the in-process BINDING: `hold`/`settle`, the reservation contextvar, and
    `per_unit` for a job that must be gated per unit of paid work rather than by its admission
    ticket alone.
  - `plans.py` — the named plans (`tester`/`free`/`basic`). One plan per DEPLOYMENT today.
- `operation_limits.py` — per-CALL ceilings (max completion tokens, per-attempt timeout), as
  distinct from the per-ACCOUNT monthly bound: one runaway request costs real money in a single
  shot, long before the monthly ledger notices.
- `retriever.py` / `retrieval_agent.py` — arXiv/PDF retrieval; agentic PDF hunt fallback.
- `committer.py` — the one component that writes approved changes and git-commits.
- `graph.py` / `graph_store.py` / `graph_layout.py` / `citations.py` — reference graph pipeline.
- `discovery.py` — goals → ranked reading suggestions.
- `jobs.py` — the shared `JobRegistry` behind every background job: thread spawn, the contextvar
  rebind of invariant 2, error capture, and persist-plus-reservation-settle before publishing
  done/error. Cooperative Stop is visible immediately, but `finished_at` remains null until its
  worker and accounting finalize.
- `*_jobs.py` (`audio`, `chat`, `preview`, `graph`, `discovery`, `notes`, `retrieval`, `canonical`,
  `reference`, `cover`) — background-job modules (invariant 1). Each defines a payload dataclass and
  a `work(job)`, delegating lifecycle to a `JobRegistry`. Keep new long ops to this shape.
  `audio_jobs.py` additionally scopes everything **per user**, by path rather than by check.
- `tts.py` — OpenAI TTS behind a swappable interface. Default `tts-1`, chosen because
  character pricing makes audio cost computable before synthesis.

## Dev workflow

- **Run backend:** `./run.sh` (boots venv, installs deps, serves `:8000`, one worker, **no
  `--reload`** by default). After backend edits you must **restart** it — a stale server answers
  routes added since startup with **405** (the static catch-all mount handles unknown POSTs).
- **Dev auto-reload (opt-in):** `RC_RELOAD=1 ./run.sh` restarts the worker on changes under
  `app/`, so new routes stop 405-ing without a manual restart. The watch is deliberately scoped
  to `--reload-dir app`: uvicorn's reloader watches the CWD by default, and the app writes to
  `projects/` and `.app-state/` constantly (session index, audio cache, git commits), so an
  unscoped `--reload` would reload-loop forever. A reload is a **full process restart** — it
  drops the in-memory job registries and kills any in-flight background job (invariants 1/6), so
  don't save mid-job when you care about the result. Leave it **off** for the tunnel deployment.
- **Second instance for verification** (don't disturb the live server): `.env` pins `RC_PORT`
  and `run.sh` exports `.env` last, so bypass it — `RC_ENV=dev .venv/bin/uvicorn app.main:app
  --host 127.0.0.1 --port 8901`. **`RC_ENV` is now required** and bypassing `run.sh` bypasses the
  default it sets, so a bare `uvicorn` invocation refuses to start. That is deliberate: an unset
  `RC_ENV` used to mean "dev", which would let a deployed container that lost its environment boot
  with authentication disabled. See "Environments" below.
- **Tests:** `.venv/bin/python -m pytest -q`. The suite makes no EXTERNAL network calls
  (extraction/citations are injected fakes; see `tests/conftest.py`) — keep it that way. Not
  socket-free, though: two tests in `tests/test_safe_fetch.py` bind a loopback listener on purpose,
  because a slow-drip server is the one failure an `httpx.MockTransport` cannot express (it returns
  a response object without ever doing a socket read). Reach for that only when the behaviour under
  test *is* the transport.
- **Mobile:** see `mobile/README.md`. Typecheck with `npx tsc --noEmit` in `mobile/`.
- **Web:** `cd web && npm run dev` (Vite HMR on `:5173`). Build: `npm run build` (outputs to
  `web/dist/`). Test: `npm test`. Typecheck: `npx tsc --noEmit`. The backend auto-detects
  `web/dist/` and serves it; set `RC_WEB_DIR` to force a different directory. See
  `docs/web-rebuild-plan.md` for the phased rebuild status.
- **API types:** `scripts/gen-api-types.sh` regenerates `shared/api-types.ts` from the
  OpenAPI schema (offline). Run it when you change an endpoint's shape.
- **Testing on Kamil's physical phone (the normal device-verification path).** The phone is an
  Android **Expo dev build** (not Expo Go — the project depends on `expo-dev-client`; its
  launcher shows "Research Companion / Development Build"). The phone is usually **not on the
  same Wi-Fi** as the dev Mac, so both the app JS *and* the backend reach the Mac over **two
  independent public tunnels**:
  1. **Backend tunnel** — `./tunnel.sh` runs a cloudflared *quick tunnel* to `:8000` and prints a
     `https://<random>.trycloudflare.com` URL (this is the ~100s-timeout tunnel behind invariant
     1). The URL changes every run. Enter it in the app under **Settings → server URL**; it is
     persisted client-side as `rc.baseUrl` in AsyncStorage (see `mobile/src/api/config.ts`), so
     the phone keeps the last one until you paste the new one. Not secret; can also be baked via
     `app.json` `extra.apiBaseUrl`.
  2. **Metro/JS-bundle tunnel** — `cd mobile && npx expo start --tunnel` (uses `@expo/ngrok`)
     prints an `exp://<random>.exp.direct` URL. Paste that into the dev-build launcher's `exp://`
     field (or scan its QR), and reload. Plain `npx expo start` only yields a LAN URL, which the
     phone can't reach off-Wi-Fi. **Known gotcha:** the ngrok service Expo's `--tunnel` relies on
     has outages ("failed to start tunnel / remote gone away" or "Cannot read properties of
     undefined (reading 'body')") — that's ngrok-side, not the code. When it's down, fall back to
     putting the phone and Mac on the **same network** (e.g. Mac joins the phone's hotspot) and
     use the plain-LAN `exp://10.x.x.x:8081` URL — no ngrok needed.
  **Stable backend path (preferred since 2026-07): Tailscale.** The phone (oneplus-15) and
  the dev Mac are both on the tailnet, so the backend has a PERMANENT address —
  `http://100.83.161.127:8000` (the Mac mini's tailnet IP; MagicDNS equivalent
  `http://kamils-mac-mini.tail65e110.ts.net:8000`). It is baked into the app as
  `app.json → extra.apiBaseUrl`, so a fresh install (e.g. an EAS build with empty
  AsyncStorage) connects with no setup; a URL saved in Settings still overrides it.
  HTTP-over-tailnet is WireGuard-encrypted on the wire and tailnet-private;
  `expo-build-properties` sets `usesCleartextTraffic` so release/EAS profiles allow it. The
  cloudflared quick tunnel above remains the fallback for a device NOT on the tailnet (its
  URL is ephemeral). If Tailscale HTTPS certs get enabled in the admin console,
  `tailscale serve` can upgrade this to a real https URL. The Metro `exp://` tunnel is still
  per-session, so a device test = restart `./run.sh`, start the Metro tunnel, reload — the
  backend URL takes care of itself on-tailnet.

## Environments and deployment (M1 onward)

`RC_ENV` ∈ `dev | staging | prod` and is **required** — unset is refused at startup rather than
defaulting to `dev`. The whole gating design assumes the dangerous configuration is *absence*, not
a wrong value: `auth.mode()` falls back to `open` when no auth variable is set, and an unset
allowlist would mean "everyone", so forgetting one variable must fail closed. `run.sh` and
`tests/conftest.py` set `RC_ENV=dev`; the Dockerfile defaults the image to `prod` so a container
can never accidentally be dev.

In `staging`/`prod`, `app.auth.assert_environment_safe()` (called from `main` at import) refuses to
start unless: auth mode is Supabase, `RC_SUPABASE_ANON_KEY` is set (URL alone reports "supabase"
but leaves clients unable to sign in), `RC_AUTH_TOKEN` is unset, `RC_DEV` is off, and
`RC_ALLOWED_USERS` lists at least one user. The allowlist is the interim gate until per-user
ownership lands — Supabase sign-up is self-service, so authentication alone does not restrict who
reaches this single-tenant instance. A valid user who is not allowlisted gets **403**, not 401.

**Deployment** is Fly.io: `fly.toml` (production, app `research-companion`) and `fly.staging.toml`
(`research-companion-staging`), one machine each with a persistent volume at `/data` holding
`projects/` and `.app-state/`. Deploy with `flyctl deploy -c fly.staging.toml --remote-only --yes`
(remote builder — the local Docker daemon is usually not running). Secrets via `flyctl secrets set`,
never in the repo.

Two Fly settings are correctness, not tuning: `auto_stop_machines = "off"` with
`min_machines_running = 1` (Fly's default stops idle machines, which would kill background jobs —
invariant 1), and exactly one machine (invariant 6). **A deploy still stops the machine**, so
in-flight jobs die: until the drain hook lands with M6, check for active jobs before deploying.

The full production plan is `docs/production/` — `10-roadmap.md` is the live ledger (what is
open); completed milestones and dated handoffs are in `90-history.md`.

## Conventions

- Env vars are prefixed `RC_`. The agentic tool loop is the default turn path; `RC_AGENTIC=0` restores the single-shot analyst (no tools).
- Commits into a project's git store are made by the app with a pinned author
  (`config.git_identity_args()`, from `RC_GIT_AUTHOR_NAME` / `RC_GIT_AUTHOR_EMAIL`), so they
  never depend on the host's global git config. New commit paths must go through
  `committer._git` / `projects._git` (or otherwise include those `-c` args), not a bare
  `git commit`.
- Errors surface to clients as `HTTPException(detail=...)`; each domain layer raises its own
  exception type (`AgentError`, `RetrievalError`, `CommitError`, `ProjectError`, `GraphError`,
  `NotesError`, `TTSError`, `AuthError`) which the route handlers in `routers/` catch and map to
  HTTP status codes.
- Client-facing "quick" actions (approve, reopen, add paper) may be plain POSTs; anything that
  generates or runs minutes-long must be a job (invariant 1). See `mobile/src/api/endpoints.ts`
  — the `turnJobPaths` comment spells this out.
