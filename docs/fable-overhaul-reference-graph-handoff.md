# Fable overhaul — reference graph + polish — handoff

**Session:** overnight autonomous run, started 2026-07-01 00:15 PDT, this checkpoint updated
~02:05 PDT (first written ~01:42, then continued — see "Update" below). Model: Claude Fable 5
(no fallback occurred — ran as Fable the whole session).

**Branch:** `fable-overhaul-graph-references` (pushed; not yet merged to `main`).
Base: `main` at `e38f586` (clean tree, no pre-branch commit needed).

**To resume:** `git fetch && git checkout fable-overhaul-graph-references && git pull`, then
read "Immediate next steps" at the bottom of this doc.

---

## What shipped

### Part B — reference graph (the flagship feature; fully working end-to-end)

A reusable, incremental, LLM-backed pipeline that builds a citation graph over a project's
papers, plus a full mobile UI for it. Not a one-off manual analysis — it's a normal app
feature any project can (re)build from its own screen.

**Backend** (`app/graph.py`, `app/graph_store.py`, routes in `app/main.py`):

- One OpenRouter call per paper (model below) reads the paper's cached full text and returns,
  in one pass: structured bibliography entries (title/authors/venue/year/arxiv/doi/url/raw
  text/confidence), a few verbatim body-text citation contexts per reference, and a
  significance verdict (does the paper substantially use/extend/compare-against/depend-on
  that work, vs. a passing bibliography mention).
- Deterministic Python (no LLM, fully unit-tested) then normalizes/dedupes external
  references (by arxiv_id → doi → fuzzy title) and matches in-project citations by fuzzy
  title against the project's own papers, building graph nodes + directed edges.
