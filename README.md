# Research Reading Companion

Read a paper corpus *with* Claude: scholarly discussion, listen-friendly audio, and
notes that compound into the context for the next paper. Implements the Phase 0 / early
Phase 1 slice of `research-companion-architecture.md`.

**Phase 0 choices (this build):**
- LLM via **OpenRouter** (one key, every model) — default a top Claude model, switchable in the UI.
- **Dual output** every turn: a canonical scholarly version (record) + a narration script (ear).
- **TTS = your phone's built-in voice** (Web Speech API) — zero setup, behind a pluggable interface.
- **Store = markdown in git**: each project under `projects/<id>/` has `reading-list.md`,
  `reading-method.md`, `working-notes.md`, `corpus/<paper>.md` (full text + Paper Notes block),
  `sessions/*.jsonl` — its own git repo.
- **Multiple projects**: keep several independent reading projects (each its own store) and
  switch between them in the UI. App-global keys, model/TTS picks, and caches live in
  `.app-state/`; prompts can be authoritative Markdown in an Obsidian vault.
- **Agent proposes, you commit**: notes + synthesis edits land only after you approve.

## Quick start

```bash
cd ~/research-companion
cp .env.example .env          # paste your OPENROUTER_API_KEY (or set it in the UI later)
./run.sh                      # boots venv, installs deps, serves on :8000
```

Open `http://localhost:8000` on this machine. To test on your phone from anywhere:

```bash
./tunnel.sh                   # prints a public https URL — open it on your phone
```

Paste your OpenRouter key in **Settings** (gear icon) if you didn't put it in `.env`.

### Projects

The library has a project switcher at the top; **+ New** creates another project (its own
reading list, corpus, sessions, and Project Notes). On first run after upgrading from a
single-project install, migrate the old `project/` store into `projects/`:

```bash
./scripts/migrate_to_projects.py "LLM Inference Serving"   # names the adopted project
```

### Obsidian vault

To make prompts and project files directly editable in Obsidian, configure a dedicated vault:

```bash
# Preview only; no files are changed.
./scripts/migrate_to_vault.py --vault "$HOME/Documents/Research Companion"

# Copy projects (including their nested .git histories) and seed prompt Markdown files.
./scripts/migrate_to_vault.py --vault "$HOME/Documents/Research Companion" --apply

# After upgrades, preview and seed newly registered prompts without touching Projects or edits.
./scripts/migrate_to_vault.py --vault "$HOME/Documents/Research Companion" --prompts-only
./scripts/migrate_to_vault.py --vault "$HOME/Documents/Research Companion" --prompts-only --apply

# Then add this to .env and restart the backend.
RC_VAULT_ROOT="/Users/you/Documents/Research Companion"
```

The migration never deletes the source. `RC_PROMPTS_DIR` and `RC_PROJECTS_ROOT` can override the
two vault subdirectories independently.

### Auth setup (Supabase — Google + email)

Auth is **off by default** (open, fine behind a private tunnel). To require real user login
with Google and email magic-links, wire up Supabase once. The backend verifies the user's JWT
locally against Supabase's JWKS — no server-side Supabase library, low lock-in.

**One-time, in the dashboards (only you can do these — accounts + OAuth credentials):**

1. **Supabase** → create a project. Settings → **enable asymmetric JWT signing keys** (so the
   JWKS endpoint is live). Authentication → Providers → enable **Email** and **Google**.
2. **Google Cloud Console** → create OAuth credentials:
   - a **Web** client — add authorized redirect URI `https://<ref>.supabase.co/auth/v1/callback`
     and your web origin to authorized JS origins;
   - (later, for the Android app) an **Android** client with your app's SHA-1.
   Put the Web client's ID + secret into Supabase's Google provider.
3. Copy your project URL + **anon (publishable) key** from Supabase → API settings.

**Then locally:**

```bash
# .env
RC_SUPABASE_URL=https://<ref>.supabase.co
RC_SUPABASE_ANON_KEY=<anon-key>
```

Restart — the web app now shows a Sign-in screen (Google / magic-link); sign out from Settings.
Tokens are sent as `Authorization: Bearer …` (and `?token=…` for audio/SSE). Before shipping on
iOS you'll also need "Sign in with Apple" (Apple's rule); Android-first means that can wait.

> Legacy alternative (no Supabase): set `RC_AUTH_TOKEN` for a single shared-secret gate and open
> the app once as `https://…/?token=YOUR_TOKEN`. `RC_CORS_ORIGINS` enables browser cross-origin.

## The loop

1. **Reading list** → tap a paper → **Start**. The spine resolves it on arXiv, downloads &
   extracts the PDF text into `corpus/`, and the agent produces the opening comprehensive
   summary (per your reading method) as a dual output.
2. **Discussion** → read the canonical reply, tap **▶ Listen** to hear the narration, type a
   reply, repeat. Sessions resume cleanly across days.
3. **Done** → the agent drafts the Paper Notes block + a synthesis edit. Review on the same screen,
   **Approve** (commits to git, flips status to *read*) or **Request changes**.

## Reference graph

Each project can build a citation graph over its own papers: how they cite each other, which
outside papers they lean on, and a ranked recommendation for which outside papers to add next
(weighted by how many project papers cite it, how *significantly*, and whether it bridges
otherwise-separate citing papers). One OpenRouter call per paper (DeepSeek V4 Pro by default —
override with `RC_GRAPH_LLM_MODEL`) reads its cached full text and returns structured
references, body-text citation contexts, and a significance verdict in one pass; matching/
dedup/analysis is deterministic Python, no further LLM calls. Cached per paper by content
hash and saved incrementally (survives an interrupted build), so rebuilding only spends
tokens on papers that changed since last time.

- `GET /api/projects/{pid}/graph`, `POST /api/projects/{pid}/graph/build` (`{"force": bool}`,
  SSE progress), `GET /api/projects/{pid}/graph/recommendations`.
- `POST /api/projects/{pid}/papers` adds a recommended paper to the reading list (unread;
  full text stays lazily retrieved like any other paper).
- See `app/graph.py` for the pipeline and `app/graph_store.py` for the per-project cache
  (`.state/reference-graph.json`, gitignored — a derived cache, not authored content).
- Mobile UI: the Library's project bar and the Discussion screen both have a "✦ Graph" entry
  point (`mobile/src/app/graph.tsx`) — pan/zoom canvas, search/filter, node detail, and the
  recommendations panel with a one-tap "Add to project".

## Mobile app

`mobile/` is the React Native + Expo client (Android-first) — the actively developed client
day-to-day; `web/` still works but doesn't get new features first. See `mobile/README.md` for
building/running it.

## Layout

```
app/         FastAPI backend (the deterministic spine + agent client + reference graph)
web/         mobile-first single-page client (legacy; see mobile/ for the active client)
mobile/      React Native + Expo client (Android-first)
projects/    per-project git-backed stores (reading list, method, working-notes, corpus, sessions)
.app-state/  app-global: keys/settings, legacy prompt overrides, last-valid state, derived caches
shared/      generated API types (scripts/gen-api-types.sh) for typed clients
docs/        architecture + mobile app plan
scripts/     helpers (migrate_to_projects.py, gen-api-types.sh)
tests/       backend test suite (pytest; requirements-dev.txt)
```

`projects/` and `.app-state/` are gitignored by the code repo (each project is its own repo).

See `app/agent.py` for the dual-output contract, `app/tts.py` for the swappable TTS seam,
`app/projects.py` for the multi-project registry, `app/graph.py` for the reference-graph
pipeline, and `docs/mobile-app-plan.md` for the native-app direction.
