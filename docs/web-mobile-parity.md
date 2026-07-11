# Web/mobile parity record

This record maps the current mobile product work to the web client. “Parity” means the same
research workflow and data contracts, adapted to browser conventions; it does not mean copying
native-only device behavior.

## Ported to web

- Shared active-project state across navigation and audio, so narration usage is billed to the
  project that initiated it.
- Persistent Library/Discover/Notes/Map navigation, recent-session continuation, project progress,
  status filters, paper removal with explicit confirmation, and graph recommendation adds.
- Reading modes, reading/listening delivery, per-response model selection, stop generation,
  retry-with-model, related works, and continuation of committed discussions.
- Authored-draft persistence for replies, discovery goals, manual notes edits, and agent-edit
  instructions. Agent note edits remain proposals until the user applies them.
- Safe rich scholarly text with KaTeX equations, pseudo-tool cleanup, explicit `rc-paper:` links,
  and exact-title internal linkification. External links open safely in a new tab.
- Listening-mode final narration, preparation status, seek/scrub, ±15 seconds, sentence navigation,
  playback speed, transcript, and the global mini-player.
- Mobile-aligned model/key settings, stale-graph rebuilds, serialized background-job polling, and
  responsive navigation/layout styling.

## Browser-specific adaptations

- Native lock-screen/headset integration, background TrackPlayer queues, haptics, splash assets,
  and touch-gesture physics remain mobile-only.
- Grounded preview-cue generation remains visible as job progress on web, while final narration is
  played when ready. Browsers may block delayed autoplay; the mini-player and Listen action remain
  available for an explicit user gesture.
- Web uses hash routes and HTML5 Audio or browser speech; mobile uses Expo Router and TrackPlayer.

## Verification

- Web unit tests cover routing, project/library state, background-job recovery, notes approval,
  discovery, settings, and rich internal-link/Markdown safety behavior.
- TypeScript and the Vite production build pass.
- The full network-free backend test suite passes.
