# Performance proposal — Scholiast (mobile)

*Written 2026-08-03. Suggestions only — no code changed. Grounded in the current
codebase (SDK 56 / RN 0.85.3 / reanimated 4.3.1 / worklets 0.8.3, react-compiler on)
and in the performance work done on the sibling app (Word Magic), whose docs
(`docs/perf.md`, `mobile/AGENTS.md`) hold the measured war stories.*

## 0. Principles (the why)

- **The JS thread is the scarce resource.** React renders, stream updates,
  markdown/MathJax parsing, and anything in `setState` all run there. Every frame
  of animation should be UI-thread (Reanimated worklets + shared values).
- **Never re-render React per frame.** Per-frame `setState` (or shared-value-driven
  renders) of a large tree (paper screen) costs 7–19ms/frame on modest hardware —
  that's a measured fact from Word Magic's identical mistake.
- **Measure before and after.** The device-ledger discipline already exists; add the
  perf recipes below to it so "feels smooth" becomes numbers.

## 1. Measurement methodology (adopt)

- `adb shell dumpsys gfxinfo <pkg> reset` before an interaction, then read Total
  frames / Janky frames / 50-90-95-99th percentiles. Repeat on the physical device,
  not just the emulator (emulator GPU hides JS wins).
- **JS-thread probe:** schedule a repeating 100ms timer that measures its own
  overshoot; `>16ms` late = the JS thread was blocked. Cheap, catches stream/parse
  storms without profiling.
- **Hermes sampling profiler** (`react-native profile-hermes` / `adb shell am
  broadcast -a com.facebook.react.ACTION_START_SAMPLING_PROFILER ...`) for flame
  graphs of the hot paths (streaming turns, math rendering, graph layout).
- **RN perf monitor** (dev menu) for a live JS/UI FPS readout during device passes.
- Log markers (one-off `console.log` around loops) for anything invisible to dumps —
  same convention Word Magic uses for its animation loops.

## 2. Findings and opportunities by area

### 2.1 Streaming turns / paper screen (`app/paper/[slug].tsx`)
Already aware of FlatList behavior with a growing streaming message (comment at
L2015). Recommendations:
- Keep stream chunks **batched per frame**: accumulate text and flush at most once
  per rAF or on a fixed cadence; let the cursor blink separately via Reanimated so
  it doesn't re-render the row.
- `renderItem` → memoized row components with stable props (React.memo + stable
  callbacks via `useCallback`); the react-compiler helps but memoization of
  expensive rows (markdown/math) still pays off.
- Keys stable across the stream lifetime; avoid remounting rows on edit.
- If the thread/favorite option lists grow long, move from FlatList to
  `@shopify/flash-list` (recycled views, better for 100s of items); FlatList is fine
  for small lists — don't change for change's sake.
- Markdown/math rows (2.2) dominate the per-row cost — fix that first.

### 2.2 Markdown + MathJax (`components/Markdown.tsx`, `MathView.tsx`)
`mathjax-full` is an HTML engine running on the JS thread — the single biggest
per-render cost candidate on paper/notes screens.
- **Cache aggressively**: parse/render each unique formula + markdown block once
  (map keyed by text hash), not per mount. Streaming turns produce many near-identical
  re-parses.
- **Render only what's visible**: lazy math rendering with a cheap visibility check
  (onLayout intersect) — defer off-screen rows.
- **Debounce during streaming**: skip math rendering for in-flight chunks; render
  when the message settles (or render plain text until idle).
- If MathJax remains hot after caching, scope it: precompile the most common
  formulas at build time, and consider a lighter fallback renderer for simple
  inline math.

### 2.3 Graph canvas (`components/graph/GraphCanvas.tsx`)
Custom reanimated + gesture-handler (no SVG — good). The rules that cost Word Magic
a month of fixes:
- **Gesture/pan/zoom state lives in shared values, not React state.** `setState`
  during a gesture = per-frame renders. Commit to React state only on gesture end.
- **Never `setState` inside worklets / `useFrameCallback`.** (Word Magic's crash:
  calling setState from the UI thread tore down the render surface.) Pure math +
  shared-value mutation only.
