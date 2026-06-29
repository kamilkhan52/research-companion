# Research Reading Companion

Read a paper corpus *with* Claude: scholarly discussion, listen-friendly audio, and
notes that compound into the context for the next paper. Implements the Phase 0 / early
Phase 1 slice of `research-companion-architecture.md`.

**Phase 0 choices (this build):**
- LLM via **OpenRouter** (one key, every model) — default a top Claude model, switchable in the UI.
- **Dual output** every turn: a canonical scholarly version (record) + a narration script (ear).
- **TTS = your phone's built-in voice** (Web Speech API) — zero setup, behind a pluggable interface.
- **Store = markdown in git**: each project under `projects/<id>/` has `reading-list.md`,
  `reading-method.md`, `working-notes.md`, `corpus/<paper>.md` (full text + Notes block),
  `sessions/*.jsonl` — its own git repo.
- **Multiple projects**: keep several independent reading projects (each its own store) and
  switch between them in the UI. App-global settings (keys, model/TTS picks, prompts) are
  shared across projects and live in `.app-state/`.
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
reading list, corpus, sessions, and working notes). On first run after upgrading from a
single-project install, migrate the old `project/` store into `projects/`:

```bash
./scripts/migrate_to_projects.py "LLM Inference Serving"   # names the adopted project
```

### Exposing the backend (optional)

The backend holds your paid API keys, so gate it before putting it on a stable public URL
(an ad-hoc tunnel for quick testing is fine). Both are off by default:

```bash
export RC_AUTH_TOKEN="$(openssl rand -hex 24)"      # require this token on /api/*
export RC_CORS_ORIGINS="https://your-web-origin"    # only needed for browser clients
```

With auth on, open the web app once as `https://…/?token=YOUR_TOKEN` — it saves the token and
sends it on every call. Native clients send `Authorization: Bearer YOUR_TOKEN`.

## The loop

1. **Reading list** → tap a paper → **Start**. The spine resolves it on arXiv, downloads &
   extracts the PDF text into `corpus/`, and the agent produces the opening comprehensive
   summary (per your reading method) as a dual output.
2. **Discussion** → read the canonical reply, tap **▶ Listen** to hear the narration, type a
   reply, repeat. Sessions resume cleanly across days.
3. **Done** → the agent drafts the Notes block + a synthesis edit. Review on the same screen,
   **Approve** (commits to git, flips status to *read*) or **Request changes**.

## Layout

```
app/         FastAPI backend (the deterministic spine + agent client)
web/         mobile-first single-page client
projects/    per-project git-backed stores (reading list, method, working-notes, corpus, sessions)
.app-state/  app-global: API keys, model/TTS settings, prompt overrides, audio + narration caches
shared/      generated API types (scripts/gen-api-types.sh) for typed clients
docs/        architecture + mobile app plan
scripts/     helpers (migrate_to_projects.py, gen-api-types.sh)
```

`projects/` and `.app-state/` are gitignored by the code repo (each project is its own repo).

See `app/agent.py` for the dual-output contract, `app/tts.py` for the swappable TTS seam,
`app/projects.py` for the multi-project registry, and `docs/mobile-app-plan.md` for the
native-app direction.
