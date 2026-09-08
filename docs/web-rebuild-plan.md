# Web app rebuild plan

This document tracks the phased rebuild of the web client from a single vanilla JS file to a
React + Vite SPA with feature parity with the mobile app.

The phased rebuild was integrated through the `web-rebuild` branch and merged to `main` in
[PR #43](https://github.com/kamilkhan52/research-companion/pull/43). Further web work branches
directly from `main`.

## Architecture

- **React 19 + TypeScript + Vite** — static output to `web/dist/`, served by FastAPI
- **Canvas 2D + D3-force** for the citation graph (high-performance, handles thousands of nodes)
- **Hash-based routing** — no React Router dependency
- **CSS custom properties** matching `mobile/src/theme/tokens.ts`
- **Vitest + React Testing Library** for unit tests

## Status

| Phase | Branch | PR | Status |
|---|---|---|---|
| 1 | `web/foundation` | [#20](https://github.com/kamilkhan52/research-companion/pull/20) | Merged |
| 2 | `web/library` | [#21](https://github.com/kamilkhan52/research-companion/pull/21) | Merged |
| 3 | `web/graph` | [#23](https://github.com/kamilkhan52/research-companion/pull/23) | Merged |
| 4 | `web/discussion` | [#24](https://github.com/kamilkhan52/research-companion/pull/24) | Merged |
| 5 | `web/discovery-notes` | [#25](https://github.com/kamilkhan52/research-companion/pull/25) | Merged |
| 6 | `web/settings-audio` | [#26](https://github.com/kamilkhan52/research-companion/pull/26) | Merged |
| 7 | `web/auth-polish` | [#27](https://github.com/kamilkhan52/research-companion/pull/27) | Merged |
| 8 | `codex/web-mobile-parity` | [#58](https://github.com/kamilkhan52/research-companion/pull/58) | Complete |
| 9 | `opus/web-parity-overnight` | [#511](https://github.com/kamilkhan52/research-companion/pull/511) | Add-a-paper front door (DR-149 parity) + source-title offer |
| 10 | `opus/web-parity-overnight` | [#513](https://github.com/kamilkhan52/research-companion/pull/513) | Upload a PDF — DR-149's third entry path |

## Parity backlog (2026-09-08)

Phase 8 closed the *screen* gap; the gap that remains is per-feature, and it is wider than the
status table above suggests. Measured by endpoint coverage, `web/src/api/endpoints.ts` wires 43
of the 96 calls `mobile/src/api/endpoints.ts` does. This list is what a future web round should
pick from, roughly in value order — each is an independent, user-visible slice.

Web-only checks are `npm test`, `npx tsc --noEmit`, `npm run build`; `web/dist` is committed and
CI verifies it was rebuilt. **No web change can be device-verified** — the ledger's device passes
are the mobile client, so a web PR must never claim one.

| Gap | Mobile has | Notes |
|---|---|---|
| Per-paper reference graph | `getPaperGraph` (DR-093) | The server lays the ego view out, and `web/src/graph/engine.ts` can render it as-is. Probably the best value-per-line left. |
| Figures in chat | `getPaperFigures`, `figureAssetSource` (R.10) | Needs header-authenticated image loading (blob URLs), which paper covers also need. |
| Paper covers in the Library | `getPaperCover`, `paperCoverImageSource` | Same authenticated-media problem; do it with figures. |
| Corpus neighbourhood line | `getNeighbourhood` (DR-052) | The shared Map/Discover freshness both screens show on mobile. |
| Author board + lab research | `getGraphAuthors`, `startLabsResearch`, `startAuthorProfile` | A whole mobile route (`authors.tsx`) with no web equivalent. |
| Spend visibility | `getUsage`, `getPlan` | Web shows no usage or plan at all. |
| Notes: discard, project-notes fold, discussion update | `discardNotesJob`, `startProjectNotesFold`, `startNotesDiscussionUpdate` | Web has only the agent-proposal path. |
| Discovery: hide/unhide, cancel | `hideSuggestion`, `unhideSuggestion`, `cancelDiscovery` | Small, self-contained. |
| Project management | `deleteProject`, `moveProject`, `splitProject`, `updateProjectMeta` | Web can create and switch, nothing else. |
| Clear chats, report content, account deletion | `clearChats`, `reportContent`, `startAccountDeletion` | `delete-account.tsx` is a store requirement on mobile; check whether web needs it. |

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

Connection-independent chat jobs with live polled Markdown progress, canonical transcript
reconciliation, retry-with-model, continue, and reconnect recovery. Paper retrieval uses the
same background-job pattern through deterministic arXiv/PDF resolution and the agentic hunt.
Notes review and explicit approve flow.

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