- `useFrameCallback`'s callback **re-registers when its identity changes** — keep it
  a stable `useCallback`; put mutable simulation state in shared values (or
  `makeMutable` arrays), not closure variables that must persist.
- Node layout: compute in a worklet or memoize; avoid recomputing layout on every
  parent render.

### 2.4 Discovery scanning reel (`components/ScanningList.tsx`)
Live-appended children via `map`. Recommendations:
- Stable child identity; animate insertions with layout animations on a **wrapper**
  view, never on a view that also carries an animated `transform` (Reanimated warns
  "transform may be overwritten by a layout animation" — Word Magic hit this).
- Throttle appended items to a per-frame batch; cap the visible list (window) so
  the tree doesn't grow unbounded during a long run.

### 2.5 Audio player (`react-native-track-player`, 7 refs)
- `useProgress` subscriptions re-render on interval — scope them to the player
  screen/`NowPlaying` only, and throttle (e.g. 500ms) or drive progress via a
  Reanimated shared value updated by a low-frequency interval.
- Narrations are long (minutes); verify no re-buffering/re-decode on seek — and that
  progress persistence (`playback-persistence.js`) never writes on every tick
  (debounce writes).

### 2.6 Bottom sheets + keyboard
- Content inside sheets should be lazy (mount on open) but memoized after first
  open (sheets open/close repeatedly — avoid re-parsing markdown each time; 2.2's
  cache covers most of it).
- `react-native-keyboard-controller` + `useKeyboardInset` — keep keyboard-driven
  re-layout out of render; apply via shared values/`useAnimatedStyle` where it
  affects animation.

### 2.7 React Query / data
- Set sensible `staleTime`/`gcTime` for graph + paper metadata (avoid refetch
  storms on focus); consider structural sharing already provided — keep query keys
  stable.
- Large graph payloads: cache the parsed form, not just the raw JSON.

### 2.8 Startup & bundle
- `mathjax-full` is heavy: **lazy-import it** so it loads only when the first
  math-bearing screen opens (dynamic `require`/route-level split). Biggest single
  startup win available.
- Fonts: already loaded via expo-font; ensure they're not blocking first paint
  longer than necessary (splash holds until ready by design).
- Audit unused deps (any web-browser/glass-effect/symbols leftovers like Word
  Magic had) — smaller bundle, faster eval.

### 2.9 Worklets API hygiene (applies to all of the above)
- **`scheduleOnRN` instead of `runOnJS`** for worklet→JS calls. `runOnJS` is
  deprecated upstream (worklets 0.10 throws "Tried to synchronously call a Remote
  Function"); 0.8.3 still accepts it, but migrating now avoids a forced change and
  the foot-gun.
- No `setState` in worklets; shared values for anything crossing the thread
  boundary; plain objects captured in a worklet are copied once (mutations don't
  propagate back).
- Document pins + these rules in a `mobile/AGENTS.md` (Word Magic's has been the
  single most load-bearing file for perf work).

## 3. Prioritized roadmap

**Quick wins (days):** streaming batch flush · memoized list/markdown rows ·
scheduleOnRN migration · progress-subscription scoping · MathJax lazy import ·
`staleTime` tuning.

**Medium (a week or two):** markdown/math render cache + visibility-gated
rendering · graph gesture/state hygiene (shared values, no per-frame setState) ·
scanning-list windowing.

**Deep (validate need first, with measurements):** FlashList migration · MathJax
replacement or build-time precompile · worker-thread parsing (only if Hermes
profiler proves parse time matters after caching).

## 4. Success criteria
- Device passes (existing ledger workflow) record: p95 frame ≤ 25ms on the physical
  device during streaming turns, graph pan/zoom, and the discovery reel; JS-thread
  probe stays under 16ms overshoot except during first paint.
- No `updateAndRelease`-class crashes from worklets (never setState on UI thread).
- Startup to first interactive improves measurably after the MathJax lazy-import.

*Cross-reference: Word Magic `docs/perf.md` (measured methodology + golden rules)
is the detailed source for sections 1 and 2.9.*
