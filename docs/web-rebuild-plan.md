# Web app rebuild plan

This document tracks the phased rebuild of the web client from a single vanilla JS file to a
React + Vite SPA with feature parity with the mobile app.

## Architecture

- **React 19 + TypeScript + Vite** — static output to `web/dist/`, served by FastAPI
- **Canvas 2D + D3-force** for the citation graph (high-performance, handles thousands of nodes)
- **Hash-based routing** — no React Router dependency
- **CSS custom properties** matching `mobile/src/theme/tokens.ts`
- **Vitest + React Testing Library** for unit tests

## Status

| Phase | Branch | PR | Status |
|---|---|---|---|
| 1 | `web/foundation` | [#20](https://github.com/kamilkhan52/research-companion/pull/20) | In review |
| 2 | `web/library` | — | Planned |
| 3 | `web/graph` | — | Planned |
| 4 | `web/discussion` | — | Planned |
| 5 | `web/discovery-notes` | — | Planned |
| 6 | `web/settings-audio` | — | Planned |
| 7 | `web/auth-polish` | — | Planned |

## Phase 1 — Foundation

Vite + React + TypeScript scaffold. Placeholder views for all screens. CSS theme matching mobile.
CI job: build + test + typecheck. Backend auto-detects `web/dist/`.

### Phase 2 — Library

Project selector, paper cards with status badges, group headings. Empty/loading/error states.

### Phase 3 — Graph (high-performance)

Canvas-based force-directed graph engine:
- `GraphEngine` class: D3-force simulation, Canvas 2D rendering, d3-zoom pan/zoom,
  d3-quadtree hit-testing, viewport culling
- Node detail panel, search/filter, recommendations, build progress
- Performance target: 60fps at 500+ nodes

### Phase 4 — Discussion

Streaming SSE chat with live markdown rendering. Reply, retry-with-model, continue.
Notes review and approve flow.

### Phase 5 — Discovery + Notes

Discovery: goals input, job polling, ranked suggestions, specific-paper entry, add-to-project.
Notes: view (markdown), edit (raw textarea + save), agent (instruction → proposal → apply).

### Phase 6 — Settings + Audio + Player

Settings: API keys, models, speech, prompt status, agentic toggle.
Audio: HTML5 Audio + OpenAI TTS job polling + browser speech fallback.
Full-screen player with transcript, NowPlaying minibar.

### Phase 7 — Auth + Polish

Supabase login (Google + magic link). Error boundaries, loading skeletons, visual polish.
Remove old `web/app.js`, `web/index.html`, `web/styles.css`.

## Verification

Each phase must pass:
- `npm run build` — production build succeeds
- `npm test` — all unit tests pass
- `npx tsc --noEmit` — no type errors
- Manual smoke test: screen renders from a running backend
