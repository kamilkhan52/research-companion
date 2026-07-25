# Current-state audit — production & commercial readiness

*Audited 2026-07-24 against `origin/main` @ `e5fe869`. Backend suite green locally
(`.venv/bin/python -m pytest -q`, exit 0, ~800 tests). Supersedes the assumptions in the
external launch brief, which was written without repository access.*

This is the evidence base for `10-roadmap.md`. Every finding cites the code that produced it.

---

## 1. What the external brief got wrong

The brief is a well-built policy and monetization checklist, and its Google Play / RevenueCat /
compliance content is largely adopted. But it modelled a stack this repo does not have. Recording
the corrections here so no future agent re-plans against the fiction.

| Brief assumes | Reality | Consequence for the plan |
|---|---|---|
| Supabase is the backend (Postgres, RLS, Edge Functions, Storage) | Supabase is **only** a JWT issuer. `app/auth.py` verifies tokens against Supabase's JWKS locally. No Supabase client library, no tables, no RLS, no Edge Functions. **There is no database.** | The entire "RLS policies / migrations / Edge Functions" section describes work on a non-existent system. Postgres is now being *introduced* (see M2), not audited. |
| A "single-user bypass" must be removed | No bypass exists. Auth is cleanly env-gated (`open \| token \| supabase`, `app/auth.py:33`) and populates `request.state.user`. | The work is the inverse: auth is fine, but **nothing behind it is scoped to a user**. |
| AI keys may be in the client bundle | Already server-side, `.app-state/settings.json`, mode 0600 (`app/config.py:415`). | Drop from scope. |
| Web client is Expo web output | Separate React + Vite SPA in `web/`, built to `web/dist/` (committed, CI-verified), served as static files by the same FastAPI process (`app/main.py:115`). | Web hosting collapses into the backend hosting decision — one deployment, not two. |
| Backend hosting is a solved detail | Production is a Mac mini at home on Tailscale (`100.83.161.127:8000`, baked into `mobile/app.json` → `extra.apiBaseUrl`), started by `./run.sh`, no supervisor, no TLS of its own, no backups. | Hosting is **M1**, not a late release step. It gates auth redirect URLs, Play review access, deletion URLs, and every quota control. |
| Produce 11 documents | `docs/` already holds 28 files and an actively-maintained roadmap ledger. | Reduced to 5 living documents + `HUMAN_ACTIONS.md`. Stale docs are worse than absent ones. |

### What the brief missed entirely

- **Restart amnesia destroys paid work.** Job registries are in-memory by design (invariant 6,
  `app/jobs.py`). A restart or crash kills in-flight chat/audio/graph jobs — minutes of billed LLM
  work, gone silently. Tolerable on your own hardware; not once a customer paid for that turn.
  `docs/improvements.md` §1.4 (job persistence) is the open fix.
- **You cannot price your own default turn path.** As of `ec0e986`, agentic runs are flagged
  `estimated` because OpenRouter's `usage.cost` is unavailable through Pydantic AI — and the
  agentic loop became the *default* in #208. Metering that can't price the primary flow cannot
  back a quota, let alone a subscription.
- **Prompt injection is a live surface, not hypothetical.** The default turn path is a tool loop
  (`app/agent_harness.py`) with web search/fetch tools (`app/research_tools.py`) operating over
  attacker-influenceable PDF full text, using your API keys. The SSRF half is now mitigated by
  `app/safe_fetch.py` (M1 PR3); instruction injection is still unguarded.
- **`usage.py` is an aggregate, not an event ledger.** Genuinely well-built (integer nano-USD,
  pending/`estimated` honesty, a `reconcile` hook) but it stores rolled-up buckets keyed by project.
  Cost-per-user, cost-per-day, and anomaly detection need append-only events — an additive change
  on a good foundation, not a rewrite.
- **Zero rate limiting anywhere.** One authenticated user can fire unlimited minutes-long Opus jobs.
- **CI has been dead since 2026-07-22** (account-level Actions billing block; all jobs fail in ~3s
  with 0 steps). Any release-automation milestone is blocked behind a human billing fix.

