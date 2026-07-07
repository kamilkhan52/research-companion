# AGENTS.md — Research Companion

This repository is a FastAPI backend plus Expo/React Native client for the Research Reading Companion. Also read `CLAUDE.md`; it contains the full working guidance and invariants for coding agents in this repo.

## Review guidelines

Codex code review should prioritize only serious P0/P1 risks. In this project, treat the following as high-priority review findings:

- Long-running or LLM-touching operations must run as background jobs with polling, not blocking HTTP requests or connection-tied SSE streams.
- Background threads that touch store/session/graph/project state must rebind the active project contextvar before doing work.
- `app/store.py` must remain deterministic: no LLM calls, no network calls, and no hidden side effects.
- Nothing should write to the git-backed project record without the human-approval flow through the committer/notes approval path.
- Preserve the section-marker protocol for scholarly analysis outputs; do not replace it with JSON unless the parser and prompts are deliberately redesigned.
- Do not introduce multi-worker assumptions for uvicorn/job registries without making job state and file writes process-safe.
- Check for path traversal around project IDs and any code touching `.app-state/` or `projects/<id>/`.
- Treat mobile/backend contract drift, stale endpoint behavior, and unhandled async job error states as serious integration risks.
- Flag secrets, API keys, PII logging, or unsafe exposure of paper/project data.

Minor style, naming, formatting, or doc nits should not be reported unless they mask one of the above risks.
