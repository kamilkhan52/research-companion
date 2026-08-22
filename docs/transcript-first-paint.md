# Transcript first paint (DR-100)

*2026-08-22. The measurements, the fix that shipped, and the levers deliberately left on the
table. Research: an Opus 5 web-research pass (sources inline) cross-checked against live
profiling on the emulator; where they disagreed, the profile won.*

## The problem

Cold-opening a long discussion (the HBF thread: dozens of messages, individual messages up to
~30k chars of Markdown with many TeX→SVG equations) showed a **blank surface for 3–4s**. The
session response returns in ~10ms — everything after that was client-side.

## What profiling showed (emulator, cold caches)

| Suspect | Measured | Verdict |
|---|---|---|
| MathJax TeX→SVG conversion | 110+ conversions, **224ms total** | Not the bottleneck |
| Markdown parse per message | **not one message > 16ms** | Not the bottleneck |
| List initial commit (default `initialNumToRender` 10, `windowSize` 21) | **~4.7s** to second render | The bottleneck |
| Same, with `initialNumToRender` 3 / `windowSize` 7 | **~2.5s** | Improved, floor reached |
| Same, with `initialNumToRender` 1 | still ~2.5s | One message dominates |

The floor exists because a single huge assistant message is **one uninterruptible mount** on
the JS thread — hundreds of blocks, dozens of SVGs — and React only yields *between*
components. No list parameter can shrink the biggest item.

## What shipped

1. **List tuning** (`initialNumToRender: 3`, `maxToRenderPerBatch: 3`, `windowSize: 7`,
   `updateCellsBatchingPeriod: 50`): ~4.7s → ~2.5s to a usable transcript.
   `removeClippedSubviews` deliberately NOT enabled: RN documents it as bug-prone, and the
   inverted list's `scaleY: -1` transform is the documented failure class.
2. **The skeleton now covers the mount, not just the fetch** (`useTranscriptFirstPaint`):
   the same `DiscussionLoadingSkeleton` the loading gate shows is held as an overlay until
   the list reports its **first viewable item** (`onViewableItemsChanged` — NOT
   `onContentSizeChange`, whose padded container reports height > 0 before any item exists),
   with a 6s ceiling so a render failure can never strand it. Perceived blank: **zero**.

## Levers deliberately left un-pulled (in payoff order, when this needs another round)

- **Per-block progressive hydration** — split each message into per-block components and
  hydrate in `startTransition`, outward from the anchor. The only change that attacks the
  dominant-item floor itself. Prereq for any concurrency benefit: React yields only between
  components. Anchor caveat: with `maintainVisibleContentPosition` on an inverted list,
  placeholders must not change height at/below the anchor or the viewport jumps.
- **Persist the math SVG cache** (MMKV, keyed by `hash(tex+display)`) and warm it at
  message-receipt time. Here it was only 224ms — worth it eventually, not the first move.
- **Legend List** (`@legendapp/list` v3: `initialScrollAtEnd`, `maintainVisibleContentPosition`,
  chat-first API) as a scroll-perf project later. FlashList v2 deprecates `inverted` and has
  open chat regressions (Shopify/flash-list #1844, #2050, #1872); migrating either means
  replacing the chat library's internal FlatList — not worth it for first paint, which the
  list wasn't causing.
- **Do not build on `InteractionManager`** (deprecated ~RN 0.81) or `requestIdleCallback`
  (missing on New Architecture, facebook/react-native#44636). A `setTimeout(0)` chunk pump +
  `startTransition` is the boring, existing alternative.
- **Measuring properly**: `react-native-release-profiler` (Hermes sampling → Perfetto/
  speedscope) in a release build; define the metric as thread-open → first viewable item.

Key sources: reactnative.dev/docs/optimizing-flatlist-configuration; Shopify FlashList v2
migration notes and issues #1844/#2050/#1872; legendapp.com/open-source/list; MathJax
performance wiki; react-navigation#13041 (InteractionManager deprecation); margelo/
react-native-release-profiler.