---

## 2. Current architecture, as built

**Backend** — FastAPI, ~18.4k lines across `app/` + `app/routers/`, 79 test files, network-free
suite. One uvicorn worker by deliberate choice (invariant 6). Six load-bearing invariants are
documented in `CLAUDE.md` and enforced structurally; the plan in `10-roadmap.md` preserves all six.

**Storage** — markdown-in-git. Each project under `PROJECTS_ROOT` is its own git repo (reading
list, method, working notes, `corpus/`, `sessions/`, `.state/`). App-global state (keys, model
picks, prompt overrides, caches) in `.app-state/`. Current volume: **356 MB** across 7 projects,
plus **2.8 GB** of TTS audio cache.

**Auth** — Supabase JWKS verification in `app/auth.py`; middleware gates `/api/*` in
`app/main.py:56`, exempting `/api/health` and `/api/auth/config`. Three modes, defaults to `open`.

**Clients** — `mobile/` (Expo SDK 56, RN 0.85, managed workflow, `expo-dev-client`, EAS profiles
for development/preview/production, `appVersionSource: remote`, package
`com.kamilkhan.researchcompanion`, version 1.0.0, never submitted to any store) is the active
client. `web/` is a React + Vite SPA at rough parity.

**Money** — none. No payment code, no store configuration, no entitlement concept.

---

## 3. Findings

### P0 — launch blockers

