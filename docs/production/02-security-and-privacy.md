# Security, privacy, and Google Play data declarations

*Code-derived inventory checked 2026-07-28 against `origin/main` at `d05a100`. This is an
engineering record and a Play Console **draft**, not an approved privacy policy or a legal
attestation. Re-check it against the exact AAB submitted to Play.*

## Status and decision boundary

This document starts the M2.5 compliance work with facts the repository can establish:

- what the Android app transmits off-device;
- what the backend stores, where it stores it, and which external processors receive it;
- the Google Play Data Safety selections those facts currently imply; and
- the implementation and operator checks that must close before those selections can be
  submitted.

It deliberately does not guess contract terms, provider retention, backup/log retention, the
developer legal entity, or a support address. Those facts are not in the code. The eventual
privacy policy and Play submission are human-approved statements and must not be published from
this draft until the open checks below are resolved.

## Policy snapshot

Official sources checked 2026-07-28:

- [Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469):
  closed, open, and production tracks require the form; “collect” includes data transmitted
  off-device by the app or its libraries; pseudonymous data still counts; and every integrated
  library/SDK must be included.
- [Google Play User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311):
  the in-app and Play-linked privacy policy must identify the app/developer, describe access,
  collection, use, sharing, security, retention, and deletion, and provide a privacy contact. The
  URL must be public, globally accessible, non-editable, and not a PDF.
- [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111):
  an app that supports account creation needs both an in-app deletion path and an external web
  resource, and deletion must cover the account's associated data.
