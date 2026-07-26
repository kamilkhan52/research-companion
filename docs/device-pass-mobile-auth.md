# Device pass — mobile authentication (#228)

Everything this needs is configured as of 2026-07-26. **No EAS build is required**: the only new
dependency is `@supabase/supabase-js`, which is pure JS, so Metro reload is enough.

## Setup

1. Backend: the Mac mini on the tailnet is `http://100.83.161.127:8000` and is the app's baked
   default — but it runs `RC_ENV=dev` with auth **open**, so the gate reports `disabled` and no
   sign-in appears. That is correct behaviour and not the thing to test.
2. **Point the app at staging** to exercise auth: Settings → server URL →
   `https://research-companion-staging.fly.dev`. Save & connect.
3. Metro: `cd mobile && npx expo start --tunnel`, paste the `exp://` URL into the dev-build
   launcher. (If ngrok is down, put the phone and Mac on the same network and use the LAN URL.)

## What to check

| # | Step | Expected |
|---|---|---|
| 1 | Launch pointed at staging, signed out | Sign-in screen. **No flash** of app content first, and no flash of the sign-in form on a normal signed-in launch |
| 2 | "Email me a link", then tap the link in the mail app | Signs in. Works whether the app was open or fully closed — the cold-start path is a different code path and was broken for most of the review |
| 3 | Tap an expired or already-used link | An explanatory message, not a silent no-op |
| 4 | "Continue with Google" | In-app browser, returns signed in. **Blocked until H5's staging callback is registered** — until then this fails with Google's `Error 400: redirect_uri_mismatch`, which is a Google Cloud Console gap, not an app bug |
| 5 | Dismiss the Google browser without finishing | Back on sign-in, **no error message** — dismissing is not a failure |
| 6 | Force-quit and relaunch | Still signed in, no sign-in screen. This is what the chunked SecureStore session is for |
| 7 | Leave it signed in for over an hour, then use it | Still works. A stale token would surface as sudden 401s, which is the failure the refresh wiring exists to prevent |
| 8 | Play a narration, then Settings → Sign out | **Audio stops.** It used to keep playing over the sign-in screen |
| 9 | Settings → Sign out | Returns to sign-in; relaunch stays signed out |
| 10 | Point at a nonsense URL, e.g. `https://nope.invalid` | "Can't reach the server" **with an editable address field** — Settings is behind the gate, so this is the only way back |
| 11 | From the sign-in screen, "Change server" | Same editor, with a Back button |
| 12 | Point back at the Mac mini (`http://100.83.161.127:8000`) | App opens straight in with no sign-in (auth is open there), and shows **the Mac mini's projects, not staging's** |
| 13 | Settings → Save & connect **without editing the URL** | Nothing reloads. It used to wipe the whole cache and re-bootstrap auth |

## Known and deliberately not fixed

Switching servers **while audio is playing** can, on a precise timing, let an old player operation
touch the player after teardown. Recorded as P1-16; most of it predates #228. Not worth chasing
during this pass.