| # | Finding | Evidence |
|---|---|---|
| P0-1 | **No ownership model.** `use_project` validates that a pid is path-safe and exists, but never that the caller owns it. Every authenticated user can read and write every project — corpus, notes, sessions, transcripts. | `app/projects.py:325` |
| P0-2 | **Global settings writable by any authenticated user.** `POST /api/settings` overwrites the shared OpenRouter/OpenAI/Firecrawl/S2 keys and model selection for *everyone* on the instance. (Reads are safe — keys return as 6-char hints only.) | `app/routers/settings.py:57`, cf. `:42` |
| P0-3 | **Global system prompts writable by any authenticated user.** `POST /api/prompts` rewrites the analysis/narration prompts for every user. A hosted-instance prompt-injection primitive. | `app/routers/settings.py:87` |
| P0-4 | **No rate limiting or spend ceiling of any kind.** No per-user, per-IP, or global limit on job creation. One loop = unbounded bill. | absent repo-wide |
| P0-15 | **The mobile client cannot authenticate at all.** It has no Supabase dependency, no sign-in screen, and no session handling. The token *plumbing* exists — `authHeaders()` (`api/client.ts:23`), SecureStore persistence, and `?token=` for media that can't send a header — but `setToken` (`api/config.ts:76`) **has no caller anywhere in `mobile/src`**, so a token can never be set. That machinery was built for the legacy shared-secret mode. Only the web client implements sign-in (`web/src/components/AuthGate.tsx:29`). Consequence: the moment M1 makes production refuse to boot without Supabase auth, the Android app — the *active* client — cannot talk to it, and M2.5's testers cannot sign in. Missed by eight review rounds because every round examined the backend and the plan, not the clients. | `mobile/src/api/config.ts:76`, `mobile/src/api/client.ts:23`, absent elsewhere |
| P0-14 | ~~**Server-side request forgery and unbounded download via user-supplied `pdf_url`.**~~ — **closed 2026-07-25** (M1 PR3). `StartReq.pdf_url` reached `retriever._fetch`, which did `httpx.get(url, follow_redirects=True)` and buffered the whole body via `.content`: no public-IP validation, no redirect-target validation, no byte ceiling. Any authenticated user could reach private/internal addresses (on a cloud host, the metadata endpoint) or OOM the process — a full outage under invariant 6. Fixed by `app/safe_fetch.py`, now used by all four outbound paths. Two things the original finding got wrong: the guard it pointed at as "the right guard already in the codebase" (`research_tools._assert_public_url`) was itself insufficient — it validated only the first URL while httpx followed redirects freely, and it enumerated private ranges rather than testing `is_global`, so it allowed `100.64.0.0/10` (the Tailscale range; the dev Mac is `100.83.161.127`). Reusing it as-is would have left both holes open. **Residual:** DNS rebinding is not closed — see P1-11. | `app/safe_fetch.py`, `tests/test_safe_fetch.py` |
| P0-13 | **TTS spend is never metered at all, and one paid endpoint is both blocking and unmetered.** `usage.py` is fed only from `llm.py`, so every OpenAI speech synthesis is invisible to the ledger — a material omission for a product whose marginal cost includes audio. Worse, `POST /api/speak` synthesizes arbitrary caller-supplied text **synchronously**, with no accounting and no job (its own docstring concedes it can outlive proxy timeouts, i.e. it also violates invariant 1). Any metering or quota design scoped to "LLM calls" or "job-creating routes" would miss this entire class. | `app/tts.py` (no `usage` import), `app/routers/audio.py:39-52` |
| P0-5 | **The default turn path has no authoritative cost, and it is unreconcilable.** Agentic runs record `estimated` usage because Pydantic AI's usage mapping drops OpenRouter's dollar `cost`. Worse than "cost unknown for now": the pending marker is written with `generation_id=None` for a run of up to 12 provider requests, and `reconcile()` rejects a falsy id — so the existing reconciliation hook can *never* resolve these. Quotas cannot be enforced on unpriced calls. | `app/agent_harness.py:63-96` (esp. `:96`), `app/usage.py:203`, commit `ec0e986` |
| P0-6 | **No production hosting.** Home Mac mini, hardcoded tailnet IP in the shipped client, no TLS, no supervisor, no domain, no backups. Play review cannot reach it. | `run.sh`, `mobile/app.json` → `extra.apiBaseUrl` |
| P0-7 | **No account deletion path** — and no user-scoped data for it to delete. Play requires both in-app deletion and a public web request URL. | absent |
| P0-8 | **No legal or trust surfaces.** No privacy policy, terms, support contact, AI disclaimer, or in-app report-offensive-AI-content action. Grep across `mobile/src` and `web/src` returns nothing. Play blocks on the privacy policy, Data Safety form, and (for generative AI) the in-app report action. | absent |
| P0-9 | **No crash or error monitoring.** `rc.*` logging installs a single **stderr** handler and nothing else — no file sink, no aggregation, no alerting. (The `.app-state/server.log` on the dev box comes from shell redirection at launch, not from the app.) A broken release would be invisible. | `app/logging_config.py:44` |
| P0-10 | **Restart destroys in-flight paid work.** In-memory job registries; no persistence, no resume. | `app/jobs.py`, `docs/improvements.md` §1.4 |
| P0-11 | **No backups.** Project git repos and `.app-state/` exist on one disk with no snapshot or off-host copy. | absent |
| P0-12 | **Production can boot completely unauthenticated — arguably the most severe item here.** `auth.mode()` returns `open` whenever `RC_SUPABASE_URL` and `RC_AUTH_TOKEN` are both unset, and the middleware then skips authentication entirely. Nothing fails loudly; a deploy that simply forgets one env var serves the whole API to the internet. Forbidding `RC_DEV`/`RC_AUTH_TOKEN` in prod (as M1 originally proposed) does **not** close this — the dangerous state is *absence* of config, not presence. Production must refuse to start unless `auth.mode() == "supabase"`. | `app/auth.py:33-42`, `app/main.py:63` |

### P1 — serious

