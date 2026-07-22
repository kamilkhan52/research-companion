# Responses as playlist tracks — design brief (R12.7)

**Status:** brief only, no code. Written for a fresh implementing agent (GPT-5.6-sol).
**Scope note from Kamil: "don't go too deep."** This is intentionally a *brief*, not a full
design — the foundation exists; what's missing is a small amount of UX and one autoplay decision.
**Revise this as you implement** and keep it updated.

> **Blocked on a native build for verification.** The audio/player scenarios this touches (D31,
> D33–D35) were *blocked* on the 2026-07-21 pass because they need a native EAS build, not the
> Expo dev client. Implement behind the existing audio plumbing, but final acceptance requires a
> device with a native build. Coordinate with Kamil ([[device-test-preparation]]).

## The goal

Treat successive assistant responses as **playlist tracks**: when the currently-playing response
finishes, make it trivial to **play the next response**, with **optional autoplay**.

## What already exists (don't rebuild it)

The queue foundation is in `mobile/src/audio/AudioProvider.tsx` and `react-native-track-player`:

- **`enqueueJob(req, audioJobId, billingProject, chatJobId?)`** (AudioProvider.tsx:52) already
  "queues audio already started by a listening-mode chat job. Preparation may overlap current
  playback; the resulting track is appended and never interrupts what is playing." So **Listening
  mode already auto-queues successive responses** onto the native player's queue.
- `TrackPlayer` holds a real queue (`getQueue`, `activeIndex`, `queue.slice(activeIndex+1)` for
  "upcoming" — AudioProvider.tsx:467-477). Background/lock-screen/queue behavior is D33.
- `playText` is the manual (reading-mode) single-track path; `playPreview` is the idle-only cue
  path. The mini-player (`NowPlaying.tsx`) and full player (`app/player.tsx`) render the active
  track; the mini-player is now a plain bar (R12.6, PR #212).

So the *plumbing* to have multiple response tracks queued and advancing already works in Listening
mode. R12.7 is about **making it a first-class, visible playlist with play-next affordances and an
autoplay choice** — not about building a queue.

## The actual gap

1. **A "play next response" affordance when the current one ends** — outside Listening mode
   (reading mode plays a single track via `playText` and stops). Decide where this lives: the full
   player (`app/player.tsx`), the mini-player, and/or an inline control at the end of a response
   bubble. This is primarily **affordance-placement design** (needs Kamil's eye).
2. **Optional autoplay** — a user setting: when a track ends, automatically prepare+play the next
   response's audio (reusing `enqueueJob`). Off by default is the safe assumption (it spends TTS
   tokens); confirm with Kamil. Wire it to the existing settings surface (R7.x settings panel).
3. **A visible queue / "up next"** (optional, only if it reads well) — the player already can
   compute `upcoming` from the TrackPlayer queue; surfacing it is a small UI addition. Keep it
   minimal per "don't go too deep."

## Constraints

- **Invariant 1** — audio prep is already background-job + poll; keep any new "prepare next"
  path on that pattern. `enqueueJob` already overlaps prep with playback without blocking.
- **Billing** — queued/auto-played narration bills the initiating project (or the app-global
  `UNATTRIBUTED` ledger); `enqueueJob` already carries `billingProject`. Autoplay must pass it so
  usage stays attributed (usage.py contract). Don't spend tokens silently — autoplay is opt-in.
- Queued audio deliberately **never toasts** ("auto-play is its whole contract" — AudioProvider
  READY_TOAST comment); keep that.

## Open questions (resolve with Kamil)

1. **Autoplay default** — off (recommended, token cost) or on? Global setting vs per-session?
2. **Affordance placement** — end-of-bubble "Play next," a full-player "next" control, an
   auto-advance toggle, or all three? This is the "needs affordance-placement design" flag from
   [[round12-queue]]; likely a Figma pass ([[ui-design-via-codex-figma]]) before coding.
3. **Reading vs Listening parity** — should reading mode gain the same auto-advance, or does
   play-next only make sense in Listening mode (where responses are already narrated end-to-end)?
4. Does "next response" mean the next *existing* response in the thread, or generate-and-play the
   next turn? (Almost certainly the former — play existing responses in order. Confirm.)

## Suggested phasing

- **P0:** design pass with Kamil on affordance placement + autoplay default (Figma if it needs
  layout). No code until this is settled — the plumbing already works, so the risk is all UX.
- **P1:** autoplay setting + auto-advance on track-end using `enqueueJob`, billing-attributed,
  opt-in.
- **P2:** optional "up next" surfacing in the player if it reads well.
- **Acceptance:** native build device pass (D31/D33–D35 style) — background, lock-screen, queue
  advance, and cancel all still behave.

Related: [[round12-queue]] (R12.7), [[device-test-preparation]], [[ui-design-via-codex-figma]],
`docs/player-jump-controls-design-brief.md` (adjacent player UX), CLAUDE.md invariant 1 + usage.py.
