# Research Reading Companion

Read a paper corpus *with* Claude: scholarly discussion, listen-friendly audio, and
notes that compound into the context for the next paper. Implements the Phase 0 / early
Phase 1 slice of `research-companion-architecture.md`.

**Phase 0 choices (this build):**
- LLM via **OpenRouter** (one key, every model) — default a top Claude model, switchable in the UI.
- **Dual output** every turn: a canonical scholarly version (record) + a narration script (ear).
- **TTS = your phone's built-in voice** (Web Speech API) — zero setup, behind a pluggable interface.
- **Store = markdown in git**: `project/reading-list.md`, `reading-method.md`, `synthesis.md`,
  `corpus/<paper>.md` (full text + Notes block), `sessions/*.jsonl`.
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
app/        FastAPI backend (the deterministic spine + agent client)
web/        mobile-first single-page client
project/    the git-backed store (your reading list, method, synthesis, corpus, sessions)
```

See `app/agent.py` for the dual-output contract and `app/tts.py` for the swappable TTS seam.
