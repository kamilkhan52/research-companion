# Job-completion push notifications (DR-050)

*Drafted 2026-08-10 from Kamil's device-pass request: "sending notifications when something the
user requested is ready (some long job completion) such as the Map build or Discover job."
Status: design — nothing here is built.*

## What this is, and is not

A push notification when a **long job the reader explicitly started** finishes — first cut is
exactly two: the Map build and a Discover run, the two jobs long enough that people leave.
It is not a re-engagement channel, not a digest, and not wired to every job: a chat turn or an
audio prep finishes while the reader is still looking at the screen that started it, and a push
for those would train people to disable notifications.

Scheduled-discovery notifications (DR-051) ride this same delivery path but decide *whether* to
notify differently; this doc owns delivery, DR-051 owns that judgment.

## Architecture

### Client: Expo push tokens

The app is an Expo dev-client build, so `expo-notifications` gives us the token path without new
native code: `getExpoPushTokenAsync()` → an `ExponentPushToken[...]` string. The client registers
it after sign-in and re-registers on token rotation:

```
POST /api/account/push-tokens   { token, platform }
DELETE /api/account/push-tokens { token }        ← sign-out, and on NotRegistered receipts
```

Permission is requested **lazily** — the first time the reader starts a Map build or Discover
run, not at first launch. A permission prompt attached to the action it serves gets accepted;
one at install gets refused and is unrecoverable without a trip to system settings.

### Server: token registry

A new Postgres table (same optionality rule as everything in `db.py` — unset `RC_DATABASE_URL`
means the feature is quietly off, single-tenant dev keeps working):

```sql
rc_push_tokens (user_id uuid, token text primary key, platform text,
                created_at timestamptz, last_seen_at timestamptz)
```

Tokens are per-USER, not per-project. `tenancy` rules apply to the registration routes; the
sender reads tokens only by the job's bound user id.

### Server: the send hook

`jobs.add_settle_callback` is the designed-for hook: it fires on the worker thread **after**
terminal publication and reservation settlement (DR-035's ordering), with the project still
bound. The graph and discovery job modules attach a callback at start when the job's owner has
registered tokens AND the notification setting is on:

- fire only for terminal `done`/`error` (never `cancelled` — the reader did that themselves);
- **suppress when the app is foreground**: the client heartbeats a `last_active_at` on its
  polls; if the owner polled anything in the last ~30s, they are watching and the push is noise;
- best-effort by contract, like `usage.py`: a failed send logs and never fails the job.

Delivery is one HTTPS POST to Expo's push API (`exp.host/--/api/v2/push/send`), batched sends
unnecessary at this scale. The POST happens on the settle callback's thread — it is a
sub-second call and the worker is already unwound; if it ever grows retries, it moves to its
own tiny queue, not into the job's lifetime.

Receipts: a `DeviceNotRegistered` receipt deletes the token. No other receipt handling in v1.

## Content: nothing the push provider may not see

Expo's push service (and Apple/Google beneath it) stores payloads transiently. Paper titles are
corpus content; goals are the reader's research agenda. **Neither enters a push payload.** The
payload is generic-but-actionable:

- Map build: `"Your map is ready"` / body `"The reference map for <project name> finished
  building."` — project *names* are user-chosen labels, the least sensitive identifier we hold,
  and the notification is useless without knowing which project. If Kamil prefers even names
  out, the fallback body is "Open Scholiast to see it."
- Discover: `"New reading suggestions"` / body `"Discovery finished for <project name>."` Never
  a paper title, never a count of "interesting" results (that is DR-051's judgment anyway).
- Error terminal: `"The map build stopped early"` — no error text, which can quote provider
  responses.

`data` carries `{project_id, kind}` so the tap deep-links to the Map tab / Discover tab of the
right project through the existing router.

## Settings

One toggle, on the existing Settings screen, default ON once permission is granted: "Notify me
when long tasks finish." Per-user (`user_settings`, with the CHECK-constraint migration that
implies). No per-job-kind matrix until someone asks for one.

## What must be defined before building

1. **H-item:** an Expo access token for the push API is an operator secret (`flyctl secrets`),
   and the dev build needs `expo-notifications` added — a native module, so a new dev-client
   build for Kamil's phone (NOT the AAB; the dev build only).
2. The `last_active_at` heartbeat: piggyback on `auth` middleware (cheap, per-request) vs a
   dedicated ping. Piggyback preferred — zero client work.
3. Migration number and the `db._REQUIRED_TABLES` entry (the #342 test will catch forgetting).

## Test surface

Token CRUD with tenancy; the settle-callback firing matrix (done fires, cancelled never,
foreground suppressed); payload NEVER contains a paper title (assert against a seeded corpus);
token deletion on NotRegistered. The Expo POST is injected — the suite makes no network calls.