- Recommendation ranking for external papers: weighted by significant-citation count,
  breadth of citing papers, and a lightweight bridge-ness proxy (rewards a node connecting
  citing papers that don't otherwise overlap much in what else they cite).
- **Incremental & resumable**: extraction is cached per paper by content hash
  (`.state/reference-graph.json`, per-project, gitignored like `sessions.json` — it's a
  derived cache over committed text, not authored content). Rebuilding only spends tokens on
  papers that changed. **Saves to disk after each paper**, not just at the end — verified by
  actually killing a live build mid-run and confirming completed papers survived.
- API: `GET /api/projects/{pid}/graph` (graph + recommendations + a no-LLM status check),
  `GET /api/projects/{pid}/graph/recommendations`, `POST /api/projects/{pid}/graph/build`
  (SSE progress via the existing `_sse`/`StreamingResponse` pattern, `{force: bool}` body).
- **Closes the loop the brief implies but doesn't spell out:** recommending papers is only
  useful if you can act on one, so `POST /api/projects/{pid}/papers` (`app/store.add_entry`)
  adds a recommended external paper to the project's reading list in one tap (unread; full
  text stays lazily retrieved like any other paper, nothing auto-committed — same "agent
  proposes, human commits" principle as the rest of the app). Wired into both the
  Recommendations panel and the node detail sheet on mobile.

**Model config:**

- `RC_GRAPH_LLM_MODEL` env var overrides the model. Unset → resolves the newest OpenRouter
  catalogue id matching "DeepSeek V4 Pro" (same family-matching logic as `main.py`'s
  favorite-model picker) → falls back to the literal `deepseek/deepseek-v4-pro` if the
  catalogue fetch fails.
- **Verified live** (2026-07-01): OpenRouter currently resolves this to exactly
  `deepseek/deepseek-v4-pro`, provider Novita, `deepseek/deepseek-v4-pro-20260423`.
  Context length 1,048,576; **max completion tokens 384,000**.
- **DeepSeek V4 Pro is a reasoning model** — OpenRouter's response carries a separate
  `message.reasoning` field, and `usage.completion_tokens_details.reasoning_tokens` is real
  and counts against `max_tokens` alongside visible content. This bit us live (see bugs
  below) and is now handled via `reasoning: {"effort": "low"}` in the request body
  (`REASONING_EFFORT` in `app/graph.py`) plus a generous `EXTRACTION_MAX_TOKENS = 48_000`
  safety margin (well under the 384k ceiling).

**Mobile** (`mobile/src/`):

- `src/app/graph.tsx` — the screen: pan/zoom canvas, search/filter (title/author/year,
  in-project/external/significant), empty state with a "Build graph" CTA that explains the
  cost/caching model, live build-progress banner (current paper + N/total), stale-papers
  banner, error handling, manual refresh.
- `src/components/graph/GraphCanvas.tsx` + `src/graph/layout.ts` +
  `src/hooks/useGraphLayout.ts` — a from-scratch force-directed layout (no d3/graph-library
  dependency) and a pure-View pan/zoom canvas (circles for nodes, rotated Views for edges).
  **Deliberately not react-native-svg** — gesture-handler + reanimated were already linked
  into the current build (expo-router's own Stack needs them), so this ships with **zero new
  native dependency / no EAS rebuild required**. `_layout.tsx` now explicitly wraps the app
  root in `GestureHandlerRootView` (official RNGH guidance) so the modern `GestureDetector`
  API used here is guaranteed a valid root — pure JS change.
- `src/components/graph/NodeDetailSheet.tsx` — metadata, link-out (arXiv/DOI/URL via React
  Native's core `Linking`, not `expo-linking`, to sidestep any doubt about what's actually
  linked into the current binary), citation stats, "Cited by"/"Cites" lists with significance
  badges + a supporting excerpt, tap-through to a project paper's Discussion.
- `src/components/graph/RecommendationsPanel.tsx` — ranked external papers with reasons.
- Nav entry points: Library's project bar (a "✦ Graph" button next to the project switcher)
  and the Discussion screen's TopBar. `useGraphBuild.ts` drives the SSE build with per-paper
  progress tracking; `stream.ts`'s `streamPost` was generalized to `streamPost<T>` (was
  hardcoded to chat's `StreamEvent`) so both streams share one SSE parser.

**Tests:** `tests/` (new — first backend test suite in this repo), 55 tests, **zero network
calls** (extraction is always dependency-injected in tests via `extract_fn`). Covers title
matching/dedup, graph construction from fixture extractions, recommendation ranking + the
bridge-score math, JSON parsing/salvage robustness, the store's persistence round-trip, and a
full pipeline test proving the incremental cache and the interrupted-build resumability.
`requirements-dev.txt` added (pytest; not bundled into the runtime `requirements.txt`).

#### Seven real bugs found via live testing + careful self-review — all fixed

The brief said to test on a small subset before scaling; doing that (plus a deliberate,
from-scratch review of the untested layout math before calling the mobile UI "done") surfaced
real issues a mocked test suite alone would never have caught:

1. **JSON truncation.** First live test (papers `punica`, then the harder `distserve`) hit
   `8000`-token cap → truncated mid-JSON on a 37-reference bibliography with contexts.
   Fixed: bumped the budget, and added `_salvage_references()` — a string/escape-aware scan
   that recovers whichever leading reference objects parsed cleanly from truncated/malformed
   JSON, instead of discarding an entire paid-for response.
2. **Reasoning-token runaway.** Even at a much larger token budget, the large/complex
   `distserve` paper made the model spend its **entire** budget on hidden reasoning with
   **zero** visible content emitted (`finish_reason: "length"`, empty `content`). Root-caused
   via OpenRouter's `usage.completion_tokens_details.reasoning_tokens`. Fixed with
   `reasoning: {"effort": "low"}` (extraction is a retrieval/formatting task, not one that
   benefits from deep chain-of-thought) + a further-raised token ceiling as a safety net.
   Re-verified live: `distserve` now completes successfully.
3. **Non-resumable "incremental" builds.** `build_graph()` only called `graph_store.save()`
   once, after the *entire* per-paper loop — so an interrupted multi-minute, multi-paper build
   (a real risk: I killed one live to fix bug #2) lost **all** progress, contradicting the
   explicit "resumable" requirement. Fixed by saving after each paper; added a test that
   interrupts the generator mid-stream and confirms completed papers survive and aren't
   re-extracted on resume. **Verified for real** when a later bug (#5) caused a genuine,
   unplanned kill of a live build — `distserve`'s already-done extraction survived intact.
4. **GraphCanvas mis-centered the graph.** React Native scales a transformed view around its
   own center, so the canvas's center point doesn't move under `scale` alone — centering it on
   the viewport only depends on translate, not scale. The code multiplied `translateX/Y` by
   `INITIAL_SCALE`, which a numeric check confirmed would visibly mis-center the graph on
   first load and on "Reset view" (in one concrete example, the graph's center would land 280
   logical pixels away from the viewport's center on a 400-wide screen — not merely "a little
   off," more like showing the wrong region of the canvas entirely). Found by deriving RN's
   transform-around-center semantics from scratch while self-reviewing the untested
   layout/canvas math, confirmed numerically with a small Python script before touching the
   code — this is exactly the kind of bug tsc/bundle/doctor can't catch and that would only
   otherwise surface on the still-pending on-device test.
5. **Extraction calls could hang far past their intended timeout.** `httpx`'s `timeout=N` is a
   *per-phase* budget (each of connect/read/write/pool up to N seconds), measured per socket
   read, not a total wall-clock cap — some LLM API gateways send sparse keep-alive bytes on
   long completions specifically to avoid tripping a client's per-read timeout, which resets
   that clock indefinitely. Confirmed **directly and live**: a real `splitwise` extraction
   call ran to 8m48s (and still climbing) past its 300s httpx timeout without ever erroring,
   before I killed it. A single stuck paper would otherwise stall an entire project's build
   indefinitely. Fixed with a real wall-clock deadline enforced via a background thread pool
   (`_call_with_deadline`, `EXTRACTION_HARD_DEADLINE = 480s`) — not a naive
   `with ThreadPoolExecutor() as ex:`, which would defeat the point (`__exit__` blocks until
   every submitted job finishes, waiting out the very hang you're trying to escape); the
   module-level executor is never explicitly shut down, and `max_workers=8` so one abandoned
   thread can't also block submitting the *next* paper's request.

6. **Settings screen could silently clobber in-progress edits.** The effect that syncs local
   form fields from `settings.data` re-ran on every reference change to that object — including
   the refetch that follows `saveSettings`' own `invalidateQueries` call. If the user started
   typing a new model/voice change in the brief window before that refetch resolved, the effect
   would overwrite it with the just-saved (now stale-to-the-user) values. Fixed to sync exactly
   once, on first successful load, via a ref guard.
7. **Two hooks' "already running?" guards checked React state, not a ref.** `useStreamingTurn`
   and `useGraphBuild` both had `if (streaming/building) return;` at the top of `run()` —  but
   state only updates on the *next* render, so a fast double-tap in the same tick (before that
   render) could slip two calls past the check. For the graph build specifically, that means
   two concurrent builds racing to load-mutate-save the *same* per-project graph-store file
   (last-write-wins, so the loser's progress on other papers could be silently lost). Fixed
   both with a ref set synchronously before any `await`, so back-to-back synchronous calls
   can't both pass.

An eighth thing worth naming even though it's not a "bug": `_bridge_score`'s co-citation
overlap originally included the node itself in every citer's "other citations" set, which
trivially inflates overlap and suppresses genuine bridge scores for nodes with few other
citations. Found while writing tests (two failed against a reasonable-looking implementation),
fixed by excluding the node from that set.

**Pattern worth noting for future sessions:** every one of these eight issues survived a clean
`tsc`/`pytest`/`expo export`/`expo-doctor` pass — none of them are things static checks or
mocked tests catch. Three came from actually calling the real API on real (messy, large)
papers instead of stopping at a small happy-path sample; the rest came from deliberately
re-deriving math/control-flow by hand in new or adjacent code rather than trusting that "it
compiles" means "it's correct" — the settings-clobber and race-guard bugs in particular came
from asking "what happens if this fires twice in a row" about code that looked fine on a first
read. All of this is worth treating as standard practice, not optional extra diligence, for
async/stateful UI code and any pipeline that calls a real external API.

### Part A — polish (a start, not exhaustive — see "Remaining Part A" below)

- Chat: selectable message text, copy-to-clipboard button per response, proper keyboard
  handling via `react-native-keyboard-controller`, audio-crash fix — **these were actually
  done earlier in this same Claude Code session, before the Fable overhaul prompt arrived**
  (commits `23736d2`, `e38f586` on `main`, already merged before this branch was cut). Noted
  here so the task list is accurate; no new work was needed for them tonight.
- Accessibility: labels on previously-unlabeled icon-only controls (NowPlaying's ±15s
  skip buttons), `accessibilityRole`/`accessibilityState` on exclusive-pick controls
  (Settings' speech-provider Toggle, model chips; the graph screen's filter chips),
  `hitSlop` added where a chip's visual size was under the ~44pt touch-target guideline.
  `TopBar`'s `right` slot generalized to support multiple icon buttons cleanly (was hardcoded
  to a single 44px-wide slot) — used by the graph screen's refresh+recommendations pair.
- Dead code: removed an unused `assembler` import in `app/sessions.py` (pre-existing,
  unrelated to tonight's changes, caught by a `pyflakes` pass over the whole backend).

## Validation performed (all green as of this checkpoint)

```
# Backend
source .venv/bin/activate
python -m pytest tests/ -q                    # 68 passed
python -m pyflakes app/*.py                   # clean
python -c "from app import main; print('OK')" # imports fine

# Mobile
cd mobile
npx tsc --noEmit                              # exit 0, no output
npx expo export --platform android --output-dir dist   # bundles (4.3MB), then rm -rf dist
npx expo-doctor@latest                        # 21/21 checks passed
```

No mobile native build was performed or queued this session (no new native dependency was
added — see the GraphCanvas note above). **The graph feature has not yet been tested inside
the actual dev-client app on-device**; it has been validated via tsc/bundle/doctor and a
from-scratch numeric re-derivation of the pan/zoom centering math (which caught and fixed a
real bug — see bug #4 above), but no one has physically tapped through the Graph screen on a
phone yet. That's the top item for the next session.

## Live backend validation (real OpenRouter calls, real project data)

Ran against the real `llm-inference-serving` project (18 papers) on the live dev server
(`./.venv/bin/uvicorn app.main:app --port 8000`), restarted three times tonight to pick up
code changes as bugs #1-5 were found and fixed — currently running the latest commit
(`dc96463` at last check).

- Bounded single-paper test (`punica`, smallest corpus file) → `status: done`, 37 references,
  15 flagged significant, real contexts and reasonable significance rationale.
- Two earlier full-project build attempts hit bugs #2 (reasoning-token runaway on `distserve`)
  and #5 (the httpx hang on `splitwise`) respectively — both fixed, both re-verified live.
  Both builds were killed at various points during debugging; **the incremental-save fix
  (bug #3) was proven not just by its own test but by real chaos**: `distserve` and
  `splitwise` both ended up safely persisted (`status: "done"`, 60 and 85 references) despite
  multiple kills and a full server restart in between — a server-side worker thread appears
  to have kept running independently of a killed client connection and saved its result
  before the eventual server restart reaped it.
- **A third full-project build is running now** (started ~02:10 PDT, after all five fixes
  landed), confirmed via its own first events to correctly skip both already-cached papers
  (`"cached": true` for `distserve` and `splitwise`) and proceed straight to paper 3
  (`mooncake`) — i.e., the resumability guarantee is working as designed, not just in tests.
  This is a detached background process; **safe to leave running or interrupt at any time.**

**To check its status right now:**
```
curl -s http://localhost:8000/api/projects/llm-inference-serving/graph | python3 -m json.tool
# or, cheaper (no LLM calls either way):
curl -s http://localhost:8000/api/projects/llm-inference-serving/graph | \
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.status)})"
```
If the backend server isn't running: `cd /Users/kamil/research-companion && \
./.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 &` (or `./run.sh`).
If it stopped mid-build, just POST to `/graph/build` again with `{"force": false}` — it
resumes from whatever's cached, no wasted tokens on already-done papers. Expect the
occasional per-paper `status: "error"` (e.g. a genuine JSON-malformation edge case like the
one hit on `splitwise`'s first attempt) — those are automatically retried on the next build,
by design; they don't need manual intervention unless the SAME paper keeps failing every
rebuild, in which case the stored `error` message now includes a content snippet for
debugging (see bug #5's fix).

## Remaining TODOs / next-step checklist

**Immediate next steps (do these first):**

1. **On-device smoke test of the Graph screen** — nothing has confirmed the pan/zoom
   `GestureDetector` + `GestureHandlerRootView` combination actually works at runtime on the
   phone (only tsc/bundle/doctor + careful math review validated it — see bug #4, already
   fixed once via that review). Open the app, go to a project with a built graph, and check:
   is the graph centered on open, does pan/pinch work, do nodes/edges render sanely, does the
   detail sheet open, does tapping a project-paper node navigate to Discussion correctly, does
   "Add to project" from a recommendation actually show up in the Library afterward. Confirmed
   separately (via `babel-preset-expo`'s source): the reanimated/worklets Babel plugin *is*
   auto-configured for this project despite no visible `babel.config.js`, so gesture-callback
   worklet compilation specifically is not expected to be the failure mode if something's off.
2. **Let (or resume) the full 18-paper build finish** for `llm-inference-serving` (running now
   as of this checkpoint — see "Live backend validation" above), then actually look at the
   resulting graph/recommendations for quality (do the significance calls feel right, are the
   recommended papers sensible, try "Add to project" on a real recommendation) — the first
   real-world quality check beyond the single-paper spot checks done so far.
3. **Merge this branch to `main`** once (1) and (2) look good — it's currently sitting
   unmerged on `fable-overhaul-graph-references`, 10 commits ahead of where it branched.

**Deferred/lower-priority:**

- `docs/mobile-app-plan.md` / other docs weren't updated to mention the graph feature —
  worth a pass once the feature is confirmed working on-device.
- Part A is intentionally not exhaustive. Given the scope of Part B (a full new pipeline,
  three real production bugs found and fixed via live testing, plus its complete mobile UI),
  I prioritized landing that coherently over spreading thin across every polish item in the
  brief. Reasonable further Part A candidates, roughly in priority order: a deeper visual
  pass on the Settings screen; `@shopify/flash-list` for the chat transcript if it ever gets
  long (currently plain `ScrollView`, fine at today's scale); reviewing `web/app.js` (the
  legacy web client) for parity now that the backend has new graph routes it doesn't use —
  not required (mobile is the active client) but worth a conscious decision either way.
- **Not part of tonight's brief, but an outstanding user request from earlier in this same
  session** (task tracker item, still pending): edit-message + fork/versioning in the
  Discussion chat (edit a past user message, reset the thread from there, keep the old
  branch recoverable via a version-switcher, à la Claude/Gemini web). This is a materially
  bigger feature (needs backend session-branching, not just UI) — flagging it here so it
  isn't lost, but it was out of scope for tonight's graph-focused overhaul.

## Quota/blocker notes

No hard blocker was hit. The main constraint was **time cost of live LLM calls** during
development (each real extraction call takes minutes), which is why the full 18-paper
project build was left running in the background rather than blocking the rest of the work
on it — the pipeline's correctness was established via the 55-test suite plus three separate
live spot-checks (one of which deliberately tested the failure/kill path), which felt like
sufficient confidence to proceed without babysitting the full run to completion.

## Commit log this session (newest first)

```
dc96463 Harden re-entrancy guards + improve extraction error diagnostics
f80b2e0 Fix Settings: sync-from-server effect could clobber in-progress edits
b5ba329 Fix two real bugs found via careful review + live re-testing
db718d9 Docs: mention the reference graph in README + mobile-app-plan
12f2a06 Close the recommendation loop: add a paper to the project in one tap
96e9bf8 Add handoff/checkpoint doc for the overnight overhaul session
8596b83 Part A polish: accessibility labels, touch targets, dead import
c3cfab5 Mobile: Reference Graph screen + navigation entry points
905ff55 Fix reasoning-token runaway + make graph builds actually resumable
76af973 Fix extraction truncation: bump token budget + add JSON salvage
f4830e1 Backend: reference graph pipeline (extraction, matching, analysis, API)
```
All pushed to `origin/fable-overhaul-graph-references`. 11 commits, 68 backend tests (up from
0 at the start of this session — first test suite in this repo).
