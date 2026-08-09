# Responses as playlist tracks — design brief (R12.7)

**Status:** implemented on `r12-7-audio-playlist`; native-build acceptance remains.
**Scope note from Kamil: "don't go too deep."** The implementation deliberately builds on the
existing TrackPlayer queue and audio-job polling path instead of introducing a playlist store.

> **Blocked on a native build for verification.** The audio/player scenarios this touches (D31,
> D33–D35) were blocked on the 2026-07-21 pass because they need a native EAS build, not the Expo
> dev client. Final acceptance requires Kamil's device pass ([[device-test-preparation]]).

## Goal

Treat successive assistant responses as playlist tracks: the full-screen player makes it easy to
play the next existing response, and can continue through responses when the listener explicitly
opts into autoplay.

## Resolved product decisions

1. **Autoplay is off by default.** The full-screen player has a session-only toggle. It is held in
   `AudioProvider` memory and is not persisted to settings or AsyncStorage.
2. **Placement is the full-screen player only** (`mobile/src/app/player.tsx`). The mini-player and
   response bubbles are unchanged.
3. **The controls are Listening-mode only.** Reading-mode playback is unchanged.
4. **Next means the next existing assistant response in the active thread's transcript order.**
   It never generates a new user or assistant turn.
5. A manual **Play next** control remains available independently of the autoplay toggle.

## Engineering approach

The implementation is queue-first:

- `Play next` inspects `TrackPlayer.getQueue()` and the active index. It skips previews, repeated
  progressive-audio segments for the current response, and tracks from other threads, then skips
  directly to the next queued response.
- If no next response is queued, the active track's `messageAudioId` is parsed back into project,
  conversation slug, and assistant index. The provider reads the existing session transcript and
  selects the next assistant entry. Independent-thread ids folded into the audio slug are mapped
  back to their session address.
- If that response already has an audio job, the provider reuses it. Otherwise it starts the same
  server-side background audio job used elsewhere, passing the parsed project as
  `billingProject`, then hands the job to `enqueueJob` for polling and ordered TrackPlayer append.
  This keeps narration preparation backgrounded, attributed, and non-blocking.
- On `PlaybackQueueEnded`, the provider runs the same next-response operation only when the
  in-memory autoplay toggle is enabled. With autoplay off, queue-end performs no transcript request,
  starts no audio job, and spends no TTS tokens.
- Playlist-triggered jobs use the existing no-toast queued-audio contract. They are not recorded as
  one-time live chat handoffs, so replay is not incorrectly suppressed by handoff persistence.

`mobile/src/audio/playlist.ts` contains the pure queue/transcript selection and autoplay-gating
logic. `parseMessageAudioId` and the independent-thread address helper live beside the encoder in
`mobile/src/audio/identity.ts`.

## Live Listening no-regression argument

The autoplay toggle does **not** gate, pause, remove, or reorder tracks already appended by the
live Listening flow. `enqueueJob` still appends successive live responses without interruption,
and TrackPlayer still advances through that native queue naturally. It also retains the existing
behavior of starting a newly appended live response when the prior queue has already ended.

This is intentional: autoplay controls whether queue exhaustion may discover and prepare another
existing response. It does not redefine the established continuous delivery contract for responses
that a live Listening session has already prepared and queued.

## Billing and invariants

- Automatic discovery/preparation is opt-in. Autoplay off cannot initiate transcript lookup or TTS.
- Manual Play next is an explicit spend authorization when the next response needs narration.
- Newly prepared narration carries the project decoded from the active message identity into
  `startAudioJob`/`enqueueJob`, preserving usage attribution.
- Audio preparation remains server background-job + client polling (Invariant 1).
- Queued audio remains toast-free.
- No backend turn path, marker protocol, project record, or approval flow changed.

## Deliberate boundaries / follow-ups

- No visible queue or Up Next list was added.
- No arbitrary-response picker or reorder/edit UI was added. R12.7 only advances forward from the
  active response.
- No mini-player, inline bubble, Reading-mode, lock-screen-control, or backend API changes were made.
- The player does not generate a new turn when the transcript has no later assistant response.
- A future richer history browser could pre-populate more responses, but should continue to use the
  same identity, billing, and `enqueueJob` path.

## Native-build acceptance

Kamil's device pass must verify:

- manual Play next for an already queued response and for a response prepared after queue end;
- autoplay off causes no queue-exhaustion preparation, while live Listening responses already
  queued continue naturally;
- autoplay on advances repeatedly through existing responses and stops at the transcript end;
- background/lock-screen queue advance, notification metadata, and playback-rate behavior;
- progressive and full-track modes, including skipping remaining segments to the next response;
- cancelling preparation still cancels paid synthesis and removes upcoming tracks.

Related: [`device-review-ledger.md`](device-review-ledger.md) (DR-014), [[device-test-preparation]],
`docs/player-jump-controls-design-brief.md`, CLAUDE.md invariant 1, and `usage.py`.
