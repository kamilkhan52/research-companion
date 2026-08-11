# Comment-mode polish (DR-053)

*Drafted 2026-08-10 from Kamil's device pass. Three defects and one design question, refining
DR-009's sentence-comment feature. Status: design + named investigations — nothing here is
built. The mockups (Figma production-readiness section, see
[`figma-runtime-design-handoff.md`](figma-runtime-design-handoff.md)) are the visual reference;
a Figma pass for the sentence-interaction treatment should precede the code for §3.*

## The pieces, located

- **Inline indicator:** `mobile/src/components/Markdown.tsx` (~line 505) — an annotated
  sentence gets a violet underline + a count badge rendered as nested `RNText` with
  `fontSize: 10`, violet background, `t.bg` text.
- **The floating "M comments attached / Done" bar:**
  `mobile/src/components/chat/SentenceCommentComposer.tsx` — the `queue` block (queueHead row +
  horizontal chip scroller), rendered inside the paper screen's `composerOverlay` above the
  `InputToolbar` (`paper/[slug].tsx` ~line 1920).
- **Comment mode itself:** `annotatingAssistant` state on the paper screen; sentences become
  pressable via `sentenceAnnotations` passed into Markdown.

## 1. Indicator legibility (defect)

Kamil: too large, too transparent, hard to read over thread text. Fix directions:

- **First, diagnose — the obvious fix is already the code.** The badge ALREADY renders
  `backgroundColor: t.violet` (a solid hex in all three palettes; only `violetWash` carries
  alpha) with `t.bg` text. Whatever Kamil is reading as "too transparent" is therefore NOT the
  badge's declared background — candidates: nested-`RNText` background rendering on Android
  (text backgrounds paint per-line-fragment and can composite oddly over the bubble), the
  UNDERLINE + `violetWash` selection treatment being mistaken for the indicator, or a Dim/Black
  wash behind the text lowering effective contrast. Reproduce on his palette/density first;
  this belongs to the same Metro session as §2's investigation.
- The size half stands on its own: the badge inherits the sentence's line box and reads
  oversized. Render it as a proper superscript-style chip — 10–11px text, `radius.sm`, vertical
  alignment tuned so it doesn't distort line height. The *underline wash* on annotated
  sentences may keep a light `violetWash` ("slight transparency is okay for immersion"); the
  badge stays opaque. Both densities, all three palettes — Black's washes are the ones that
  vanish, test there first.

## 2. The floating bar (defect × 2: looks unfinished, taps do nothing)

The bar has no surface of its own — `queue`/`queueHead` styles carry no background — so it
floats over whatever chat content is behind the composer overlay. Fix: give the queue block a
real surface (`ToneSurface tone="violet"` framing, or `t.elevated` card with a hairline top
border), visually part of the composer stack rather than text hovering in space.

**Positioning:** Kamil's diagnosis is right — it renders at the bottom of the screen in the
composer overlay, while the reader is usually mid-response. Two-part fix:
- Keep the authoritative queue where it is (attached to the composer, where Done/submit live) —
  but with its real surface it now reads as a deliberate tray, not floating text.
- Add the *in-context* affordance: when a sentence is selected/commented, the indicator at the
  sentence (§1's chip) is the visible confirmation where the reader is looking. The tray is the
  queue; the chip is the acknowledgment. No duplicate bar mid-scroll.

**The dead taps — named investigation, do this first:** "I also can't really click it and it
doesn't do anything." Two suspects, both checkable in one Metro session:
1. `composerOverlay` sits inside GiftedChat's `renderInputToolbar` replacement; its `onLayout`
   drives `composerHeight`, and the chat list's `contentInset` is derived from it. If the queue
   block renders OUTSIDE the measured/hit-tested area (overlay height not including the queue at
   the moment of layout), taps pass through to the list behind. Instrument with a background
   color on the overlay + `onPress` console logs at each level.
2. The keyboard-controller `KeyboardAvoidingView` (`behavior="padding"`) can translate the
   toolbar visually while hit-testing stays at the untranslated position (the DR-055 mini-player
   overlap is the same family — reproduce both in one session; a shared root cause is likely).
   If confirmed, the fix is structural (the overlay moves inside the avoiding view's measured
   subtree), and DR-055 falls out of it.

## 3. Sentences that look interactive in comment mode (design question)

Kamil: entering comment mode should make sentences "appear more clickable or interactive, while
still preserving readability close to the original reading view." Direction to mock in Figma
before coding:

- Comment mode adds a **mode-wide cue**, not per-sentence chrome: a subtle full-width tint or
  hairline frame around the annotatable message + a one-line header ("Tap a sentence to attach
  a comment") so the mode is legible without styling every sentence.
- Per-sentence, on press-in only: the existing `violetWash` highlight. Persistent per-sentence
  affordances (dotted underlines on everything) fail the "close to the original reading view"
  constraint and were the rejected direction in DR-009's first pass.
- Selected sentence: full `violetWash` + underline (exists today) — unchanged.

Deliverable from the Figma pass: the mode header treatment, tint values per palette, and the
badge chip from §1, added to the `Runtime components · Review`-adjacent section with node IDs
recorded in the handoff doc.

## Order of work

1. Investigation §2 (dead taps) — it may reshape the positioning fix and resolve DR-055.
2. §1 badge + §2 surface (one PR, pure styling + the hit-test fix).
3. §3 after its Figma pass (needs the `figma-console-mcp` Keychain credential — setup is
   documented in [`figma-workflow.md`](figma-workflow.md); it is Kamil's action and now listed
   in HUMAN_ACTIONS).

## Test surface

Jest: style/prop assertions on the extracted chip component (opaque background token, size);
comment-mode header present only in mode. Tap targets: `@testing-library/react-native` has no
layout engine, so a role query proves nothing about 48px — the honest test asserts the STYLE
and PROPS that produce the size (`minHeight`/`hitSlop`), and the one real defect is already
identifiable that way: the `Done` control is a bare `Pressable` around a `Text` with no
`hitSlop` and no minimum size, while the chips already carry `minHeight: 54`. The hit-testing
bug gets a device verification script in the checklist, not a Jest test — it is native layout
behavior Jest cannot see.
