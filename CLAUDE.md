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

- `main.py` — FastAPI **app assembly only**: auth middleware, router registration, static SPA
  mount. The routes themselves live in `routers/` (below).
- `routers/` — HTTP routes, one module per feature area, each owning its routes + the request
  models + helpers they use. App-global routes hang off a plain `router`; per-project routes
  hang off `routers.make_project_router()`, which pre-binds the `/api/projects/{pid}` prefix and
  the `use_project` dependency in one place (a module may expose both). Modules: `system` (health/
  auth-config), `settings`, `catalogue` (models/favorites), `projects_api` (project mgmt + state),
  `usage`, `audio`, `session` (retrieval + all turn-delivery paths: SSE/job/plain), `notes`
  (notes + review/approve + add-paper), `discovery`, `graph`. Add a new route to its feature
  module (or a new module + `include_router` in main.py), not to main.py.
- `config.py` — settings (app-global) + the active-project contextvar + vault/path precedence.
- `projects.py` — multi-project registry; `use_project` dependency binds the contextvar.
  `project_path`/`_safe_pid` is the trust boundary that turns an untrusted project id into a
  path — it rejects traversal/absolute ids, so every id-to-path caller must go through it.
- `store.py` — the deterministic spine (reading list, corpus, notes). No LLM, no network.
- `sessions.py` — per-paper session state + transcript JSONL + narration cache + retry
  branches (U.14): a retry archives the live tail under `.state/branches/` (working state,
  never committed — the transcript itself IS committed) and `/branch_switch` swaps tails;
  commits finalize the chosen branch (`proposal_committed` stamp inside the approved
  commit). Transcript-rewriting routes hold `sessions.mutation_lock(slug)` across their
  check-then-mutate sequence; keep new ones doing the same.
- `assembler.py` — builds the per-turn reading context (method, working notes, prior notes).
- `agent.py` — analysis turn (single-shot + streaming) and stage-2 narration; the marker parser.
- `agent_harness.py` — agentic tool-loop turn via Pydantic AI (behind `RC_AGENTIC`).
- `llm.py` — the one raw-HTTP OpenRouter client: `complete`/`stream` (auth, retries+backoff,
  empty-response diagnostics, `LLMError`) + a TTL-cached model `catalogue()`. Every raw LLM
  call goes through it (agent/discovery/graph translate `LLMError` into their own error type);
  `agent_harness` keeps its Pydantic AI client by design. Token/cost accounting will attach here.
- `research_tools.py` — read-only tools the agent can call (project reads + web search/fetch).
- `prompts.py` — current prompt registry + live Markdown loader with last-valid fallback.
- `logging_config.py` — `rc.*` stdlib logging: `configure()` (idempotent, called in `main.py`)
  + `get(name)`; a contextvar filter stamps the active project on every line. Log at job
  lifecycle, LLM boundaries, and commits — not in the deterministic store.
- `usage.py` — per-project LLM token/cost accounting (`.state/usage.json`), fed by `llm.py`
  (cost from OpenRouter's `usage.cost`, stored as exact integer nano-USD). Records against the
  active project (invariant 2); best-effort, never fails a turn. Audio narration bills the
  initiating project (or an app-global `UNATTRIBUTED` ledger); a billed-but-unknown stream stores
  a reconcilable `pending` record and flags totals `estimated`. `GET /api/projects/{pid}/usage`
  (`summary()`). Foundation for credits.
- `retriever.py` / `retrieval_agent.py` — arXiv/PDF retrieval; agentic PDF hunt fallback.
- `committer.py` — the one component that writes approved changes + git-commits.
- `graph.py` / `graph_store.py` / `graph_layout.py` / `citations.py` — reference graph pipeline.
- `discovery.py` — goals → ranked arXiv reading suggestions.
- `jobs.py` — the shared `JobRegistry` behind every background job (dict+lock, pruning, thread
  spawn, the contextvar rebind of invariant 2, error capture, persist-before-done finalize).
- `*_jobs.py` (`audio`, `chat`, `preview`, `graph`, `discovery`, `notes`) — background-job modules (see
  invariant 1). Each defines its payload dataclass (a `jobs.Job` subclass) + a `work(job)`
  function and delegates lifecycle to a `JobRegistry`; keep new long ops to this shape.
- `tts.py` — OpenAI TTS behind a swappable interface. `auth.py` — Supabase/token/open auth.

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
  and `run.sh` exports `.env` last, so bypass it — `.venv/bin/uvicorn app.main:app --host
  127.0.0.1 --port 8901`.
- **Tests:** `.venv/bin/python -m pytest -q`. The suite is network-free (extraction/citations
  are injected fakes; see `tests/conftest.py`) — keep it that way.
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

## Conventions

- Env vars are prefixed `RC_`. Feature flags: `RC_AGENTIC` routes turns through the tool loop.
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