- [AI-generated content policy](https://support.google.com/googleplay/android-developer/answer/13985936):
  users must be able to report or flag offensive AI-generated content to the developer without
  leaving the app.

Policy is mutable. Re-check these sources before implementing a policy-sensitive change and again
immediately before submission.

## Product data inventory

### Data sent from the Android app

| Data | When | Backend/provider use | Required? |
|---|---|---|---|
| Supabase user ID and email address | Sign-in and every authenticated API request | Authenticate, allowlist, own projects, apply user preferences | Required in production |
| Google identity profile fields | Google OAuth | Supabase Auth processes the identity response | **Verify** the configured scopes and live `auth.users` metadata; name/avatar may be present even though this app reads only `sub` and `email` |
| Project name and paper-list metadata | Create/rename/import a project; add or edit a paper | Organize the user's research library | A non-empty project name is required to begin the current research workflow; later paper metadata is user-provided |
| Uploaded PDF, filename, MIME type | User explicitly chooses “Upload PDF” | Extract and retain paper text; build reading context | Optional; direct URL/arXiv retrieval is also supported |
| Paper title, arXiv ID, DOI, or URL | Add/retrieve/search for a paper | Locate scholarly metadata and full text | Optional user-provided research query |
| Discovery topic/question | User runs Discover | Find and rank scholarly sources | Optional in-app search history |
| Chat prompts and thread actions | User discusses a paper | Generate a response, maintain thread state, retry/branch, and prepare notes | Optional in-app messages |
| Notes, synthesis edits, and approval actions | User edits or approves research output | Maintain the approved scholarly record | Optional user-generated content |
| Model, voice, reading, theme, and density choices | User changes settings | Personalize generation/playback and local presentation | Server receives model/voice/reading preferences; theme/density remain device-local |
| OpenRouter, OpenAI, Parallel, Firecrawl, and Semantic Scholar API keys | An instance operator enters or replaces a provider key in Settings | Configure shared backend provider access; persisted in the app-global settings document | Optional operator credential; ordinary readers cannot submit or read it |
| Feature-operation metadata | A paid/background operation runs | Attribute calls, tokens, cost, timestamps, and pending provider generations | Automatically collected app interaction data |
| Authorization token | Every authenticated API request | Authenticate the request | Sensitive authentication data; not a separate Play taxonomy row |

The app does **not** request location, camera, microphone, contacts, call/SMS, photo-library, or
advertising-ID access. Its only explicit Android permission is `POST_NOTIFICATIONS`, used by media
playback. There is no advertising, analytics, attribution, or crash-reporting SDK in
`mobile/package.json` as of this inventory.

`expo-document-picker` accesses only a PDF the user explicitly chooses. Clipboard use is
device-local copy-out. `expo-device` is installed but has no call site; a dependency alone is not
declared as collection unless it actually collects or shares data.

### Device-local data

These values remain on the device and are outside Play's “collected” definition unless a later
change transmits them:

- SecureStore: the Supabase session, API access token, and a short-lived pending-sign-in marker;
- AsyncStorage: server URL override, active project ID, listening/playback settings, theme and
  density, sort/filter choices, selected thread IDs, unsent drafts, and audio handoff bookkeeping;
- downloaded/generated playback media in the app's local cache; and
- text copied to the system clipboard at the user's request.

Unsent drafts currently stay in AsyncStorage. Once sent, their text becomes chat/search content in
the server inventory below.

### Server-side storage map

| Store | Data | Current retention | Account-deletion state |
|---|---|---|---|
| Supabase Auth | Identity/provider metadata, login credentials/session machinery | Provider-managed; exact retention must be verified | Deleted last by the durable coordinator; staging verification still requires H23 |
| Postgres `rc_users` | Verified Supabase UUID, email, creation time | Until completed account deletion | Deleted only after owned filesystem data and attribution rows are purged |
| Postgres `rc_projects` / `rc_project_trash` | Project ID, live owner UUID, transition former-owner UUID, concrete trash-directory name and owner UUID, creation/adoption/deletion timestamps | Live row plus permanent ID tombstone after project deletion; exact trash entry retained until permanent purge | Account deletion removes every owner link and trash row but retains content-free project-ID tombstones as anti-ABA/security records |
| Postgres `rc_user_settings` | Model, voice, speech, and prior-notes preferences | Until cleared/account deletion | Removed transactionally with the parent `rc_users` row |
| Project git repository | Project metadata, reading list, cached corpus/full text, session transcripts, approved notes/synthesis, and their git history | Indefinite until deletion | Active and attributed trashed repositories are permanently removed by the coordinator |
| Project `.state/` | Session index, discovery results, graph/metadata caches, usage totals, covers, figures, branches/drafts, and transient job state | Indefinite/rebuildable; no general TTL | Removed only when the containing project is permanently removed |
| `PROJECTS_ROOT/.trash/` | Recoverable full project directories after ordinary project deletion | Indefinite until account deletion; no separate TTL yet | Exact attributed entries are permanently removed by account deletion. Ambiguous legacy entries still require explicit per-directory mapping |
| `.app-state/users/<user-hash>/` | Per-user narration text/cache and generated MP3 files | Until account deletion; no separate eviction yet | Removed recursively by account deletion |
| `.app-state/` global files | Operator keys/settings, prompt state, unattributed legacy usage/audio | Indefinite/operator managed | Not safely attributable to one account; production must not put signed-in user work here |
| In-process `JobRegistry` dictionaries | Running and retained terminal job payloads, including generated responses, proposed notes, narration, and segment text | Bounded by count/scope, not age; survives until eviction or process restart | Deletion closes admission, cancels cooperative workers, waits for actual thread/orphan liveness, then purges every owned project and `user:<user-hash>` payload |
| Backend/Fly logs | Request paths/statuses, project IDs/slugs, model and operation names, job IDs, timings, sanitized error classes/statuses, and a rate-limited raw UUID for allowlist rejection. Commit lifecycle lines contain only slug/revision as of 2026-07-28; older logs may contain full human/LLM summaries with private research content. As of 2026-07-28, OpenRouter, OpenAI speech, Firecrawl, Parallel, and DuckDuckGo response bodies and exception messages are excluded from new operational logs and job-facing errors. Protected mobile media now uses authorization headers. A temporary old-client fallback still accepts query tokens only on cover/figure GETs and removes them from this app's access-log scope, but an upstream proxy can observe the original target; pre-fix staging logs may also contain expired Supabase JWTs | Not configured in this repository | **Launch blocker:** retire the compatibility fallback after the mobile rollout, audit historical log exposure, then confirm retention and deletion capability with the hosting setup |

Project repositories are currently flat under `PROJECTS_ROOT/<pid>` and protected by mandatory
Postgres ownership checks. They are not filesystem-namespaced by user. Access isolation is
implemented, but account deletion must enumerate ownership before removing paths.

Ordinary project deletion is intentionally recoverable: it moves the entire repository to
`.trash`, clears the live authorization owner, and records the exact destination directory and
former owner in `rc_project_trash`. That table never grants project access; it exists so account
deletion can enumerate concrete repository incarnations even when a pre-tombstone project ID was
later reused. A database trigger preserves the former owner if an old worker runs its pre-migration
release statement during deployment. `scripts/adopt_projects.py` binds that transition owner only
when exactly one matching directory exists; ambiguous older entries require an explicit repeated
`--trash-owner <directory>=<owner-uuid>` mapping and are never bulk-assigned to `RC_ADOPT_OWNER`.
The M2.5 backend coordinator uses `rc_account_deletions` as both a retry ledger and a durable
admission tombstone. It retains only a 128-bit subject pseudonym plus timestamps after completion;
the raw Supabase UUID is cleared. Project-ID rows survive with no owner or content link because
reusing an ID creates an authorization ABA: an already-authorized request carries the ID string,
not an incarnation. These rows are therefore security reservations, not retained reading data.
Each database-backed process holds a deployment-namespaced shared Postgres advisory lock for its
lifetime (`RC_DEPLOY_GUARD_ID` keeps production and staging independent even on one cluster). A
destructive attempt releases its own shared lock and acquires the exclusive form, proving that a
retiring feature-aware process actually disconnected instead of guessing when Fly began its kill
timer. Both lock acquisition and every established-session heartbeat have deadlines: a stuck peer
turns the attempt into a durable retryable error, while a lost shared or exclusive session drains
job admission and terminates the process. The exclusive lease is heartbeated throughout deletion
and synchronously revalidated before each destructive boundary.
It then also waits the configured 310-second deployment-overlap window (greater than the
300-second `kill_timeout`) for first-rollout or connection-loss safety. The surviving process's
request and worker registries provide the fine-grained drain, and global job admission stays
paused throughout. A bounded five-second durable rescan picks up requests persisted after a rolling
replacement's one-time startup scan and retries failed attempts with bounded exponential backoff.
Transition-only former ownership from a pre-index worker is reconciled only when one concrete
trash incarnation is attributable; ambiguity fails closed. A filesystem provisional-owner marker,
written before a new/imported/split repository is published and removed only after its DB claim,
keeps claim-failure content attributable to account deletion even if compensating removal fails.
Initial deletion authorization uses a recent signed Supabase `amr` user-presence timestamp, not JWT
`iat`, because automatic token refresh can mint a new access token without reauthentication.
The mobile app now provides exact typed confirmation, requires a fresh Supabase user-presence
event, persists a non-identifying local intent before the first request, resumes durable progress
after restart, and clears account-linked device state plus protected image caches even if Auth
identity removal makes later session restoration impossible. Durable retries do not require a
second reauthentication after the destructive decision was already authorized. The remaining
user-facing work is the public web request path, H23 configuration, and disposable-account staging
verification.

Usage is currently a per-project `.state/usage.json` aggregate, not a Postgres event table. It
records operation, model, tokens, cost, timestamps, and pending OpenRouter generation IDs. M3 will
change this inventory when it introduces durable per-user reservations/events.

### External recipients and payloads

Every row below is a data processor/service integration to review. “No sharing” in Play is
available only if the transfer qualifies for Google's service-provider or user-initiated
exception and the actual provider terms/configuration support that classification.

| Recipient | Payload from this product | Purpose | Code seam |
|---|---|---|---|
| Fly.io | All API traffic and persisted application volume; request metadata/logs | Hosting | deployment/runtime |
| Supabase Auth | Email, OAuth identity response, session/auth metadata | Account management and authentication | `mobile/src/auth/`, `app/auth.py` |
| Supabase Postgres | UUID, email, ownership rows, user preferences | Tenancy and settings | `app/db.py`, `app/tenancy.py`, `app/user_settings.py` |
| Google Identity | OAuth sign-in request and Google account interaction | User-initiated authentication | Supabase Google provider |
| OpenRouter and dynamically eligible inference endpoints | Operator API credential; system prompts, user prompts, paper text/metadata, existing transcript, notes/synthesis, tool results, requested model | Authentication; analysis, discovery, graph extraction, narration adaptation | `app/llm.py`, `app/agent_harness.py` |
| OpenAI | Operator API credential; generated narration text, selected TTS model/voice/instructions | Authentication; text-to-speech | `app/tts.py` |
| Firecrawl | Operator API credential; research objective/search query, or requested public URLs | Authentication; web search and extraction | `app/research_tools.py` |
| Parallel Search | Operator API credential; research objective, search queries, requested URLs, random process session ID | Authentication; web search and extraction | `app/research_tools.py` |
| DuckDuckGo | Search query | Keyless search fallback | `app/research_tools.py` |
| Semantic Scholar | Optional operator API credential; paper title/arXiv/DOI/S2 identifier | Authentication; scholarly metadata, citation matching | `app/semantic_scholar.py`, `app/citations.py` |
| OpenAlex | arXiv/DOI plus operator contact in User-Agent when configured | Author/affiliation metadata | `app/openalex.py` |
| arXiv/ar5iv and user-selected public hosts | Paper identifier or requested public URL; standard request metadata | Retrieve paper text, HTML, figures, or PDF | `app/retriever.py`, `app/figures.py`, `app/safe_fetch.py` |

OpenRouter is not only an API endpoint. The current clients send a model ID but no `provider`
routing constraint, so OpenRouter may choose among endpoints eligible to serve that model; the
provider-like prefix in a model ID does not prove which organization receives the payload. Before
submission, either pin an approved endpoint-routing policy or enumerate and review every endpoint
OpenRouter can select for every allowed model. The provider actually serving the call belongs in
the privacy-policy processor list and contract review.

Provider failures are reduced to operationally useful metadata—provider, model, HTTP status,
attempt count, and exception class—before they reach logs or user/job error surfaces. Raw response
bodies and exception messages from OpenRouter, OpenAI speech, Firecrawl, Parallel, and
DuckDuckGo are excluded because they can echo prompts or paper text. Historical staging logs from
before 2026-07-28 still require audit under the log-retention launch check.

## Google Play Data Safety draft

### Top-level answers

| Question | Current truthful answer | Submission target / blocker |
|---|---|---|
| Does the app collect or share any required user data types? | **Yes** | Stable |
| Is all collected data encrypted in transit? | **Do not answer Yes for the current source build.** `mobile/app.json` still permits cleartext and defaults to an `http://` Tailscale address. The tailnet encrypts transport below HTTP, but the Play artifact must use the production HTTPS origin and remove unnecessary cleartext support before this claim is made. Separately, `safe_fetch` permits user-supplied and agent-selected `http://` source/PDF URLs, so research URLs and requests can also leave the backend in plaintext. | Verify the exact AAB points only to HTTPS **and** require HTTPS for server-side user/agent source fetches (or retain a No answer); exercise every collection path |
| Can users request data deletion? | **No, not yet** | Implement authenticated in-app account deletion plus a public web request path; verify deletion end to end |
| Is data shared with third parties? | **Unresolved.** The app transfers content to several providers, but Play exempts qualifying service providers and some user-initiated transfers from “sharing.” | Review the current contracts/terms and configurations for every recipient above; answer per data type, not by assumption |
| Is data sold or used for advertising/marketing? | **No in product code** | Confirm provider terms do not permit sale/cross-customer advertising use |

### Data types

The selections below are deliberately conservative. “Collected” includes server retention and
server-to-server processing after data came from the app. Required/optional follows Google's rule:
optional is valid only when every user can use the app without providing that data type.

| Play category / type | Select? | Required? | Purposes | Sharing answer |
|---|---|---|---|---|
| Personal info — Email address | **Yes** | Required | Account management; app functionality | Pending processor review |
| Personal info — User IDs | **Yes** | Required | Account management; app functionality; fraud/security for allowlisting and isolation | Pending processor review |
| Personal info — Name | **Verify** | Likely required if Google/Supabase stores profile name | Account management | Inspect production OAuth scopes and a live Supabase auth record |
| Messages — Other in-app messages | **Yes** | Optional | App functionality; personalization of the selected research thread | Pending OpenRouter/upstream-provider review |
| Files and docs — Files and docs | **Yes** | Optional | App functionality | Pending hosting/extraction-provider review; public scholarly retrieval alone is not a user file, but explicit PDF upload is |
| App activity — In-app search history | **Yes** | Optional | App functionality; personalization of research results | Pending search/scholarly-provider review |
| App activity — Other user-generated content | **Yes** | **Required** | App functionality; personalization | The current workflow requires a non-empty project name before research can begin; this row also covers optional notes, synthesis edits, and open-ended paper metadata not classified as messages/search/files. Pending provider review |
| App activity — App interactions | **Yes** | Required/automatic | App functionality; cost accounting; fraud/security and future quota enforcement | Pending hosting/provider review |
| App info and performance — Diagnostics | **Likely no today** | — | — | The mobile app sends no crash, stack, device-performance, or telemetry payload. Revisit when observability/crash reporting lands |
| Location — Approximate location | **No based on product code; verify processors** | — | — | The app does not infer location from IP. Confirm hosting/auth/SDK configurations do not do so for this app |
| Device or other IDs — Device or other IDs | **No based on product code; verify SDKs** | — | — | No advertising, installation, or persistent device ID is read by app code |
| Audio files — Other audio files | **No** | — | — | Narration is generated output downloaded to the user, not user-provided audio collected by the app |
| Web browsing — Web browsing history | **No** | — | — | A user may submit one source URL, but the app does not collect browser history or sites visited |
| Financial info / Purchase history | **No for M2.5** | — | — | Revisit with RevenueCat/Play Billing in M4–M5 |

Do not import this table blindly into Play Console. The final declaration describes the sum of all
versions still distributed on Play, and the exact artifact's SDK graph and runtime configuration
take precedence over this source review.

## Retention and deletion requirements

No externally publishable retention promise is supportable yet. The current technical behavior is
“retain until the user/project is deleted”; ordinary project deletion is recoverable indefinitely,
while durable account deletion permanently removes attributed application data. Log, Fly
snapshot/backup, Supabase Auth, and provider retention still need explicit answers and staging
deletion cannot be verified until H23 is configured.

The account-deletion implementation is complete only when one idempotent workflow:

1. re-authenticates or otherwise verifies the signed-in account;
2. prevents new requests/jobs and drains or terminates all of that user's active work;
3. snapshots the complete set of active and previously trashed projects belonging to the user;
4. permanently removes those git repositories, git history, project `.state/`, covers, figures,
   uploaded-PDF-derived text/assets, transcripts, notes, discovery state, and usage records;
5. purges retained terminal job payloads for every owned project and the user's
   `user:<user-hash>` audio-job scope, after the corresponding running jobs have stopped;
6. removes `.app-state/users/<user-hash>/` narration/audio;
7. removes per-user Postgres settings and ownership, retaining only explicitly documented legal
   or anti-abuse records;
8. revokes/deletes the Supabase Auth identity only after application-data deletion has succeeded,
   or records a durable retryable deletion request if ordering fails;
9. clears the device session and local account-linked caches;
10. is safe to retry after a crash at every step; and
11. produces an operator-auditable result without logging deleted content or credentials.

The external deletion page must identify Paradigm, accept or initiate a deletion request without
requiring app installation, explain any identity-verification step, and link to the same retention
rules as the privacy policy.

## Blocking checks before policy drafting/submission

- [x] Preserve exact, non-authorizing former-owner attribution for recoverable `.trash` entries;
      ambiguous legacy directories require explicit per-entry mappings.
- [x] Add a retry-safe backend account-deletion path that includes active and existing attributed
      trashed projects; the in-app and public request surfaces remain.
- [x] Decide whether project-ID tombstones survive account deletion and document why they are
      non-content anti-ABA/security records.
- [x] Implement and test a narrow server-only Supabase Auth deletion client; the coordinator still
      must call it, and H23 must supply the secret directly to each Fly environment before
      end-to-end verification.
- [x] Add one atomic user-deletion admission gate plus explicit running/terminal job cleanup for
      all owned project scopes and the hashed per-user audio scope.
- [x] Add an authenticated in-app deletion path with recent-session refresh, exact confirmation,
      restart-safe polling/retry, and account-linked local cache/session cleanup.
- [ ] Define and verify Fly volume snapshot/backup retention and deletion behavior.
- [ ] Finish removing reusable bearer tokens from media query strings: protected mobile images
      use `Authorization` and per-user cache keys, and audio already uses headers. After the
      updated mobile release is no longer distributed/supported, remove the narrowly scoped
      old-client cover/figure query-token fallback.
- [x] Stop writing human/LLM commit-summary content to new operational log lines; retain only the
      project-scoped slug and git revision needed to locate the approved record.
- [ ] Audit historical staging logs and rotate any still-live credential found there; define log
      destination, retention, access, and deletion behavior.
- [x] Sanitize provider error bodies before logging or returning job-facing errors; retain only
      provider/model/status/attempt/error-class diagnostics.
- [ ] Confirm Google OAuth scopes and which identity fields Supabase retains.
- [ ] Review current data-processing/retention/training terms and configuration for Fly, Supabase,
      OpenRouter plus every inference endpoint eligible for every allowed model, OpenAI,
      Firecrawl, Parallel, DuckDuckGo, Semantic Scholar, OpenAlex, arXiv, and ar5iv.
- [ ] Point the release AAB exclusively at the production HTTPS origin; remove unneeded Android
      cleartext support, require HTTPS for server-side user/agent-selected source fetches, and
      verify the merged manifest/runtime configuration.
- [ ] Implement an in-app offensive-AI-content report action and durable report store.
- [ ] Implement in-app privacy and terms links plus the public deletion page. The in-app
      account-deletion path is implemented.
- [ ] Add the M3 usage-event/reservation and M4–M5 billing changes to this inventory before their
      releases reach Play.
- [ ] Have the developer approve the privacy policy/terms and make the final Play Console
      attestations (H11/H13).

## Maintenance rule

Update this document in the same PR whenever any of these change:

- an Android permission, native module, SDK, analytics/crash tool, or API base URL;
- an authentication provider or OAuth scope;
- a persisted file/table/cache/log field or retention rule;
- a new outbound hostname, model provider, or data payload;
- account deletion, backup, or log handling;
- metering, subscription, billing, advertising, personalization, or content reporting; or
- any version distributed on Play whose behavior expands the global declaration.
