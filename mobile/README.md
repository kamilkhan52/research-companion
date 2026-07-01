# Research Companion — mobile app

React Native + Expo client for the Research Companion backend (`../app`). Android-first, with a
thin client / server brain design: all retrieval, LLM analysis, narration and TTS stay on the
server; the app renders the Library, streaming Discussion, and plays narration audio in the
background (lock-screen controls) for listening on a walk.

## What's here

- **Library** — project switcher + papers, project-scoped (`/api/projects/{pid}/…`).
- **Discussion** — compose-first opening prompt → streaming chat → draft notes → approve.
- **Audio** — per-message *Listen*; background + lock-screen playback via `react-native-track-player`.
- **Reference graph** (`src/app/graph.tsx`) — pan/zoom citation graph over the project's own
  papers + external references, search/filter, recommendations with one-tap "add to project."
  Pure JS (no new native dependency — `react-native-gesture-handler` + `react-native-reanimated`
  were already linked into the build); reachable from the Library and Discussion screens.
- **Settings** — server URL (stored on device) + analysis/narration models, keys, speech (server-side).

## Important: this needs a custom dev/standalone build, not Expo Go

The app uses native modules (`react-native-track-player`, `expo-secure-store`, slider), so Expo Go
won't run it. Build once, then iterate JS over Metro / OTA.

### Recommended: EAS cloud build (no local Android SDK needed)

```bash
cd mobile
npm install -g eas-cli        # or use npx eas-cli@latest
eas login                     # your Expo account (you must do this — I can't log in for you)
eas build:configure           # one-time, links the project (creates the EAS project id)

# A standalone APK you can sideload on your Android and use anywhere (best for "on a walk"):
eas build --profile preview --platform android
```

EAS returns a download link / QR for the APK. Install it on the Android device, open the app, go to
**Settings → Server**, paste the current Cloudflare tunnel URL, *Save & connect*. The tunnel URL
changes each run, so you just update it in Settings — no rebuild needed.

For active development with live reload, use the `development` profile instead and run `npx expo start`:

```bash
eas build --profile development --platform android   # dev client APK (install once)
npx expo start                                        # then open the dev build, scan/connect
```

### Local build (alternative) — requires Android SDK + JDK 17 + adb

```bash
npx expo run:android   # prebuilds + compiles + installs on a connected device/emulator
```

## Configuration

- **Server URL**: set in-app (Settings). Persisted in AsyncStorage. Can be pre-baked via
  `app.json` → `expo.extra.apiBaseUrl` if you want a default.
- **Auth**: off by default (backend `RC_AUTH_*` unset). When Supabase auth is enabled later, the
  app will add a sign-in screen; the API client already sends a bearer token if present.
- **Audio requires the OpenAI speech provider** on the backend (Settings → Audio → OpenAI + key);
  there's no browser TTS on a phone.

## Notes / known risks to verify on-device

- `react-native-track-player` (v4.1.2) predates the New Architecture and runs via RN's bridgeless
  interop on SDK 56. JS + bundling + prebuild all pass; **background/lock-screen audio must be
  confirmed on a real device build.** If it misbehaves under new arch, the fallback is `expo-audio`
  (loses some lock-screen richness) or setting `expo.newArchEnabled: false` in `app.json`.
- iOS: add **Sign in with Apple** before TestFlight (App Store rule 4.8); needs an Apple Developer
  account ($99/yr).

## Project layout

```
src/
  api/        # config, fetch client, SSE stream, typed endpoints, TanStack Query hooks
  audio/      # TrackPlayer setup + AudioProvider (narrate→speak→play)
  app/        # expo-router screens: index (Library), settings, paper/[slug] (Discussion)
  components/  ui/  store/  theme/   # TopBar, ProjectSwitcher, Markdown, NowPlaying, primitives, tokens
service.js    # TrackPlayer playback service (remote controls)
index.js      # JS entry: registers playback service, then expo-router
```