| # | Finding | Evidence |
|---|---|---|
| P1-1 | **Audio cache is unbounded and app-global.** 2.8 GB today, content-hash keyed, no eviction. Served by hash to any authenticated caller, so it is also a weak cross-user read channel. | `app/audio_jobs.py:34,67`; `app/routers/audio.py:89` |
| P1-2 | **Job endpoints are unauthorized.** Any authenticated user can poll or cancel any job by id. UUIDs make it unguessable, not authorized. | `app/routers/audio.py:69,78` |
| P1-3 | **Usage is aggregate-only** — no `by_user`, no event rows, no time series. Cannot answer cost-per-user or detect anomalies. | `app/usage.py:69` |
| P1-4 | **Prompt-injection surface**: tool-enabled loop over untrusted paper text with your credentials. Instruction injection is unguarded. (The SSRF half of this row is closed — every outbound fetch now goes through `safe_fetch`; see P0-14.) | `app/agent_harness.py` |
| P1-11 | **DNS rebinding is not closed by `safe_fetch`.** It validates the addresses `getaddrinfo` returns, then httpx resolves the name again to open the connection; a hostile resolver with a 0-TTL record can answer public-then-private across those two lookups. Closing it requires pinning the connection to the validated address while carrying the original host for SNI and certificate verification — a transport-level change with its own TLS-verification failure modes, so it was deliberately not half-done inside PR3. Exposure is much narrower than the redirect hole this replaced: it needs attacker-controlled authoritative DNS, not just a URL. | `app/safe_fetch.py` (documented in the module docstring) |
| P1-5 | ~~CI is red for billing reasons~~ — **resolved 2026-07-24** (H1). The Actions spending limit was $0; raised to $10 and all three jobs pass. Kept as a row because the ~3s/0-steps failure signature is worth recognizing if it recurs. | `.github/workflows/ci.yml` |
| P1-6 | **No staging environment.** `.env` on one host is the whole configuration surface. Production customer data would be the only test data. | `run.sh`, `.env.example` |
| P1-7 | **Paper-source terms unaudited for commercial use.** The app downloads, stores, rasterizes, and extracts figures from arXiv PDFs, and calls Semantic Scholar and OpenAlex. Redistribution and caching rules differ from personal use. | `app/retriever.py`, `app/figures.py`, `app/semantic_scholar.py`, `app/openalex.py` |
| P1-8 | **Legacy shared-secret auth mode** (`RC_AUTH_TOKEN`) must be impossible to enable in production. | `app/auth.py:20,36` |
| P1-9 | **`RC_DEV` gates prompt editing and force-rebuild** and is read live from env — must be provably off in production. | `app/config.py:106` |
| P1-10 | **Single worker, no supervisor** — one unhandled crash is a full outage with no restart. | `run.sh`, invariant 6 |

### P2 — improvements

| # | Finding |
|---|---|
| P2-1 | No E2E tests for auth, purchase, or entitlement flows. |
| P2-2 | `shared/api-types.ts` regeneration is manual (`scripts/gen-api-types.sh`). |
| P2-3 | Web SPA availability is coupled to the API process (same mount). |
| P2-4 | Android `targetSdkVersion` is whatever Expo SDK 56 defaults to — unverified against the API 36 requirement. Managed workflow, no `mobile/android/`. |
| P2-5 | No data inventory, so Data Safety answers would be guesses. |

### P3 — optional / post-launch

| # | Finding |
|---|---|
| P3-1 | iOS not started. Note: Google sign-in is already offered, so Sign in with Apple becomes mandatory on iOS. |
| P3-2 | No EAS Update / OTA policy or runtime-versioning strategy. |
| P3-3 | Multi-worker scaling remains blocked by in-memory job state (invariant 6) — fine for launch scale. |

---

## 4. What is already in good shape

Worth stating so the plan doesn't redo it:

- Auth token verification is correct and library-light (local JWKS, no server-side Supabase SDK).
- API keys are already server-side and mode-0600; clients only ever receive hints.
- `app/projects.py:_safe_pid` is an explicit, documented trust boundary for id→path conversion.
- `app/usage.py` is a sound billing foundation — integer nano-USD, honest `pending`/`estimated`
  handling, and a `reconcile` hook already designed for exactly this purpose.
- Git commit identity is pinned via `config.git_identity_args()`, so a fresh container commits
  correctly with no global git config (`docs/improvements.md` §4.10, already done).
- SSRF is guarded on agent fetches (`_assert_public_url`).
- The job framework, atomic writes, and per-project locking are already unified and tested.
- EAS is configured with development/preview/production profiles and remote version management.
- CI covers backend + mobile + web including a "dist is committed" gate — once billing is restored.
