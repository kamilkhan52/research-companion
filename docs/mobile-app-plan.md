# Mobile app plan (Android-first, iOS-ready)

> Status: **planning**, with Phase A (backend prerequisites) implemented. This captures the
> agreed direction so the build can proceed in stages.

## Decisions (locked)

- **Stack: React Native + Expo.** Keeps us in JS/TS (same as the web client), gives the best
  dev loop (Expo dev client + EAS Update OTA), and `react-native-track-player` covers the one
  hard requirement — background audio + lock-screen controls for listening on a walk.
- **Android first.** Kamil has an Android device; Android needs no paid account to sideload.
  iOS stays in scope: nothing Android-specific should block it. iOS device testing/TestFlight
  needs an Apple Developer account ($99/yr) — defer until we want it.
- **Thin client / server brain.** No business logic in the app. Retrieval, LLM calls,
  narration, TTS, committing all stay server-side. The app renders Library / Compose / Discussion
  (streaming) / Review / Working-Notes-Review / Settings and plays audio.
- **Hosting: keep the Cloudflare tunnel for now**, shift to a stable host later. The mobile dev
  build points at the tunnel URL during development.
- **Focus: clean design + great audio and chat experience.** These are the product's reason to
  exist; treat them as first-class, not afterthoughts.
- **Multi-project** is a core concept (implemented in Phase A): the app is project-scoped, with
  a project switcher; all data calls go through `/api/projects/{pid}/…`.

## Phase A — backend prerequisites (DONE)

Implemented on the backend + web client so any client can build against a stable, safe API:

1. **Multi-project** — `app/projects.py` registry; data routes under `/api/projects/{pid}/…`;
   per-project git-backed stores under `projects/`; app-global settings/keys in `.app-state/`.
2. **User auth — Supabase** (Google + email magic-link). Backend verifies the user JWT locally
   against Supabase's JWKS (`app/auth.py`, modes: supabase | token | open; off by default).
   Web client has a sign-in screen via `supabase-js`. **Mobile (Phase B):**
   `@react-native-google-signin` → `supabase.auth.signInWithIdToken` with the session in
   `expo-secure-store`; needs a custom Expo dev build (not Expo Go) for native Google. Add
   "Sign in with Apple" before iOS/TestFlight (Apple rule 4.8).
3. **CORS** — `RC_CORS_ORIGINS` for browser clients (native apps ignore CORS). Off by default.
4. **Typed API contract** — `scripts/gen-api-types.sh` generates `shared/api-types.ts` from the
   FastAPI OpenAPI schema, so the app's API types can't drift from the backend.

The audio path was already mobile-friendly: `/api/speak` returns one complete, range-served
mp3 — exactly what `react-native-track-player` wants (background playback, scrub, lock screen).

## Recommended repo layout (when mobile work starts) — monorepo

Both clients share one contract (the API) and Kamil is solo, so a monorepo avoids cross-repo
drift. Restructure in place with history preserved (`git mv`):

```
research-companion/
  app/         # FastAPI backend (today's app/)
  web/         # current web client
  mobile/      # new Expo app
  shared/      # OpenAPI-generated TS types (api-types.ts) + shared constants
  docs/
```

- `projects/` (per-project data repos) and `.app-state/` stay gitignored regardless.
- Build the initial Expo app on a `mobile` branch (it adds a whole toolchain, half-broken for a
  while); merge once it boots, then back to small commits on `main`.

## Build order (after Phase A)

- **Phase B (MVP):** Expo app — Library + project switcher, Compose-first, streaming Discussion,
  Settings. Nail the listen loop: `react-native-track-player` background audio + lock-screen
  controls, narration mp3 from `/api/speak`. State via TanStack Query (optimistic stream,
  authoritative refetch of `/session/{slug}` on reconnect — the server records every turn).
- **Phase C:** Review/approve, Working-Notes-Review, prompt editor, favorites, offline note
  cache, push-on-completion (Expo push when a long opening/turn finishes).
- **Phase D:** polish, Sentry on app + backend, EAS Build → Play internal testing, OTA.

## Open decisions (when we get there)

1. Stable hosting: named Cloudflare tunnel from this machine (free, home-dependent) vs a small
   always-on host (~$5/mo). Single-user → either is fine.
2. Apple Developer account ($99/yr) — only when we want iOS device/TestFlight.
3. Push provider details and offline-cache scope.
