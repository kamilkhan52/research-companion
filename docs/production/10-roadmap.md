# Production launch roadmap

*Written 2026-07-24 against `origin/main` @ `e5fe869`. Evidence base: `00-current-state-audit.md`.
This is the execution ledger — update the Status column as milestones land, same convention as
`docs/product-roadmap.md` and `docs/round12-queue.md`.*

**Workflow per milestone:** branch → Opus implements → codex CLI review (GPT 5.6 Sol, high
reasoning) in `/loop` → fix findings → PR → merge. Milestones that change external billing
configuration, the production database, or store configuration need explicit human approval
before execution.

---

## Current position (updated 2026-08-05, after landing the Discovery and M3 stacks)

**M1 is complete and production is LIVE, running Kamil's real corpus.**
`https://research-companion.fly.dev` in `sjc`: volume attached, database connected, all six
migrations applied, tenancy lockout verified against the live schema (7 `rc_*` tables, RLS on, 0
policies, 0 `anon`/`authenticated` grants), two accounts allowlisted, five of his projects imported
with full git history, and his own prompt overrides and model picks in place. H26/H27/H28 are all
closed.

**M2.5 is code-complete and the app is in continuous production-device review.** What gates the
AAB is Kamil's sign-off plus H13, followed by the first production-profile build. Uploading before
there are testers does not bank closed-test time and prematurely freezes the Android package name.

**Main is at PR #323, and nothing is open.** Fifteen reviewed PRs had accumulated unmerged since
2026-08-01 in two independent stacks; both landed on 2026-08-05. Discovery: **#310** cooperative
Stop, **#311** slice 2, **#324** the device-review ledger. M3: **#312**–**#323** — exact-cost
metering for the agentic and speech paths, the retirement of the legacy blocking paid routes,
per-user usage events, durable reservations with quota-gated job admission, an emergency
provider-spend stop, audio-cache eviction, prompt-injection framing with bounded tool egress, and
price-sorted OpenRouter routing. Every one carried a clean GPT-5.6 Terra review before merge.

**Two migrations ship with this: `0007_usage_events` and `0008_usage_reservations`** — three new
tables, their indexes, and two state-transition guard triggers. Purely additive, no drops; `main`
applies them on boot.

**Merging the stacks was not mechanical, and the reason matters for the next one.** Parents were
squash-merged, so a parent's commits are never ancestors of `main`; git then falls back to a stale
merge base and re-conflicts the parent's whole new files even though the child already contains
them. The safe resolution was to keep the child's side and then require the result to be
byte-identical to that branch's own pre-merge version — if it is not, `main` genuinely changed the
file and a human has to read it. Two conflicts were real rather than artefacts: **#314** retires
`/api/speak` while **#313** was still editing it (the deletion looks exactly like an empty
conflict side), and **#317** deliberately makes dispatch completion independent of cost
resolution, which reads as a regression against **#316** until you check its tests. One test —
#313's `/api/speak` billing case — merged *cleanly* and only failed in CI, because #314's branch
never saw it; its guarantee survives on the job path.

**Immediate handoff:**

1. Continuous device feedback is reconciled in
   [`../device-review-ledger.md`](../device-review-ledger.md); that ledger distinguishes genuinely
   open work from merged behavior that only needs device acceptance. Landing these stacks did not
   close a single row there — merging is not acceptance.
2. Discovery slice 2 is merged but **unmeasured**: run one cold and one incremental production
   search and record reservoir size, elapsed time, spend, resume behavior, and result quality. The
   durable plan is `~/.claude/plans/keen-finding-rabin.md`.
3. Discovery slice 3 adds the comparative reading path and its client surface after slice 2's
   reservoir is measured. Quick mode remains explicitly deferred until the optimized default has
   enough real timing/quality evidence to set a meaningful target.
4. M3's mechanism is now in place; what remains is **enforcement in production** — per-turn model
   limits and the tier/quota values themselves — before twelve testers spend against shared
   provider credentials.

### Earlier production-bring-up handoff (historical, retained for rationale)

Merged this session, in order: **#274** deploy findings · **#275** duplicate-signup dead end ·
**#276** default prior-notes scope · **#277** actionable empty-response error · **#278** stale
server-URL copy · **#279** CI off Node 20 · **#280** provider-chain defects · **#281** DeepSeek
default models · **#282** the "paper summary" rename · **#283** sign-in screen cleanup.
**#284** (Library empty states) was open and in CI at hand-off.

**The device-pass queue is CODE-COMPLETE** — items 1–5 shipped as **#286** (paper-summary card +
equation legibility), **#287** (cue cap + unchanged-progress + no ASCII art) and **#288**
(progressive-narration coverage). What each turned out to be, because in three of the five the
reported symptom had a different cause than the wording suggested:

1. **Paper-summary card** — the "no avatar" and "pinned to top" halves needed *no work*
   (`renderAvatar` is already null globally, and the summary is the topmost row in an inverted
   list). The real work was `isPaperSummaryTurn` having to check thread AND slug, not just index:
   every side thread has its own `assistant_index` 0, and so does the `_review` pseudo-session.
2. **Equations** — the horizontal scroll strip already existed. The defect was the *threshold*:
   `fitMathBlock`'s legibility floor of `0.6` shrank anything up to 1.67x the column to ~10px
   before it would scroll. Now `0.9`.
3. **Listening cues** — the prompt already forbade restating progress and it did not work, because
   a model handed a concrete count will use it. Unchanged progress is now WITHHELD from the
   payload. The cap had to be shared by both producers (`chat_jobs._maybe_start_preview` during
   analysis, the coordinator after); capping only the coordinator was no cap at all.
4. **No ASCII art** — in `self_contained_research`, the block both analysis and narration compose,
   because a reading-only rule still reaches the ear.
5. **Progressive narration** — **half done, and the remaining half is Kamil's.** The code was
   already correct; #288 pins the two paths a device pass would misread as breakage (a cached job
   exposing 0-of-N segments must fall through to the stitched track; a synthesis failure after
   segments already played must surface rather than settle silently, and must drop its handoff
   eligibility). **The default is deliberately still `full`** — flipping it is gated on a real
   device pass against real synthesis latency.

**Correction worth carrying forward:** the `$0.0016/turn` figure for cue costs assumed *both* a
six-cue cap and a ~4K-token prompt. Kamil subsequently chose not to cap the cue count because cues
should continue until final audio is playable. The prompt-volume half is now stacked in review:
grounded sources have a finite 6K-character budget, live response a 2K share, recent cue history is
four entries, and project context rotates across later cues. Do not reuse `$0.0016/turn` as the
expected result; cadence remains uncapped by deliberate product choice.

**Open defect found 2026-07-29 after the production project copy: sharing a project loses all
reading *progress*, and any discussion that was never committed.** Kamil's production corpus showed
0 papers In Progress against 40 locally. Two independent causes, both in `projects.py`:

- `.state/sessions.json` is gitignored, so it never travels, and it is the *only* source of
  `Paper.session_state`. Every paper therefore reads as untouched and nothing groups as In Progress.
  Be precise about the blast radius here: an **already-committed transcript still travels in the
  bundle and is still reachable** — `hasStartedDiscussion` renders a thread whenever
  `transcriptLength > 0`, with no reference to session state — so for most papers the conversation
  survived and only its status was missing. It also carries each session's `opening` prompt and
  `threads` map, which is why a rebuild-from-transcripts shortcut cannot be faithful.
- `export_bundle` exports `HEAD` only, so the working tree does not travel at all — and invariant 4
  leaves a great deal uncommitted on purpose (`store.add_entry` does not commit, and retrieved
  `corpus/*.md` plus live `sessions/*.jsonl` wait for an approval). **This** is where content was
  genuinely lost: 6 in-progress papers arrived with no transcript at all, and `embedded-llms` came
  over as an empty skeleton with 0 reading-list entries because every file in it was uncommitted.

Production was repaired by hand and verified equal to local (same paper and in-progress counts on
all five projects, via the app's own `list_papers` inside the container); the same repair was needed
for staging on 2026-07-27, so this is the **second** occurrence.

**The designed fix, not yet built:** carry the working state as a second ref in the same bundle —
`git bundle create out HEAD refs/rc/working-state` — rather than adding an endpoint or a tar
upload. That reuses the whole existing trust boundary (`_reject_hostile_tree`, disabled
hooks/filters, the size caps) instead of reintroducing the untrusted-archive bug class that the
bundle choice deliberately avoided. It must be a **whitelist** — `.state/sessions.json`,
`.state/branches/`, untracked `corpus/`/`sessions/`, modified tracked files — never all of
`.state/`, which is 207 MB of one 214 MB project. Note `sessions.json` also stores each session's
`opening` prompt and `threads` map, so a rebuild-from-transcripts shortcut cannot be faithful.

**Known and deliberately not fixed**, so nobody rediscovers it as new: the Library's
"Continue reading" card is a `Pressable` with `IconButton`s nested inside it (dismiss, and the
pre-existing external-link button). TalkBack/VoiceOver can swallow nested accessible controls. It
predates #284 and wants one deliberate pass over the pattern rather than a per-button patch.

**The cheap cue-cost work is partially stacked.** The historical baseline remains **17.3 cues per
turn**, each sending ~11,373 prompt tokens to produce 86 — 4.4× the analysis turn's own prompt.
The repeated source/history payload is now bounded toward the ~4K-token target without reducing
spoken coverage. The other half — capping at six calls — is deliberately not planned because Kamil
prefers continued cues to silence while final audio is prepared. Measure the new prompt-token
distribution after deployment before projecting a new per-turn price.

**M2's backend is complete.** M1 was code-complete at #218–#224; M2 then landed in five slices:

| PR | Slice | Status |
|---|---|---|
| #235 | 1 — `db.py` (pool, migration runner, DSN validation) + `tenancy.py`, recording ownership only | ✅ merged (`38ac21d`) |
| #236 | 2a — enforcement: `use_project` refuses a foreign project, cross-project routes filtered, operator-only usage/covers | ✅ merged (`95d54c2`) |
| #237 | 3 — job isolation pinned by test; audio ownership decision recorded | ✅ merged (`47d1972`) |
| #238 | 4 — settings split into operator-owned vs per-user; 5 — audio scoped per user; the Data API lockout (P0-18) | ✅ merged (`db90e1e`); 10 Sol rounds, 15 findings |

**What M2 actually closed:** P0-1 (every user saw every project), P1-2 (unauthorized job endpoints,
audio included), the cross-user halves of P1-1 and P1-14 (audio as a read channel), and P0-18 — a
finding made *during* the work: the ownership tables were reachable from the published anon key,
with `rc_projects.owner_id` writable, which is a full takeover of another person's reading list.

**Staging M2 rollout completed 2026-07-27.** `RC_DATABASE_URL` uses the staging Supabase direct
connection, `RC_ADOPT_OWNER` matches the allowed/operator user, and the merged M2 code is deployed.
All six pre-tenancy projects were adopted under that owner; an immediate second run adopted zero
and reported all six already owned. The deployed schema has all four `rc_*` tables under RLS with
no `anon` or `authenticated` table grants, and unauthenticated `/api/projects` returns 401.

The rollout found and fixed a production-image gap: `app.db` resolves migrations from
`/srv/supabase/migrations`, and the runbook invokes `/srv/scripts/adopt_projects.py`, but the image
contained neither. Commit `7fa07ba` adds both runtime payloads and a source-level packaging
regression test. Without it, a database-configured machine health-checked successfully while
running against an empty schema.

**Next production gate:** M2.5's account deletion is now cheap on the backend side — a user's audio
and narration cache is one directory. Recoverable project trash now retains an exact,
non-authorizing directory-to-owner link; a transition trigger protects old-worker deletes and the
adoption script repairs only unambiguous or explicitly mapped legacy trash. The remaining
project-content work is now implemented by a durable, retry-safe coordinator: it closes request
and job admission, drains actual worker threads, permanently removes active/trash/user-cache data,
retains only content-free project-ID and subject tombstones, and deletes Supabase Auth last.
The mobile path now adds a recent signed Supabase user-presence event for initial authorization
(never an automatic token refresh), exact typed confirmation, durable progress/retry after restart,
a local recovery intent for post-Auth cleanup, and fail-closed account-linked device/cache cleanup.
The backend also ages every destructive attempt past Fly's rolling-deploy kill window. The gate now
moves to the public web request surface, H23 server-secret configuration, and a disposable-account
staging deletion test.

**The account-deletion stack merged 2026-07-28** as #251 → #252 → #253, plus #257 for review
follow-ups. The mobile half (#254) is the only piece still open.

| PR | Scope | Status |
|---|---|---|
| #251 | `supabase_admin.py` — server-only Auth identity deletion, redirect-refusing, sanitized errors | ✅ merged (`6d33920`) |
| #252 | `jobs.py` — a cancelled worker stays visible to a deletion drain until its thread really exits | ✅ merged (`25abcff`) |
| #253 | `account_deletion.py` + `deploy_guard.py` — the durable coordinator and cross-process exclusion | ✅ merged (`787c3d2`) |
| #257 | Three tests from #253's review that were weaker than they read | ✅ merged |
| #254 | The Expo client: start deletion, follow it, purge local state | ✅ merged (`8456045`) |

**M2.5's account deletion is code-complete and deployed to staging (version 17, 2026-07-28).**
Migrations `0004` and `0005` applied on boot, the Data API lockout re-asserted on 6/6 tables, and
`/api/account/deletion` is in the deployed OpenAPI. What remains before the deletion path can be
exercised end to end is **H23**: `RC_SUPABASE_SECRET_KEY` is not set on staging, so
`supabase_admin.configured()` is False and `request()` refuses before writing a tombstone. That
refusal is itself a designed, testable path — the client clears its local marker and reports it —
but the identity-deletion step cannot run until Kamil sets the key.

**The mobile review found two P0s, and neither was about deleting an account.** Both were in
`AccountDeletionGuard`'s render conditions and affected *every signed-in user*:

1. `refetchInterval` returns 30s whenever there is no deletion, and the loading condition included
   `query.isFetching && !deletion` — true on exactly those polls. Rendering a different element
   unmounts `children`, and everything under `AuthGate` is provider state, so the router stack
   reset to the root route, drafts and open sheets were destroyed, and `AudioProvider`'s mount
   effect paused playback. Every 30 seconds, for the life of the session.
2. `retry: false` plus an unconditional `query.isError` meant one dropped packet replaced the app
   with an error card, and a cold start offline made the client unusable.

Both are the same mistake in two places: treating a *revalidation* as a *first load*. Fail-closed
on first load is deliberate and kept; applying it to a later poll, while holding a good answer from
seconds ago and with the backend 423ing every other route once a tombstone exists, is not the same
thing. Worth carrying forward — the guard pattern will recur for quota and subscription state.

Three more from that round, each fixed: a pre-persistence 503 could be misread as ambiguous because
the route returned `str(exc)` for a class with two messages (now one stable detail, logged
specifically, so the client's match is complete *by construction*); a device that did not initiate
the deletion never wrote the marker its own fail-closed retry depends on; and the cross-user
isolation test stayed green under a shared query key. A terminal "your account was deleted"
acknowledgement was added on Kamil's call — persisted, because the completion path ends in a
sign-out that unmounts the tree that would have held it.

**Reviews for this stack ran as Claude subagents, not Codex.** The Codex account hit its usage limit
on 2026-07-28 (resets Aug 3) and Kamil disabled automatic Codex PR review the same day. Cold
subagents pointed at `AGENTS.md` and this ledger found: nothing at P0/P1 on #251/#252, and **four
P1s on #253**, all in the guard and admission plumbing rather than in the deletion ordering. Worth
recording because three of them share one shape — *a single failure treated as proof*:

1. `deploy_guard.start()` was an unguarded module-scope call, so an unreachable database made
   `import app.main` raise and the machine never served. Reproduced against a closed port. It was
   strictly more fatal than the migrations twelve lines below it, whose docstring already gives the
   rule. Its ten-minute default budget was the other half: a peer holding the exclusive lock is
   exactly the case the feature exists for, so a replacement machine would hang its whole import.
2. The lifetime watchdog, `acquire_exclusive`'s cleanup, and `release_exclusive` each SIGTERM'd the
   process on one failed round trip. A two-second database blip during one "delete account" tap
   would restart the instance and kill every in-flight job. Losing the exclusive race did it too,
   by construction — the restore asks for a *shared* lock, incompatible with the exclusive one a
   peer legitimately still holds.
3. `is_blocked` — synchronous psycopg — ran on the event loop in the auth middleware, serializing
   all request handling behind two round trips per authenticated request, and converting a slow
   database into a total stall rather than the per-request 503 it was written to give.

Fail-stop is kept, but it now has to be *earned*: `_recover_shared` tries to re-take the lock within
30s and that attempt is itself the test — a blip recovers, a peer genuinely holding exclusivity
keeps failing `pg_try_advisory_lock_shared` and the process still terminates. The budget stays well
under the 310s overlap window a deleter already waits for exactly this reason.

### Next steps, in order (revised 2026-07-28, after the device pass)

Done since the last revision, so nobody re-does them: ~~H23~~ (`RC_SUPABASE_SECRET_KEY` is set on
staging), ~~the device pass~~, ~~a real account deletion end to end~~ (Kamil deleted a throwaway
email account on staging and it ran to completion), ~~the stalled-deletion operator signal~~ (#262),
and ~~the in-app AI-content report action~~ (#263 backend, #264 client).

Also done since: ~~the allowlist trim~~ (Kamil confirmed the variables are correct on 2026-07-28),
and ~~the legal surface~~ — privacy policy, terms and the public deletion page are served at
`/legal/*`, linked from Settings, and the privacy policy's central claim is now enforced in code
(see `llm.PRIVACY_ROUTING` below).

1. ~~**Approve the policy text**~~ — **APPROVED 2026-07-29**, with governing law corrected to
   California. H11 is closed.
2. ~~**Buy a domain and configure custom SMTP**~~ — **DONE 2026-07-29.** `scholiast.io` on
   Cloudflare, Resend verified, DMARC published, production Supabase wired to it. This was found
   only because Kamil mentioned in passing that his magic links land in junk: Supabase's built-in
   mail service delivers ONLY to project team members, so the 12 testers could not have received
   anything at all. It would have surfaced the day he invited people, after the AAB and the store
   setup. **The lesson worth keeping: a user's throwaway remark about their own experience is
   worth chasing to its cause.** Details in H25.
3. ~~**Rebrand to Scholiast**~~ — **SHIPPED 2026-07-29 (#272)**, including the package name while
   it was still changeable. One thing remains and it is Kamil's: **H27**, adding `scholiast://auth`
   to Supabase Redirect URLs on both projects, keeping the old scheme until no old build is
   installed. Without it, sign-in silently does nothing on a new build. Original entry:
   Decided 2026-07-29: the app becomes **Scholiast** (a scholiast is the ancient commentator who
   wrote explanatory notes in the margins of manuscripts — what this app does), on **`scholiast.io`**,
   which is both the sending domain for auth email and eventually the web app's origin.

   *Why the ordering is not negotiable:* `mobile/app.json` currently declares
   `"package": "com.kamilkhan.researchcompanion"`. **An Android package name is permanent once
   published** — a different package is a different Play listing, with new reviews, new installs,
   and a fresh 12-tester clock. Nothing is published yet, so it is free to change today and frozen
   forever after the first closed-track upload. Change it to **`io.scholiast.app`** (reverse-DNS of
   a domain we own) in the same PR. `"scheme": "researchcompanion"` should go too — it is the
   deep-link scheme auth redirects return on, changeable later but only in lockstep with Supabase's
   redirect allowlist, so it is far cheaper now.

   Surface: 22 files, but only four user-visible strings — `legal.APP_NAME`, `app.json`'s `name`,
   and `RC_APP_TITLE` in both Fly configs. The rest is documentation.

   *Name selection, so it is not re-litigated:* "Paradigm" is commercially crowded and
   `paradigm.ai` / `getparadigm.com` / `useparadigm.com` are taken. "Scholia" was preferred but
   `.com/.io/.ai/.app/.dev` are all taken AND an established Wikidata-based scholarly-profile tool
   already uses that exact name in this exact field. "Scholiar" reads as a misspelling of scholar.
   Scholiast is a real word meaning precisely the right thing; `scholiast.com`, `.app`, `.ai`,
   `.net`, `.org`, `.co`, `thescholiast.com`, `scholiasts.com` and `getscholiast.com` are all taken
   (checked against Verisign directly — an RDAP check wrongly reported one of these available), so
   `.io` is the only clean option. Accepted risk: `.io` is the BIOT ccTLD and the UK–Mauritius
   treaty would dissolve that territory, but the treaty stalled in early 2026 and ICANN's policy
   gives a five-year phase-out. There is no `scholiast` `.com` to hold as a fallback.

4. ~~**The production Fly app + secrets**~~ (the M1 remainder) — **DEPLOYED 2026-07-29**, and the
   production origin now exists: **`https://research-companion.fly.dev`** (machine in `sjc`, volume
   `rc_data` attached, 512 MB swap live, health check passing). Verified from outside: `/legal/*`
   public and branded Scholiast, every `/api/*` route rejecting unauthenticated callers,
   `/api/auth/config` pointing at the **production** Supabase project `aumedoefxacycwfrlcml` rather
   than staging's, and the SPA serving with `<title>Scholiast</title>`.

   The database is connected: all six migrations applied, and the P0-18 lockout verified directly
   against `pg_class` and `information_schema.role_table_grants` rather than from the log line —
   7 `rc_*` tables, RLS on all of them, 0 policies, 0 `anon`/`authenticated` grants.

   Getting there cost one round trip (H28): the production Postgres password contained a literal
   `@`, and `urlsplit` splits the authority on the LAST `@` while libpq splits on the FIRST, so the
   two disagreed about the host. `app/db.py`'s ambiguity guard caught it at boot and kept serving
   rather than crash-looping. Worth keeping because it is a property of the URL *format*, not a
   typo: any generated password containing `@` reproduces it.

   H27 is done, and so is the allowlist bootstrap: two production accounts are allowlisted, one of
   them deliberately non-operator so the operator-only routes get exercised from a tester's side.
   M1 is closed.

   **Bootstrapping it surfaced a real client bug, now fixed.** Signing up with an address that
   already has an account left the user on "Check your inbox" waiting for mail that was never sent.
   Supabase does not error on a duplicate address — it returns an obfuscated user with an empty
   `identities` array and sends nothing, so as not to confirm to a stranger that the address is
   registered. The client read "no session" as "confirmation pending". A tester who signed up
   twice, or who used Google first and email second, would have hit a dead end with no way
   forward and nothing in any log to explain it.

   Two things generalise. First, **an auth provider's silent-success path is a failure mode**: the
   only signals were an absent Resend send and an empty array in a response body. Second, the fix
   surfaces the duplicate to the user, which nominally defeats Supabase's anti-enumeration — but
   the empty array is already in the response, so anyone able to call `signUp` can read it.
   Withholding it in the UI protects nobody and costs a real user their only route in.
5. **Data safety answers in Play Console** (Kamil, H13). `02-security-and-privacy.md` holds the
   code-derived inventory they must match, and the policy now published must match both.
6. **Then the AAB and the closed track** — one production-profile EAS build with `app.json` pointing
   at that origin and cleartext removed, which is the last piece of "encrypted in transit".

   **Correction, 2026-07-29 — earlier revisions of this file overstated the urgency of this step,
   and the plan was ordered around the overstatement.** They said the AAB "starts the 12-tester /
   14-continuous-day clock" and that everything else was therefore on its critical path. Checked
   against Google's live requirement rather than repeated from memory: the rule is **12 testers who
   have each been opted in continuously for at least 14 days**, where "opted in" means the person
   opened the link, accepted, and installed from Play under that Google account. The clock is
   counted per tester and therefore effectively starts when the **twelfth** tester is in — not at
   upload.

   So **uploading an AAB with only Kamil on the track banks no clock time whatsoever.** It buys
   exactly one thing: permanently freezing `io.scholiast.app`. All cost, no benefit, taken early.
   What actually starts the clock is recruiting the twelve people (H16) — and they cannot sensibly
   be invited to something that has not passed its own author's sign-off.

   Practical consequence: **do the device-pass fix list and the cheap metering work first.** With
   no per-user cap, no TTS metering and no web-search metering (§8 of `20-pricing-analysis.md`),
   twelve testers read against Kamil's personal provider keys with nothing bounding the spend. The
   default models were pinned to DeepSeek in #281 for exactly this reason, which removes the worst
   of it; the stacked `listening_preview` prompt budget removes repeated context while preserving
   the deliberately uncapped cue cadence.
   Source: <https://support.google.com/googleplay/android-developer/answer/14151465>.

**On tester sequencing (Kamil's call, 2026-07-28):** he wants to test himself before involving
friends, which is right — a bad first impression from twelve people is expensive. The agreed shape
is to do that testing **on the closed track with himself as the only tester**, not on staging: an
install from Play exercises app signing, the production origin, and store distribution, none of
which staging touches. The 14-day clock is effectively gated on the twelfth tester opting in, so
being first on the track costs nothing and finds a real class of bug earlier.

Deferred deliberately, with the reasoning recorded where it belongs: the operator review queue for
content reports (M7 — `content_reports.pending_count()` is its seam), audio cache eviction, and
P0-17 (`DeliveryReq.model` bypassing settings, which is M3's tier check).

### R14 device-pass list — status 2026-07-30

Kamil's 2026-07-30 pass produced six items. **Five are shipped; only discovery remains**, and he
asked explicitly to stop before it so it can be designed properly rather than patched.

| # | Item | State |
|---|------|-------|
| 1 | Graph showed a raw `UnknownHostException` after a successful build, and a failed refresh blanked already-loaded data | Shipped — **device-confirmed** |
| 2 | Settings auto-save; keyboard hiding the Save button and the privacy/terms links | Shipped — **device-confirmed** |
| 3 | Paper context (affiliation, citations, relevance) on the reading-mode screen | Shipped — **device-confirmed** |
| 4 | "Fetch & start reading" progress as staged card rather than vanishing text | Shipped — **device-confirmed** |
| 5 | Graph label overlap; constant-size labels; nodes separating on zoom | Shipped — **device-confirmed** (#301) |
| 6 | **Discovery quality** — wants his `n8n_memory_research_agent` standard; open to Google Scholar / Semantic Scholar / OpenAlex | **Slice 1 shipped** (#306) — see below |

**Citation enrichment, which item 5 depended on, went 46% → 92% (186 → 369 of 402, verified after the review changes).** The cap was
not coverage of the indexes: `app/citations.py` requested `fields=...,matchScore` from Semantic
Scholar's `paper/search/match`, which rejects an unsupported field with `400 {"error":"Unrecognized
or unsupported fields: [matchScore]"}`. Every title lookup had been failing — and title lookup is
the only route for the ~190 nodes with no arXiv id or DOI. The loop handled 200/404/429 and let
everything else fall through, so a total failure was indistinguishable from "paper not in the
index". **PR #302, merged 2026-07-30.** A 4xx now logs and stops the step (it is systemic — our
request is wrong for every node); a 5xx skips that paper and continues.

Review (Sol) found five real defects in that PR, three introduced by the fix itself, and they are
worth carrying forward as constraints rather than history:

- **A title is not a paper identity.** Distinct publications share exact titles, so a title must
  clear a character *and* a word-count floor before it may stand in for one. Matters more now than
  before: the step went from always-400 to up to 400 successful lookups per build, so a wrong match
  is cached and never revisited.
- **Cleaning a title is only safe as a FALLBACK.** A trailing parenthetical can be part of the real
  title ("The Blessings of Multiple Causes: A Reply to Ogburn et al. (2019)"). The stored title is
  tried first; the cleaned form only when it finds nothing.
- **Word breaks are not ignored, deliberately.** Doing so recovers a hyphenation variant
  ("pretraining" / "Pre-training") but also equates "Resigning" with "Re-signing". A wrong count is
  undetectable downstream; a missing one is obvious. Tested so it is not re-relaxed.

**The citation cache lives under `citations` in `reference-graph.json`** (`app/graph.py:1254`), not
`citation_cache` — a stale sibling key that also appears in the document. Maintenance scripts that
target the wrong one appear to work and change nothing the app reads.

Two facts from that work that change planning assumptions:

- **OpenAlex is metered but NOT unaffordable — an earlier version of this entry said it was
  effectively dead, and that was wrong.** Re-verified live on 2026-07-30 (details and the corrected
  plan below).
- **Semantic Scholar with the key is not the constraint**: 0 of 120 requests were rate-limited, and
  84% of attempted title lookups verified. Discovery can lean on it.

#### Discovery rebuild — slice 1 shipped 2026-07-31 (PR #306)

The full design is `~/.claude/plans/keen-finding-rabin.md`, written from two independent agent
proposals (Opus and GPT-5.6-Sol) that converged on the same architecture. **Scope decisions Kamil
made: paper discovery only (gap mode deferred to its own plan), and user-triggered only (no
scheduler — that needs spend caps and collides with invariant 6).**

**The diagnosis was recall lost BEFORE any semantic judgment**, not bad ranking. `MAX_CANDIDATES =
50` capped the universe before an LLM saw anything, and `graph.score_recommendations`
(`app/graph.py:914`) — which already ranks every external paper the project cites, with reasons, on
every graph build — **was never read by Discovery at all.**

Slice 1 adds a funnel: forward-citation chase from the reader's own library + the graph's existing
recommendations + the existing lexical lane → a free deterministic gate → batched cheap title
triage → batched cheap abstract scoring → the existing ranked list. New modules
`app/discovery_{recall,gate,batch,ledger}.py`; `run_discovery` became the orchestrator.

**The grounded channels are ADDITIVE, not a replacement.** A literal reading of the plan would have
removed query-based recall, and a project with an empty library would then get nothing — which is
the case the feature was originally built for.

Measured on a real 53-paper project, cold cache, identical work both times:

| | before | after | |
|---|---|---|---|
| recall | 125s | 95s | |
| title triage | 707s | **87s** | 8.1x |
| abstract scoring | 878s | **166s** | 5.3x |
| authorships | 83s | **2.4s** | 35x |
| **total** | **1797s** | **418s** | **4.3x** |

Cost is **$0.0131** per run for 796 titles + 400 abstracts (measured through `usage.py`, operation
`discovery_screen`). The pre-parallel run also lost 2 of 6 title batches to `LLMError` and passed
300 papers through unjudged; the parallel run answered 799/799 and 400/400 with zero degraded.

`jobs.run_parallel` is the shared fan-out helper. **It rebinds the active project AND user
contextvars per worker (invariant 2)** — without that a parallelised stage attributes its token
spend to no project and falls back to instance defaults. Semantic Scholar is deliberately NOT
parallelised anywhere: it is paced account-wide and fanning out trades latency for 429s.

Two harness holes this work exposed, both now closed in `tests/conftest.py`:

- **The suite was making live, billed model calls.** `llm.complete` was never stubbed and the key
  is in the shell profile. `discovery._cheap_llm` now RAISES in tests rather than no-opping — the
  batch runner fails open by design, so a silent stub would let a screening test pass while
  screening nothing.
- **Tests wrote into the developer's working tree and read it back.** `config.project_dir()` falls
  back to `BASE_DIR / "project"` when no project is scoped, so redirecting `PROJECTS_ROOT` was not
  enough; a stale discovery ledger silently satisfied a screening stage and the failure looked like
  a bug in the code under test. `_LEGACY_PROJECT_DIR` is redirected too, and a test pins it shut.

**Next:** review and measure slice 2 (OpenAlex topic sweep + Semantic Scholar `search/bulk` + the
incremental frontier), then slice 3 (the comparative reading-path call and its client surface). A "Quick" mode
is wanted — Discover is the first thing a new user touches — but is deliberately deferred until the
optimised default has been used, so its targets can be set from real numbers rather than guesses.

#### Discovery rebuild — slice 2 implementation candidate 2026-07-31

Slice 2 adds the two graph-independent wide-recall lanes without replacing the lexical or
library-grounded lanes. One OpenAlex cursor sweep ORs the six strongest project topics under one
30-page total cap. Up to four broad Boolean Semantic Scholar `paper/search/bulk` lanes request
1,000 rows per paced page and 2,000 rows per query. The providers run alongside one another, but
Semantic Scholar pagination remains serialized behind its account-wide pacer.

Incrementality is crash-safe rather than merely cached. The discovery ledger now retains a compact
candidate reservoir, and provider frontier updates stay pending until the reservoir and completed
run are durable. A 24-hour per-project checkpoint snapshots the completed recall, gate, title
triage, and abstract-score stages; it is invalidated by goals, reading-list identity, or pipeline
version changes. Cancellation and provider failures do not advance a truncated frontier.

The title screen protects project-grounded candidates, source lanes, topic/concept groups, time
strata, FOUNDATION/SURVEY labels, and a deterministic 2% audit sample. Protected title drops still
receive abstract scoring, and the run reports the observed false-negative count/rate over the full
reviewed population (not only the final display cap). Every abstract score paid for is cached.

#### OpenAlex, re-verified live 2026-07-30 (corrects the "it's dead" note above)

OpenAlex introduced usage-based pricing on **2026-02-24**. The prices are per call, and the shape of
the call is what costs money:

| Call | Price | Our code |
|------|-------|----------|
| Single work by DOI or OpenAlex id (`/works/doi:…`) | **$0 — unlimited** | `openalex.work_authorships_for`, `citations._openalex_by_id` |
| Filter / list (`/works?filter=…`) | $0.0001 (~$0.10 per 1,000) | not used |
| Search (`/works?search=…`) | $0.001 (~$1.00 per 1,000) | `citations._openalex_citation_count` |
| PDF / XML download | $0.01 | not used |

Daily free allowance is **$0.10/day with no key, and $1/day with a free API key** — 10×, free to
obtain, passed as an `api_key=` **query parameter**.

**The key is wired and live (PR #304, 2026-07-30).** `openalex.api_key()` reads `OPENALEX_API_KEY`
then the settings document's `openalex_api_key` (operator-owned); `openalex.make_client()` is the
one constructor and attaches it via `httpx.Auth`, **not** client `params=` — httpx lets a
request-level param of the same name override a client-level one, so `params=` would let any call
site silently blank the key. Production carries it as a Fly secret, verified on the machine (free
by-id → 1969, metered search → 224356). **Staging does not have it.** The secret was staged with
`flyctl secrets set --stage` and applied by the deploy, costing one machine restart instead of two —
worth repeating whenever a secret and a deploy land together, since a restart kills in-flight jobs.

**So the `429 "…costs $0.001 but you only have $0"` was self-inflicted, not a policy wall.**
`citations.OPENALEX_MAX_LOOKUPS = 120` metered *searches* is $0.12 — one enrichment pass exhausts
the entire unkeyed $0.10 daily budget, and everything afterwards that day 429s. That is why it
looked permanently dead. Re-tested unkeyed on a fresh day: search returned **200**, not 429.

Two consequences for planning:

1. **The key was the whole fix for the budget**, and identifier lookups do not draw it down at
   all. Affiliation enrichment (discovery's evidence step) uses the **free** by-id shape, so it can
   run at effectively unlimited volume. Note `/works?filter=` is $0.0001 — **10× cheaper than
   search** and currently unused by us; it is the obvious shape for a high-recall funnel.
2. **Independent bug: arXiv DOIs resolve unreliably.** `openalex._work_lookup_id` maps an arXiv id
   to `doi:10.48550/arXiv.<id>`. Of five well-known papers, **two 404** under that DOI — including
   "Attention Is All You Need", which *is* in OpenAlex (`W2626778328`, 6,598 citations) under a
   different DOI. Since our corpus is overwhelmingly arXiv, the free path we most want is the one
   silently missing. Callers treat any non-200 as "no data", so this looks like absent coverage.
   Fixing the resolution matters more than the budget does.

**A correction worth carrying:** an earlier version of this list said "encrypted in transit" was
blocked partly by `safe_fetch` permitting `http://` paper URLs. Checked against Google's live
definition on 2026-07-28, that question is scoped to the app's own transmission from device to
server, so a backend fetching a third-party document is out of scope. Acting on the old wording
would have broken retrieval for http-only academic hosts for no compliance gain. This is the second
time in one day a document here read as authoritative and was stale — the other cost an outage — so
treat anything environment- or policy-specific in `docs/` as needing re-verification, per the policy
verification rule at the end of this file.

### Device-test runbook (verified 2026-07-28)

The trap this exists to prevent: a Metro server can be running, healthy, and serving *the wrong
worktree*. On 2026-07-28 it was being kept alive by a launchd agent, `com.paradigm.metro.auth-ui`,
pinned to `.claude/worktrees/m2-auth-ui` — ten commits behind `main` — and it respawned twice after
being killed before the agent was found. Its plist lived in `/private/tmp`, not
`~/Library/LaunchAgents`, so it did not show up in the obvious place. `launchctl list | grep -i
metro` is what finds it.

So: **prove what is served, never that a server is up.**

- Metro's actual working directory: `lsof -a -p $(lsof -ti :8081) -d cwd`.
- Route modules are **absent from `index.bundle`** — `AuthGate` lives in `_layout`, so fetch
  `http://127.0.0.1:8081/src/app/_layout.bundle?platform=android&dev=true&minify=false` and grep
  it for a string only the new code contains. On 2026-07-28: `Your account was deleted` and
  `accountDeletedNotice.v1` both present, and the same key present in `delete-account.bundle`.
- Backend: `curl http://100.83.161.127:8000/api/health`; Metro over the tailnet:
  `curl http://100.83.161.127:8081/status`. Both must answer from the phone's network, not just
  loopback.
- The phone is `oneplus-15` (`100.79.189.127`) and was directly connected on the tailnet.

**For anything auth-gated, point the app at staging** — Settings → server URL →
`https://research-companion-staging.fly.dev`. `app.json`'s baked `extra.apiBaseUrl` is the Mac's
tailnet address, which is the open-auth instance.

**Closed 2026-07-28 (#262).** `_owned_data` raising `ambiguous-transition-trash` is the correct
fail-closed choice, but it used to leave the account in a permanent 423 with a retry that could
never succeed, and "deletion is stuck forever" was indistinguishable from "deletion is running" —
because a stalled row *oscillates* between `error` and the running phases as the resume monitor
restarts it, so the instantaneous status was evidence of nothing.

`stalled` is now derived from the attempt count and outranks the phase: the operator gets one
`ERROR` line per stall (never per scan, and carrying the subject key rather than the user id), and
the client says the deletion needs attention instead of that it "continues safely on the server".
Retries continue regardless — the signal reports, it does not give up.

Two things from its review are worth carrying, because both were true of code that looked fine:
the threshold's stated justification was arithmetically wrong (`_retry_delay_s(6)` is 160, not the
300 cap) and the test that appeared to guard it asserted `>= 160`, which the wrong value satisfies;
and the feature had **no end-to-end coverage at all** — deleting either the `stalled` key from the
wire or the alert loop from `resume_active` left both suites green. Both are now bracketed and
probed. The remaining operator surface — a queue rather than a log line — is M8.

**M2.5 compliance inventory started 2026-07-28.** The code-derived storage/processor inventory and
provisional Play Data Safety matrix now live in
[`02-security-and-privacy.md`](02-security-and-privacy.md). It found two declaration blockers that
must be fixed rather than hidden in policy prose. The first is now code-complete: ordinary project
deletion clears the live owner but preserves the exact `.trash` incarnation and former owner, while
ambiguous legacy directories require explicit operator mapping. The remaining declaration blocker
is that the current mobile source still defaults to an `http://` tailnet URL while backend retrieval
also permits public `http://` URLs, so “all data encrypted in transit” must wait for an AAB pinned
to the production HTTPS origin and HTTPS-only user/agent-selected fetches.

~~Client wiring for per-user settings~~ — done (#240): both clients now separate `is_operator` (the
provider keys) from `can_edit_preferences` (model/voice/prior-notes). ~~Staging Supabase Site URL /
redirect~~ — was already configured; the item was stale. Google OAuth on the *staging* project (H5
step 5) is the one auth piece that may still be unconfigured there, and magic link works without it.

Not in M2 and still open: P0-17 (`DeliveryReq.model` bypasses settings entirely, so per-user model
preferences do not bound spend — that is M3's tier check), and audio cache eviction, which per-user
copies make *more* pressing rather than less.

M1's PRs, for reference:

| PR | Scope | Status |
|---|---|---|
| #218 | Dockerfile, `.dockerignore`, `fly.toml`, `fly.staging.toml`, staging deploy | ✅ merged to `main` |
| #219 | `RC_ENV` gating, auth hard-fail, user allowlist | ✅ merged to `main` (`9cace9f`) |
| #220 | Hardened outbound-fetch helper — `app/safe_fetch.py` (P0-14) | ✅ merged to `main` (`8e2d5d1`); 16 Sol rounds, 31 defects fixed |
| #222 | Operator role — instance-wide settings + prompts restricted to `RC_OPERATOR_USERS` (P0-2, P0-3) | ✅ merged to `main` (`a291edd`); 2 Sol rounds |
| #223 | Client half of the operator role — both clients key off `is_operator` (P1-15) | ✅ merged to `main` (`07b7f23`); Sol clean first round |
| #224 | API-36 spike — already 36, no change (P2-4) | ✅ merged to `main` (`a18cd6f`); Sol verified the chain |

**M1 is code-complete. Everything left in it needs Kamil** — see `HUMAN_ACTIONS.md`. Nothing further
can be built on this milestone without a payment method on Fly, a named operator id, and the
Supabase projects.

**#220 is worth reading the commit history of.** Thirty-one defects across sixteen review rounds,
and essentially all of them were in the fix rather than in the code it replaced. Three patterns, all
worth carrying into M2:

1. *Fixing a class of bug one layer down from where it was fixed.* Unvalidated redirects were closed
   in `safe_fetch`, then reintroduced in a hand-rolled arXiv streamer. Silent truncation was closed
   for multi-member gzip, then reappeared for truncated streams and again for close-delimited EOF.
   The lesson that stuck: route through the one guarded path instead of writing a second one.
2. *Tests that pass for the wrong reason.* A decompression-bomb test passed while 200MB was
   allocated; a memory test gzipped compressible data so the buffer it measured was free; a deadline
   test asserted an error that fired either way. Each looked green. The habit that caught them is
   reverting the fix and requiring the test to go red — and verifying the revert actually applied.
3. *Absence is invisible to a green suite.* A regex cleanup silently deleted 27 tests, including
   every SSRF regression test, and the suite stayed green for two commits under a section header
   with nothing beneath it. Bulk edits to tests now get a before/after count.

The decoder that caused most of this was ultimately **deleted** rather than bounded a fifth time:
the client sends `Accept-Encoding: identity` and refuses any content coding unread.

**Review note on #219:** it had one Sol round (applied as `04bc9c6`) plus a self-review pass, not
two Sol rounds — codex was in a provider-wide 503 outage (`biscuit_baker_service_me_circuit_open`)
and the loop's fallback reviewers run as subagents, which are not spawned unprompted. The
self-review found three real issues (duplicated `RC_DEV` truthiness rule between
`auth.assert_environment_safe` and `config.dev_mode`, a stale "Default dev" claim in
`.env.example`, and a `setdefault` in `conftest.py` that let a developer's shell break the suite).
If codex recovers, re-running a round against `main` costs nothing.

**Live:** `research-companion-staging.fly.dev` — `RC_ENV=staging`, Supabase auth enforcing,
allowlist = Kamil's UUID only, **no provider API keys** (so nothing can spend). Volume `rc_data_staging`
(3 GB, `dfw`) mounted at `/data`; `/api/health` returns `dev:false`; `/api/projects` 401 unauthenticated.

**Production Fly app `research-companion` exists but has never been deployed** and has no volume.

**API-36 spike: done 2026-07-25 — nothing to change.** Expo SDK 56 / RN 0.85.3 already resolves
`targetSdkVersion` to **36** (via RN's `gradle/libs.versions.toml`, not the plugin's 35 fallback),
so the Play requirement effective 2026-08-31 is met with no `expo-build-properties` override. Left
unpinned on purpose — the requirement is a floor ("36 or higher"), and a pin would hold the app at
36 when a later Expo SDK raises it. Reproducibility does not depend on the pin: `package-lock.json`
already fixes RN at 0.85.3, so the catalog that supplies the 36 is itself locked. Full chain
recorded as P2-4 in the audit.

**Not yet started in M1:** the production app + secrets. Data migration and client cutover are deliberately *out* of M1 — see M1's
"Rollback" section for why they are gated on M2 and M6.

**Operational notes for whoever picks this up:**
- `flyctl` is installed and authenticated on the dev Mac. Deploy with
  `flyctl deploy -c fly.staging.toml --remote-only --yes` — the local Docker daemon is not running,
  so builds must be remote.
- Sol reviews: `codex exec --sandbox read-only - < <instructions>.md`, **run from the repo root**
  (codex refuses elsewhere). `codex exec review --base main` cannot take a custom prompt, so the
  instructions tell it to diff against `main` itself.
- A deploy stops the machine and kills in-flight jobs — check for active jobs first.

**Answered by Kamil 2026-07-25 (all four):**

1. **`RC_OPERATOR_USERS` is set on staging.** ✅ Prompt and settings editing now work for the named
   operator and 403 for everyone else.
2. **Monthly spend ceiling: $200.** This is the number M3's per-user caps get sized against — see
   "Sizing M3 against the $200 ceiling" below.
3. **TTS model: `tts-1`** (H22 revised). Halves the single largest variable cost. `tts-1-hd` stays
   selectable.
4. **Supabase: two Free projects, $0 — Pro not needed yet.** ✅ A separate staging project
   (`iqsiabkdbczvgyccswcy`) was created 2026-07-25, so production (`aumedoefxacycwfrlcml`) no longer
   doubles as staging. This closes a compromise that had rested on my own unverified claim that the
   account was at the 2-project cap; it was not. Free allows **2 active projects**, pauses one after
   **1 week of inactivity**, and has **no automatic backups**; Pro is **$25/mo**. **Pro becomes right
   at M6**, whose gate is exactly "automated backups and a tested restore" — and the content record
   lives in **git**, not Postgres, so what Pro protects is the ownership/index tables, not the papers
   or notes. Staging's JWKS was verified to return an ES256 key before anything pointed at it.

   **Consequence to sequence carefully:** Supabase user ids are per project, so repointing staging
   invalidates `RC_ALLOWED_USERS` / `RC_OPERATOR_USERS`. See H4 for the four-step bootstrap; the
   middleware now logs the rejected id so `flyctl logs` answers it without the dashboard.

**Fly payment method: added.** ✅ The production app + volume is unblocked.

**Staging is fully wired (2026-07-26).** Its own Supabase project (`iqsiabkdbczvgyccswcy`), Site URL
and Redirect URLs configured — including `researchcompanion://auth` for the mobile scheme — Google
provider enabled, and `RC_ALLOWED_USERS` / `RC_OPERATOR_USERS` set to Kamil's staging UUID. Mobile
authentication shipped in #228, so the Android app can now talk to staging: **P0-15 is closed and
M2's hard ordering constraint is satisfied.**

#### Sizing M3 against the $200 ceiling

$200/month is the total spend ceiling (Kamil, 2026-07-25). Fixed cost is **$25.86** (Fly prod
$14.24 + 20 GB volume $3.00, staging $7.12 + volume $1.50, Supabase Free $0), leaving **$174/month
of variable budget**. Against `20-pricing-analysis.md`'s unit costs — $0.14/free-user-month,
$2.22/Basic-user-month, $8.40 net revenue per Basic after Play's 15%:

| Mix | Users the ceiling supports | Variable spend | Revenue there |
|---|---|---:|---:|
| All free | 1,243 free users | $174.02 | $0 |
| 10:1 free\:paid | 48 paying + 480 free | $173.76 | $403 |
| 20:1 free\:paid | 34 paying + 680 free | $170.68 | $286 |
| All paid | 78 Basic subscribers | $173.16 | $655 |

Counts are floored to whole users and the spend column is computed from those same counts, so
every row actually fits under $174.14. (Rounding the 20:1 row *up* to 34.7 → 35 paying and 693.8 →
694 free would put it at $174.86 — over the ceiling, which is exactly the kind of quiet overshoot a
capacity table should not print.) Revenue is the floored subscriber count × $8.40.

**The ceiling is not the binding constraint at any realistic launch scale**, and in every mixed
scenario revenue passes $200 well before spend does. The closed test costs
**$1.68/month of variable spend** (12 testers × $0.14) on top of fixed — i.e. the whole M2.5 tester
phase runs at roughly $28/month.

Two things follow for M3, and they are the actual work:

1. **$200 must be enforced at the provider, not just in-app.** The in-app per-user cap stops one
   user burning everyone's budget; it does nothing if a bug loops. Set the OpenRouter credit limit
   and the OpenAI spend limit to sum to $200 in *enforcing* mode (H20). That is the only layer that
   holds when our own accounting is the thing that broke.
2. **The per-user cap is sized from the mix, not from $200.** $174 ÷ the free allowance is 1,240
   users; the cap that matters is the one making a *single* user's worst case bounded — which
   `20-pricing-analysis.md` §6 identifies as premium TTS minutes, the only line with no natural
   ceiling. Enforce minutes server-side before synthesis, since `tts-1`'s character pricing makes
   the cost of a dispatch exactly knowable before making it.

**Decided/closed since the last revision:** OpenRouter key on staging; OAuth consent screen
published; H6 (operator gating, #222/#223 — closes P0-2 and P0-3); H22 (revised to `tts-1`); the
API-36 spike (#224, already 36); testers deliberately deferred until the app is testable, which
makes Play's 12-testers/14-continuous-days clock strictly additive after M2.5 rather than parallel
with M2.

**Pricing is now analysed, not assumed** — see `20-pricing-analysis.md`. Free = 15 turns on
DeepSeek V4 Flash with `BrowserTTS` (~$0.14/user-month worst case); Basic $10 = 60 turns + 45 min
of `tts-1` (74% gross margin after Play's 15%, break-even ~5 paying users). The four findings that
reshape M3 are recorded as **P0-16, P0-17, P1-12, P1-13, P1-14** in the audit. The historical
findings were: unmetered audio as the biggest cost line, no server-side model gate, cost-unordered
provider routing, 17.3 listening-preview calls per turn, and an unbounded audio cache. Attribution,
cache eviction, preview prompt volume, and cheapest-eligible OpenRouter ordering are now stacked in
review; the tier/model gate and actual quota values remain H15 business decisions.


---

## Locked decisions

Settled 2026-07-24 with the product owner. These are the assumptions the whole sequence rests on;
revisiting one invalidates the milestones downstream of it.

| Decision | Choice | Reversibility |
|---|---|---|
| Production backend hosting | **VPS/container with a persistent volume** (Fly.io, Railway, or Hetzner + Docker). FastAPI and git-on-disk stay intact; single worker still holds. | Reversible — it's a Dockerfile and a deploy target. |
| Per-user data isolation | **Postgres for ownership/index, git for content.** A small Postgres (Supabase) holds users, project ownership, usage events, entitlements, and abuse reports. Project content stays markdown-in-git. | Partially — the schema is easy to change, the git layout less so. Decide the on-disk namespacing once (M2). |
| Commercial model | **Subscription with hard per-user budget caps.** RevenueCat + Google Play Billing; Free tier with a small included allowance; Pro monthly/annual. Caps are non-negotiable given the marginal cost profile. | Pricing is reversible; the metering architecture it requires is not wasted either way. |

**Scope note (honest):** M1–M11 is several months of solo work, not weeks. The critical path to a
*published* app is M1 → M2 → M2.5 → M3 → M7 → M8 → M9 → M10. M4/M5 (money) can be resequenced if
you'd rather get a free closed beta into Play first and monetize against real usage data — say so
and I'll re-cut the order. M6 (durability) is no longer freely movable: it now depends on M3,
because interrupted jobs and orphaned quota reservations are the same event and must be reconciled
against the same records.

**Calendar dependency, confirmed 2026-07-25:** the Play account is Personal and created 2026-07,
so Google's closed-testing requirement **applies** — 12 testers opted in for 14 continuous days,
then production-access review of up to 7 days. That ~3-week clock cannot start until a working
build is on a closed track, so **M2.5 exists to start it as early as is legal and safe** and let it
run in the background during M3–M8. It sits after tenancy (M2) and carries a compliance slice,
because closed tracks require a Data safety form and privacy policy and because 12 external testers
must not share one untenanted backend — see M2.5 for the verification. Recruiting testers (H16) is
the pacing item; start recruiting *during* M2 so they are ready the day M2.5 lands.

---

## Architectural rules for this work

These exist because the milestones below touch code whose invariants are load-bearing. `CLAUDE.md`
gets updated as each lands.

1. **Postgres access never enters the deterministic spine.** Invariant 3 says `app/store.py` makes
   no network calls; that now also means no database calls. Tenancy and metering live in new
   modules (`app/db.py`, `app/tenancy.py`, `app/metering.py`) called from routers and dependencies,
   never from `store.py` / `sessions.py` / `committer.py`.
2. **The scope key is the composite `(user_uuid, pid)` — everywhere, not just a contextvar.**
   A user contextvar alone is not enough, because today's in-memory keys are `pid`-only: job
   ownership and dedup (`jobs.py:142`), the deleting/busy tombstone sets and the per-project RW
   locks (`config.py:157`), and the paper-identity locks. Two users will both plausibly have a
   project called `default`, so pid-only keys let one join, poll, or cancel the other's job — and
   let one user's split/delete tombstone block the other's — even though their files sit in
   separate directories. Define one canonical composite scope and use it for job keys, locks,
   tombstones, caches, and path resolution alike. Isolation tests must deliberately give both
   users the *same* pid and slug and run jobs concurrently.
3. **Carry that scope into *every* worker, not just `JobRegistry`.** Extending the registry is
   necessary but insufficient: several paid paths spawn their own threads and executors and
   manually rebind only the project — `graph.py:257` (extraction executor), `graph.py:1515`
   (reference fan-out), `affiliations.py:157` (deadline worker). Each would drop the user and
   misattribute spend. Introduce one captured-execution-scope helper carrying both user and
   project, and migrate every `Thread`, `ThreadPoolExecutor.submit`, and orphan-worker site.
   Test attribution *through* a real nested graph/affiliation worker, not just through the registry.
4. **Isolate on the filesystem *and* with mandatory owner-filtered queries.** Namespace the
   projects root per user (`PROJECTS_ROOT/<user_uuid>/<pid>`) *and* scope every query by owner.
   This extends the `_safe_pid` trust boundary to two segments — treat it as security-critical.
   **Do not count RLS as a backend safety net:** the backend connects with a Supabase service
   credential, which *bypasses* RLS, so RLS cannot catch a route that forgets its owner predicate.
   Enable RLS anyway — it protects direct Data API access — but backend isolation rests entirely
   on owner-filtered queries plus filesystem namespacing. If a genuine second layer is wanted, use
   the user's JWT (a non-bypass role) for user-scoped operations.
5. **Quota enforcement is a pre-spend *reservation*, not post-hoc metering.** Best-effort
   accounting after the fact cannot enforce a ceiling — concurrent jobs all pass a
   historical-total check before any of their records land, and metering is explicitly forbidden
   from failing a turn. These are separate mechanisms: **enforcement** atomically reserves a
   pessimistic maximum cost (including in-flight reservations) in Postgres before job admission
   and settles to actual cost afterward, failing *closed* for paid work if the quota store is
   unavailable; **analytics** stays best-effort and never fails a turn. Entitlement checks are
   server-side and precede spend; the client is never the authority. Reservations are durable
   records with leases and idempotent startup reconciliation (see M3) — an in-memory reservation
   table would evaporate on the restarts invariant 6 makes routine. And "before spend" means
   *every* spend path, not just LLM jobs: TTS is currently unmetered entirely (P0-13).
6. **Single uvicorn worker still holds** (invariant 6). Postgres does not change this — job state
   is still in-memory until M6. Do not add `--workers N`. Note this interacts with rule 5: an
   in-process reservation table would be lost on restart, which is why reservations live in
   Postgres rather than memory.

---

## Milestones

| # | Milestone | Depends on | Complexity | Status |
|---|---|---|---|---|
| M1 | Hosting, environments, and secrets | — | L | **code-complete** (#218–#224 merged); the rest needs Kamil — see `HUMAN_ACTIONS.md` |
| M2 | Identity, tenancy, and per-user isolation | M1 | L | **staging rollout complete** — backend #235–#238, client #240, database migrations + six-project adoption verified |
| M2.5 | Closed-track compliance minimum (incl. account deletion) + first build — starts the 14-day tester clock | M1, M2 | L | **in progress** — code-derived inventory and declaration draft written; deletion/report/policy/build remain |
| M3 | Metering, quotas, and abuse controls | M2, M2.5 | L | queued |
| M4 | RevenueCat foundation | M2 | M | queued |
| M5 | Subscription-backed access | M3, M4 | M | queued |
| M6 | Durability — job persistence and backups | M1, M3 | M | queued |
| M7 | Remaining compliance, safety, and legal surfaces | M2, M2.5 | M | queued |
| M8 | Observability and operator tooling | M1 | M | queued |
| M9 | Android release automation | M1, M7 | M | queued |
| M10 | Launch rehearsal | all | M | queued |
| M11 | Production release | M10 | S | queued |

---

### M1 — Hosting, environments, and secrets

**Objective.** Move production off the home Mac mini onto a reproducible container deployment with
a real domain, TLS, a persistent volume, and a staging environment.

**Rationale.** Blocks everything. Supabase auth redirect URLs, the Play-required account-deletion
web page, Play reviewer access, and any uptime claim all need a stable public HTTPS origin. It is
also the last cheap moment to introduce environment separation.

**Scope.** Dockerfile for the FastAPI app (including the `web/dist` static mount). Persistent
volume for `PROJECTS_ROOT` and `.app-state/`. Deploy config for staging + production. Domain, TLS,
process supervision and restart policy. Environment-aware config (`RC_ENV` ∈ dev|staging|prod) that
makes `RC_DEV` and `RC_AUTH_TOKEN` **impossible** to enable in prod, not merely unset.

**Critically (P0-12): prod must refuse to start unless `auth.mode() == "supabase"`.** Forbidding
the dev switches is not sufficient — `auth.mode()` returns `open` when *no* auth env is set, so the
dangerous state is missing config, not present config, and a deploy that forgets one variable
serves the whole API to the internet with no error. Fail loudly at startup instead. This pulls H4
(create the Supabase projects) forward from M2 into M1's prerequisites.

**Equally critical: authentication alone is not access control here.** Supabase Email/Google
sign-in is *self-service* — anyone can create an account — and until M2 lands, any authenticated
user gets the whole single-tenant instance: every project, and `POST /api/settings` / `POST
/api/prompts` over the shared provider keys and system prompts (P0-1/2/3). Deploying M1 publicly
with auth "on" would therefore hand the instance to the first stranger who signs up. M1 must ship a
**temporary allowlist of permitted user UUIDs** (or disable public signup) enforced in the auth
middleware, and keep it until M2's ownership enforcement replaces it. Test that a valid-but-not-
allowlisted JWT gets 403, not 200.

**Close P0-14 before the service is internet-reachable.** `retriever._fetch` follows redirects to a
caller-supplied `pdf_url` and buffers the whole body, with no IP validation and no byte cap — so an
authenticated user can reach the host's internal network and metadata endpoints, or OOM the single
worker (a full outage, invariant 6). On a home Mac mini behind Tailscale this was low-stakes; on a
cloud host it is not.

**Do not simply reuse `_assert_public_url` — it does not close this.** `docs/improvements.md` §7.6
already documents the gap: the helper resolves the host with `getaddrinfo`, checks those IPs, and
then httpx **re-resolves** for the actual connection, leaving a DNS-rebinding window where an
attacker-controlled hostname resolves publicly during validation and privately during the fetch.
Validating every redirect hop does not close it either. M1 must **pin the validated address** (a
custom transport that connects to the checked IP) or verify the connected peer before the response
is read. Stream the download with a byte ceiling instead of `.content`, reusing the 40 MB limit the
upload path already enforces. M1's allowlist limits exposure to trusted users until M2.5, but this
is cheap enough that it should not wait.

**Fix every outbound-fetch path in M1, not just this one.** Deferring the sweep to M3 would leave
holes open through M1 and the entire M2.5 closed test. There are four, each broken differently:

| Path | Address validation | Memory ceiling |
|---|---|---|
| `retriever._fetch` (`retriever.py:173`) | none | none — buffers `.content` |
| `retrieval_agent.fetch_pdf` (`retrieval_agent.py:31`) | validates, then httpx re-resolves (rebinding) | none — buffers `.content` in full, *then* slices to `HUNT_MAX_PDF_BYTES` |
| `cover_jobs._download_pdf` (`cover_jobs.py:82`) | none, and follows redirects | correct already — streams with a cap |
| `research_tools._direct_fetch` | rebinding gap (§7.6) | n/a |

So the work is: one pinned-address, redirect-validating, streaming-with-ceiling fetch helper, and
every one of these four migrated onto it. `cover_jobs` already shows the right streaming shape to
generalize from.

Secrets move to the platform's secret store; `.env` stays dev-only. Client points at the new origin via
`app.json` `extra.apiBaseUrl` with staging/production variants. Early spike: verify Expo SDK 56's
Android `targetSdkVersion` against the API 36 requirement (cheap now, expensive to discover at M9).

**Files/services.** New `Dockerfile`, `.dockerignore`, deploy manifest; `app/config.py`
(environment gating); `app/main.py`; `run.sh`; `mobile/app.json`; `.env.example`; new
`docs/production/01-architecture.md`.

**Risks.** Tailscale-based device testing changes shape — keep the tailnet path working for local
dev so the loop in `CLAUDE.md` survives. PyMuPDF/pypdf need correct base-image wheels. Git must
work inside the container (identity is already pinned, so this should be clean).

**Tests.** Container builds and serves `/api/health`. Volume survives a restart with projects
intact. A prod-mode boot with `RC_DEV=1` and `RC_AUTH_TOKEN` set refuses to enable either, **and a
prod-mode boot with no Supabase config fails to start at all**, **and a valid JWT for a
non-allowlisted user is rejected with 403** — assert all three in `tests/`. **P0-14: a `pdf_url`
pointing at a private address is refused; a redirect *into* a private address is refused; a
hostname that resolves public-then-private across the two lookups is refused (the rebinding case —
fake the resolver so the second answer differs from the first); and a response exceeding the byte
ceiling is aborted mid-stream rather than buffered.** Existing suite green in-container.

**Manual.** Deploy staging, run the device checklist against it from the phone over the public
origin. Restart the service mid-job and confirm the failure mode is understood (it will lose the
job — that's M6, just document it).

**Rollback.** Mac mini keeps running unchanged until staging is proven; DNS/`apiBaseUrl` cutover is
the only switch, and it reverts.

**Production data migration and client cutover are explicitly NOT in M1** (established reviewing
PR #218). Both are gated on later milestones, and pretending otherwise is how the record gets lost:

- **M2** — the mobile client cannot authenticate at all (P0-15), so pointing it at an
  auth-enforcing production would simply break it.
- **M6** — a Fly volume is a *single unreplicated copy*, and Fly's own guidance is explicit that
  daily volume snapshots are not a primary backup. Migrating the git-backed record onto one volume
  with no off-host backup turns a host failure into a data-loss event. Production must not become
  the authoritative copy until M6's automated backups **and a tested restore** exist.

Until both land, the Mac mini stays authoritative and Fly is a proving ground.

**Done when.** Staging and production both reachable over HTTPS on a real domain, restart-safe,
volume-backed, secrets out of the repo, prod provably refusing dev bypasses, API-36 answer recorded.

**Human actions.** H1 (Actions billing) ✅ and H2 (Fly account) ✅ are done. **All four of these
block the deploy:**
- add a payment method to Fly (persistent volumes are not in the free allowance);
- **H4** — create the production and staging Supabase projects, pulled forward from M2 because prod
  now refuses to boot without Supabase auth configured;
- **H20** — set the OpenRouter key credit limit and the OpenAI Admin API spend limit in *enforcing*
  mode, before the instance is internet-reachable;
- **H21** — provide your Supabase user UUID for the temporary allowlist, without which the first
  stranger to sign up owns the pre-tenancy instance.

No domain purchase needed: `research-companion.fly.dev` ships with TLS (H2b defers a custom domain
to M10).

---

### M2 — Identity, tenancy, and per-user isolation

**Objective.** Make every piece of data owned by a user, and make cross-user access structurally
impossible.

**Rationale.** P0-1, P0-2, P0-3. Today any authenticated user reads and writes every project and
can rewrite the instance's API keys and system prompts. This is the largest single body of work and
everything commercial depends on it.

**Scope.** Introduce Postgres (Supabase project, migrations in `supabase/migrations/`, in source
control). Tables: `users` (mirroring auth UUIDs), `projects` (id, owner, timestamps), `usage_events`,
`entitlements`, `content_reports`, `deletion_requests`. RLS on everything exposed, plus server-side
ownership checks — the backend uses a service credential, so RLS is defense in depth, not the
primary control. Add `app/db.py` (connection/migration plumbing) and `app/tenancy.py` (ownership
resolution). Extend `use_project` to check ownership. Namespace `PROJECTS_ROOT` per user and extend
`_safe_pid`/`project_path` to two segments. Add an active-user contextvar and rebind it in
`JobRegistry` alongside the project. Split settings into **operator-owned** (API keys, prompts —
restricted to an operator role, closing P0-2/P0-3) and **per-user preferences** (model picks, voice,
`prior_notes_scope`). Authorize job endpoints by owner (P1-2). Backfill: adopt existing local
projects under your own user id.

**Build mobile authentication — it does not exist (P0-15).** The Android app has no Supabase
dependency, no sign-in screen, and no session handling; `setToken` has no caller, so a token can
never be set. Scope: add `@supabase/supabase-js`, a sign-in screen (magic link + Google), session
persistence in `expo-secure-store` (already a dependency), token refresh, sign-out, and the
OAuth redirect via `expo-web-browser` back through the app's `researchcompanion` scheme. Mirror
`web/src/components/AuthGate.tsx`, which already does this correctly for the web client.

**Hard ordering constraint:** M1 makes production refuse to boot without Supabase auth, so the
mobile `apiBaseUrl` cutover **cannot happen until this lands**. Until then the app keeps pointing
at the Mac mini. This is also why M2.5 depends on M2 — testers must be able to sign in.

**DECIDED 2026-07-26 (Kamil): scope audio jobs and the mp3 cache PER USER.** Each user gets their
own job and their own copy of the file. Chosen over the ACL-rows-over-shared-blobs alternative the
paragraph below recommends, and the reasoning is worth keeping: per-user caching still de-duplicates
a user's OWN repeat listens, which is the common case, so the cache-sharing loss only applies when
two different users narrate identical text — rare with different readers on different papers.
Against that, ownership becomes obvious, cancellation is trivially correct (the job is yours alone),
and M7 deletion is `rm -rf audio/<user_id>/` rather than reference counting. Revisit only if the
usage ledger shows real cross-user duplication.

**Audio needs an explicit redesign, not just an ownership check.** Audio jobs are deliberately
registered under the `None` project scope so identical narration requested from anywhere shares one
job (`audio_jobs.py:89`), cancellation therefore cancels *every* caller joined to that content, and
finished mp3s are served from an app-global content-hash route (`routers/audio.py:89`). None of
that acquires an owner just because a user contextvar exists, and M7 could not later delete one
user's audio. Pick one: scope jobs and cache references per user, or keep immutable
content-addressed blobs behind per-user ACL/reference rows with subscriber-aware cancellation (so
one subscriber leaving doesn't kill another's synthesis). The second preserves the cache-sharing
win and is the recommendation. Polling, media access, billing attribution, and deletion each need
tests.

**Files/services.** New `app/db.py`, `app/tenancy.py`, `supabase/migrations/`; `app/projects.py`,
`app/config.py`, `app/jobs.py`, `app/routers/settings.py`, `app/routers/projects_api.py`,
`app/routers/audio.py`, `app/main.py`; both clients' settings screens; **new mobile auth module +
sign-in screen, `mobile/package.json` (`@supabase/supabase-js`), `mobile/src/api/config.ts`.**

**Risks.** Highest-risk milestone. Touching `_safe_pid` and `project_path` is touching the trust
boundary. The contextvar rebind is the invariant that "silently reads/writes the wrong project's
files" when wrong — now with a user dimension. Mitigate with heavy tests before behavior changes.

**Tests.** Cross-user isolation: user A cannot read, write, list, split, delete, or job-poll user B's
project — one test per route family. **Give both users the identical pid (`default`) and the same
paper slug, and run their jobs concurrently** — this is the case pid-only keys get wrong (rule 2),
so a test that gives them different pids proves nothing. Path traversal via either segment.
Non-operator cannot POST settings or prompts. Scope correctness for both project *and* user inside
job threads **and inside the nested graph/affiliation workers** (rule 3). Audio: one user cannot
poll, cancel, or fetch another's narration, and cancellation by one subscriber does not kill
another's. Migration applies cleanly to an empty and a populated database.

**Manual.** Two accounts on staging; confirm complete invisibility in both directions.

**Rollback.** Ownership enforcement behind a flag defaulting on in staging first; migrations are
forward-only, so keep a database snapshot before applying.

**Done when.** Every `/api/*` route is owner-scoped, operator-only settings are enforced, isolation
tests pass, and existing projects are adopted under your user with no data loss.

**Human actions.** H4 (the Supabase projects) now lands in M1, since prod cannot boot without it —
what remains here is configuring Google OAuth credentials (already documented in `README.md`) and
deciding how the
operator role is assigned.

---

### M2.5 — Closed-track compliance minimum + first build (starts the 14-day tester clock)

**Objective.** Get a signed AAB onto a Play **closed** testing track as early as it can legally and
safely go there, because the tester clock is the longest calendar dependency in the plan and
should run in the background while M3–M8 proceed.

**Rationale, and why this is no longer "M1.5".** The first draft put this immediately after
hosting. Sol's review (PR #217) established that was wrong on two counts, both verified:

1. **Closed tracks are not exempt from compliance.** Only *internal* testing is exempt from the
   Data safety form — and internal testing does **not** satisfy the 12-tester requirement, which
   specifically requires a closed test. So a truthful Data safety declaration, a published privacy
   policy, and (for generative AI) an in-app content-report action are all prerequisites of the
   upload, not things to fix "if review objects."
   Verified 2026-07-25: [Data safety](https://support.google.com/googleplay/android-developer/answer/10787469)
   ("All developers that have an app published on Google Play must complete the Data safety form,
   including apps on closed, open, or production testing tracks"),
   [AI-generated content policy](https://support.google.com/googleplay/android-developer/answer/13985936).
2. **Shipping single-tenant to external testers is not acceptable.** The original text waved this
   through as "recruit people who are fine being a shared-instance beta." But 12 testers sharing
   one backend would see each other's reading projects and notes — and a Data safety form
   declaring that is either a disclosure of a privacy defect or a false statement. Tenancy (M2) is
   a hard prerequisite, not a nicety.

So this milestone now depends on M1 **and** M2, and carries the compliance slice itself.

**Scope, part 1 — compliance minimum.** The subset of M7 that the upload requires: a data
inventory derived from actual code and a truthful Data Safety draft (started in
[`02-security-and-privacy.md`](02-security-and-privacy.md)), a published privacy policy and
terms at public URLs, in-app links to both, and a working in-app report action for offensive
AI-generated content with somewhere for reports to land.

**Account deletion is in this set too** (round-2 correction). The app creates accounts, and
Google's policy — "if your app enables account creation, you must provide users with an in-app
path to delete their app accounts and associated data, *and* a web link resource where users can
request deletion" — states no exemption for testing tracks, while the Data safety form explicitly
asks about deletion. Declaring a deletion path that doesn't exist would make the form untruthful.
So M2.5 ships the real workflow: revoke the Supabase Auth identity, delete the user's Postgres
rows, remove their namespaced git content, drop their audio references, and delete their usage
events (retaining only what is documented as legally necessary). This is tractable precisely
because M2 has already established per-user namespacing and DB ownership — deletion becomes
"delete the rows and remove the namespace," not an archaeology exercise.
*Fallback if this slips:* pre-provision tester accounts and disable public signup, so the app
arguably does not "enable account creation" — but verify that reading against current policy
before relying on it, and note it also satisfies M1's allowlist requirement.

Everything else in M7 (the operator review queue, the paper-source terms audit, support surfaces)
stays in M7.

**Scope, part 2 — the build.** One production-profile EAS build (`.aab`) pointed at the M1
production origin. Play app created, closed track configured, upload, pass review, invite testers.
`targetSdkVersion` is **already 36** (settled in M1, P2-4), so this build should confirm rather
than discover. Check the merged manifest in the build output anyway — that artifact is the only
definitive proof, and this is the first time one exists.

**What testers get.** A multi-tenant, free, no-paywall, no-quota build. That is fine and expected:
Google requires that a closed test *ran*, not that the tested build was final.

**Tester cost control must be automatic, and only one provider gives you a real ceiling.** M3's
per-user reservations do not exist yet, and a manual kill switch is not a ceiling — twelve engaged
testers running Opus-class analyses over full papers plus TTS can spend faster than anyone notices,
and this milestone still has no authoritative internal cost for the agentic path.

Verified 2026-07-25, and this corrects an earlier draft of this plan:

- **OpenRouter — genuinely hard.** A per-key credit limit is enforced *before* the request reaches
  the upstream provider, so an exhausted key costs nothing further
  ([API credit & rate limits](https://openrouter.ai/docs/api_reference/limits)). One caveat: the
  check is per request, so a burst of simultaneous requests can overshoot slightly. Set the limit
  below a number you would accept losing outright.
- **OpenAI — one of the two "spend limits" is hard; use that one.** The *dashboard* project/org
  monthly budget is a **soft alert** — requests keep being processed past it. But the **Admin API
  spend-limit resource has an enforcing mode** that returns `429 insufficient_quota` once reached
  (subject to slight propagation overshoot), and that is the strongest provider-side control
  available. Set it, then **verify it actually blocks** with a deliberate small-limit test. Keep a
  prepaid balance with auto-recharge disabled as belt-and-braces. See H20.

So the load-bearing control for TTS is one **we** enforce. We hold the only key, so an in-app
ceiling is a real ceiling.

**The model is decided (H22, 2026-07-25, revised same day): `tts-1`.** That settles the accounting
design, and it is the SIMPLER of the two this plan previously weighed. The `-hd` variant was chosen
first and then dropped once the cost analysis showed audio dominates: same accounting, half the
price.

- `tts-1` is priced **$15.00 per 1M characters** (`tts-1-hd` is $30.00), verified against OpenAI's
  live pricing on 2026-07-25. Character pricing means **the cost of a dispatch is exactly known
  before making it**, from the length of the text we are about to send — and it is why switching
  between the two is a pure price change with no accounting rework.
- It returns raw mp3 and supports **no usage payload and no SSE**. Nothing settles afterward, and
  nothing needs to: there is no provider figure to reconcile against, because our own computation
  *is* the figure.

So M3 bills audio as `characters_sent × rate`, charged **per dispatch**, and there is no
reservation/settlement machinery for TTS at all. Two consequences that survive from the earlier
design and still bite:

1. **Retries multiply the billable dispatches.** `tts.py` retries up to `_TRIES` (3) per segment,
   and `except httpx.HTTPError: continue` retries on **any** network error — including a read
   timeout where OpenAI may already have synthesized and billed. So one logical narration can cost
   up to 3 × (number of segments). **Charge per attempt, not per logical operation**, or make the
   retry unambiguous (no retry after a read timeout) and accept the reliability cost. Charging per
   logical operation would under-bill by up to 3×.
2. **Long narrations are many dispatches.** `split_for_tts` splits at `MAX_TTS_CHARS` (3800) under
   OpenAI's 4096 input cap, so the unit to meter is the segment, and the per-user ceiling must be
   checked *between* segments — otherwise a single long narration blows past the cap before
   anything looks at it.

*(Historical note, kept because it explains why this section used to be complicated: the
alternative, `gpt-4o-mini-tts`, is priced on input text tokens **plus generated audio tokens**,
which are not knowable before the call. It would have needed a conservative reservation up front
settled against the usage in its SSE terminal event. Choosing a character-priced model deletes that
whole path. On its deprecation status, OpenAI's model page and its all-models catalog disagree —
the former marks only the `-2025-03-20` snapshot, the latter labels the whole family Deprecated —
so an earlier claim here that "a search summary saying the family is deprecated is wrong" was
overconfident and is withdrawn. Immaterial now: we are on `tts-1`, which the same catalog shows
with no deprecation label.)*

Ship the chosen design in M2.5 as a simplified precursor of M3's reservations, together with
per-user concurrent-job and requests-per-hour caps. `POST /api/speak` is now retired (P0-13).
Note that "authenticate it" was not the fix —
every `/api/*` route is already behind the auth middleware; the gap is that it accepts
arbitrary-length text and fans it into many paid calls with no budget gate at all. Test that the
configured maximum genuinely cannot be exceeded.

**Risks.** Any later native-module addition (RevenueCat, M4) means a new build for testers — fine,
and it does not reset the 14-day opt-in clock as long as testers stay opted in. Data safety answers
must be revised whenever data handling changes (M3 usage events, M5 billing), and a mismatch
between the form and the privacy policy is a common rejection cause.

**Files/services.** `mobile/app.json` (`extra.apiBaseUrl` → M1 origin), `mobile/eas.json`; new
compliance routes/screens; hosted policy pages; Play Console configuration.

**Tests.** Build installs from the closed track on a clean device and completes a real turn against
the hosted backend. Two tester accounts cannot see each other's data. Report action persists.

**Rollback.** A closed track is invisible to the public and can be halted at any time.

**Done when.** ≥12 testers are opted in and the 14-day continuous clock is running.

**Human actions.** Finish Play account verification, H8 (create the app, accept agreements), H11
(approve privacy policy + terms), H13 (Data safety declarations), **H20** (provider spend limits —
already required at M1, and doubly so once 12 external testers can spend), H16 (recruit 12+ testers —
the pacing item; start recruiting during M2 so they're ready the day this lands), and H21 extended
with the testers' UUIDs if the allowlist is still the gate.

---

### M3 — Metering, quotas, and abuse controls

**Objective.** Every LLM call is attributed to a user, priced, and bounded by a hard ceiling.

**Rationale.** P0-4, P0-5, P1-3. Your marginal cost is Opus-class analysis over full paper text plus
TTS plus graph builds — dollars per paper. A subscription without hard caps is an open-ended
liability, and a compromised or looping account is a denial-of-wallet event.

**Scope.** **First, fix agentic cost attribution (P0-5).** Note the existing `reconcile` hook
(`usage.py:194`) is *not* usable as-is, contrary to the first draft of this plan: the agentic path
writes a single aggregate pending marker with `generation_id=None` for a run of up to 12 provider
requests (`agent_harness.py:96`), and `reconcile()` returns early on a falsy id (`usage.py:203`).
There is nothing to reconcile *against*. So the fix is one of: capture every agentic request's
generation id at the transport layer and emit one pending event per generation (then
generation-stats polling can resolve each), or route the agentic path through a client that
preserves OpenRouter's authoritative `cost`. Nothing else in this milestone is trustworthy until
turns are priced.

**Implementation status (2026-07-31): in review.** The chosen path is Pydantic AI's native
`OpenRouterModel`: `openrouter_usage.include` requests authoritative cost, captured
`ModelResponse`s preserve both that cost and `provider_response_id`, and accounting emits one
ledger call per provider request. The aggregate fallback remains only for injected/non-OpenRouter
models and failures before a provider response is captured. Unit coverage asserts exact cost over
a multi-request tool loop, no duplicate aggregate, a generation-specific pending fallback, and an
unestimated ledger on the exact path.

**Speech-accounting status (2026-07-31): stacked implementation in review.**
`tts.openai_speech` is now the single dispatch meter: accepted responses produce exact
character-priced `speech_synthesis` cost for `tts-1`/`tts-1-hd`; a transport-ambiguous attempt is
charged conservatively and marked estimated, while an explicit provider rejection is unbilled.
An unpriceable model remains explicitly pending/estimated. Audio workers rebind the initiating
project around synthesis instead of leaking cost into their `user:<hash>` registry scope. The
provider/route inventory and next enforcement sequence now live in
`04-ai-costs-quotas-and-abuse.md`.

**Paid-route consolidation status (2026-07-31): stacked implementation in review.** Both shipped
clients already used background retrieval, chat-turn, and audio jobs. Their unused declarations
and the backend's blocking/SSE compatibility routes are now removed, including `/api/speak` and
`/api/narrate`. An enumeration regression asserts the retired routes stay absent and every paid
workflow retains its job entry point. This closes invariant 1/P0-13 without waiting for—and creates
one authoritative seam per workflow for—the reservation layer.

**Second, inventory every provider-spend entry point — "LLM calls" and "job-creating routes" do
not cover them (P0-13).** The inventory is now recorded in
`04-ai-costs-quotas-and-abuse.md`. Before the speech-accounting slice, `tts.py` never touched
`usage.py`, so *all* OpenAI speech spend was invisible; and `POST /api/speak` synthesized arbitrary
caller-supplied text synchronously, outside the job framework entirely. `/api/narrate` and the
plain/SSE turn-delivery paths in `routers/session.py` were likewise paid work outside
`JobRegistry`. They are now retired; TTS is metered as a first-class operation and all surviving
paid entry points are background jobs. The next slice puts those job seams behind the same
ownership + rate-limit + reservation guard.

**Speech-accounting status (2026-07-31): stacked implementation in review.**
`tts.openai_speech` is now the single dispatch meter: accepted responses produce exact
character-priced `speech_synthesis` cost for `tts-1`/`tts-1-hd`; a transport-ambiguous attempt is
charged conservatively and marked estimated, while an explicit provider rejection is unbilled.
An unpriceable model remains explicitly pending/estimated. Audio workers rebind the initiating
project around synthesis instead of leaking cost into their `user:<hash>` registry scope. The
provider/route inventory and next enforcement sequence now live in
`04-ai-costs-quotas-and-abuse.md`.

**Paid-route consolidation status (2026-07-31): stacked implementation in review.** Both shipped
clients already used background retrieval, chat-turn, and audio jobs. Their unused declarations
and the backend's blocking/SSE compatibility routes are now removed, including `/api/speak` and
`/api/narrate`. An enumeration regression asserts the retired routes stay absent and every paid
workflow retains its job entry point. This closes invariant 1/P0-13 without waiting for—and creates
one authoritative seam per workflow for—the reservation layer.

**Append-only event status (2026-07-31): stacked implementation in review.** `rc_usage_events`
records the verified `(user, project)` scope, operation/model, tokens, integer nano-USD cost,
generation id, estimated/pending state, and timestamp without storing any prompt or response
content. Provider generation ids make retries idempotent; reconciliation appends exact usage beside
the pending marker rather than rewriting history. Ordinary project deletion retains historical
cost, account deletion cascades it, and the automatic `rc_*` Data API lockout covers the table.
The existing project aggregate remains an independent presentation cache.

**Durable reservation foundation status (2026-07-31): PR #316, ready for review.**
`rc_usage_reservations` serializes admission on the account row and sums active maxima plus settled
actual cost inside the same transaction. It locks/proves the live `(user, project)` row, derives
the current UTC month server-side, refuses on store ambiguity, and persists explicit
`reserved → settled | released | expired` states with a lease and pre-dispatch marker. Once marked
possibly dispatched, schema and code both forbid release; stale work must reconcile through its
bounded per-dispatch attempt rows (including OpenRouter generation links) *and* a durable
all-dispatches-complete marker, or settle conservatively to the reserved maximum. This slice
defines the crash-safe persistence contract; paid-work integration and actual tier amounts are
still next, so it does not yet close the zero-rate-limit finding.

**Reservation reconciliation status (2026-07-31): stacked implementation in review.** A bounded
startup monitor expires only never-dispatched leases. Completed OpenRouter dispatch sets can recover
pending exact cost through the provider's generation-metadata endpoint; incomplete dispatch sets,
missing generation evidence, and providers without per-request recovery settle conservatively to
the reserved maximum. A metadata outage leaves that maximum reserved for a later retry. The lookup
sends only the durable generation id and never requests stored prompt/completion content. Each
snapshot candidate is re-checked under its row lock, preventing a concurrent lease renewal from
being reconciled as stale.

**Exact-once job admission status (2026-07-31): stacked implementation in review.** `JobRegistry`
now has an outside-lock durable preparation phase that runs once only when it creates a new job.
Identical callers wait and join the published worker instead of taking a second reservation;
unrelated polling and jobs remain unblocked. Preparations count as active work for destructive
drains, deletion/busy gates are re-checked after database I/O, and publication or thread-start
failure rolls preparation back. This is the shared concurrency seam; provider-specific maxima and
route wiring remain the next slice and do not require choosing actual tier amounts.

**Emergency spend-stop status (2026-07-31): stacked implementation in review.** The live-read
`RC_PROVIDER_SPEND_DISABLED` switch is enforced immediately before raw and Pydantic OpenRouter,
OpenAI speech, Firecrawl, OpenAlex, and Semantic Scholar network dispatches. It leaves cached/local
work available and treats every non-empty value except an explicit false spelling as disabled, so
an operator typo fails toward no spend. This independent incident brake requires no H15 tier value
and does not replace the per-account reservation ceiling.

**Audio-cache eviction status (2026-07-31): stacked implementation in review.** Derived narration
and preview mp3s now use successful reads as their LRU clock and enforce both a 2 GiB per-user and
8 GiB instance-wide bound after writes. The finite defaults are operator-configurable; invalid
values do not disable eviction. In-flight synthesis and response files are protected, while
symlinks and non-cache files are never candidates. This closes P1-1/P1-14 without changing the
per-user ownership decision or deleting any human-approved record.

**Prompt-injection hardening status (2026-07-31): stacked implementation in review.** Paper full
text, assembled notes/abstracts/citation metadata, titles, and web/tool results now arrive as typed
untrusted-data JSON envelopes, so forged role text or end markers stay inside one escaped content
field. Every Pydantic tool agent receives a fixed policy after operator-editable guidance that
treats imported content as evidence only and forbids prompt/private-context egress through tool
arguments. The user-authored, versioned reading method deliberately remains instruction. Search/
fetch inputs are shape-bounded and URL credentials are refused. The complete tool egress inventory
is recorded in `02-security-and-privacy.md`; all model-selected direct fetches still converge on
`safe_fetch`. This is explicit defense in depth, not a claim that prompt wording can sandbox a model.

**Second, inventory every provider-spend entry point — "LLM calls" and "job-creating routes" do
not cover them (P0-13).** The inventory is now recorded in
`04-ai-costs-quotas-and-abuse.md`. Before the speech-accounting slice, `tts.py` never touched
`usage.py`, so *all* OpenAI speech spend was invisible; and `POST /api/speak` synthesized arbitrary
caller-supplied text synchronously, outside the job framework entirely. `/api/narrate` and the
plain/SSE turn-delivery paths in `routers/session.py` were likewise paid work outside
`JobRegistry`. They are now retired; TTS is metered as a first-class operation and all surviving
paid entry points are background jobs. The next slice puts those job seams behind the same
ownership + rate-limit + reservation guard.

Append-only `usage_events` (user, project, operation, model, tokens, nano-USD cost, timestamp,
generation id) now write alongside the existing aggregate.

**Rate-limit status (2026-08-06): implemented.** `app/rate_limits.py` enforces two independent
per-account ceilings — a sliding requests-per-minute window and a concurrent-jobs cap — at the
`JobRegistry` seam, so a new paid entry point is covered by construction instead of by remembering
to add a check. Registries carry a `metered` flag: the eight user-initiated paid entry points
(chat, notes, retrieval, audio, discover, graph-build, lab-research, author-profile) are metered,
while follow-on work a turn spawns internally is deliberately exempt — it was authorized when its
parent was admitted, and counting it would let one legitimate turn throttle the account that asked
for it. The check sits after dedup, so **joining a running job never consumes budget**; a client
polling its own in-flight request cannot rate-limit itself out of its own result. Refusals surface
as 429 with an honest `Retry-After`, handled centrally so a future paid route cannot return 500
instead. Limits are in-process (invariant 6) and reset on restart, which is right for a burst
bound and wrong for a budget — budgets are the durable reservations, kept separate per rule 5.

Two findings from that PR's independent review are recorded rather than built, both deliberate:
a cross-registry **TOCTOU** in the concurrency count is real in principle (each registry lock is
taken separately, never one atomic snapshot) but was not reproducible under a deliberate stress
test — 40 registries, a release barrier, a widened GIL switch interval, 30 trials, zero
violations — and it errs toward mild overspend rather than false blocking, which is the direction
the risk section prefers; it becomes real only if invariant 6 is ever relaxed. And the **mobile
client does not act on `Retry-After`**: it does surface the server's `detail`, so a refusal is
explained rather than silent, but there is no automatic retry-after-the-window.

**Still open in this milestone.** Daily and monthly quotas by tier. **Pre-spend reservations per
architectural rule 5** — atomically reserve a pessimistic maximum against the user's remaining
budget before admitting work, settle to actual cost when it finishes, release on failure; a
reservation that cannot be taken (or a quota store that is unreachable) refuses the work rather
than letting it through.

**Read that literally: the reservation ceiling is not connected yet.** `app/quotas.py` is complete
and tested, `start_or_join`'s `prepare_new` hook exists precisely to hold it, and
`quota_reconciler` sweeps orphans — but as of 2026-08-06 `quotas.reserve` has **no caller outside
the test suite**, and nothing passes `prepare_new`. So today a signed-in account is bounded by
ownership, the rate ceilings above, and the instance-wide emergency stop, but **not** by a spend
ceiling of its own. `spend_control`'s docstring calls per-user reservations "the normal ceiling",
which is the intended end state rather than the current one. Wiring `prepare_new` to `reserve` at
the eight metered seams is the next slice, and it is what makes "no single account can exceed its
ceiling" true.

**Reservations need a crash lifecycle, defined here rather than assumed.** Jobs live in memory
(invariant 6) but reservations live in Postgres, so a process death between reserve and settle
leaves an orphan that would permanently consume a customer's quota — and blindly releasing orphans
on boot would instead under-count real spend that already happened upstream. Specify: durable
reservation ids, explicit states (reserved → settled/released/expired), a lease with expiry,
linkage to the job and to any generation ids issued under it, and an **idempotent startup
reconciliation**. M6 consumes these same records when it marks interrupted jobs.

**Settlement is provider-specific — one strategy does not cover both.**

- *OpenRouter (LLM):* each call has a generation id, so an orphan can be resolved authoritatively
  by querying generation stats. This is the path the pending/`reconcile` machinery was designed for.
- *OpenAI (TTS):* **nothing to reconcile, by construction.** With `tts-1` (H22) the price is
  `characters_sent × rate`, so the ledger computes the exact figure at dispatch and no provider
  number is ever needed. Do not build reconciliation for audio. The one ambiguity is a dispatch
  that may or may not have been billed — a read timeout where OpenAI synthesized anyway — and the
  safe treatment is to charge it: over-counting a possibly-billed attempt beats silently losing
  spend, which is the property that matters for a ceiling. (The provider usage API could not settle
  this anyway: it reports aggregated time buckets by project/key/model, with no per-request id.)

An instance-wide kill switch. Soft warnings at 80%.
Max-token and timeout caps per operation. ~~Audio cache eviction with an LRU/size bound (P1-1).~~
~~Prompt-injection hardening on the tool loop (P1-4): explicit provenance framing for paper text,
tool-call budget already in place, plus an egress review covering **every** outbound-fetch path,
not just `web_fetch` — the retrieval path was the one missing its guard entirely (P0-14, closed in
M1), so the review's job is to confirm no third path exists rather than to re-check the one that
was already guarded.~~

**Files/services.** New `app/metering.py`, `app/quotas.py`; `app/usage.py`, `app/llm.py`,
`app/agent_harness.py`, `app/jobs.py`, `app/audio_jobs.py`, `app/research_tools.py`; all
job-creating routers; new `docs/production/04-ai-costs-quotas-and-abuse.md`.

**Risks.** A quota bug that blocks legitimate paid users is worse than a mild overspend — fail
toward a logged soft-warning on ambiguity, but never on the hard ceiling. Keep the two mechanisms
distinct (rule 5): **analytics** recording stays best-effort and never fails a turn, preserving the
existing `usage.py` discipline; **reservations** are authoritative and fail closed. Conflating them
is what makes a ceiling unenforceable.

**Tests.** Cost recorded for both agentic and single-shot paths, with no `estimated` flag on the
default path. TTS spend appears in the ledger. **No endpoint can initiate paid work without
passing ownership, rate-limit, and reservation checks** — enumerate the surviving job routes and
assert it per route; retired compatibility routes must remain absent. Quota exhaustion returns a
clean, actionable error.
Rate limiter under concurrency. **Concurrent admission cannot collectively exceed the ceiling** —
the race the reservation design exists to close, so test simultaneous admissions, not sequential
ones. Quota store unavailable ⇒ paid work refused. **Kill the process immediately after admission,
and again mid-provider-call, and assert startup reconciliation neither strands the quota nor
under-counts the spend.** Cache eviction respects the bound. Per-user attribution correct inside
job threads *and* inside nested graph/affiliation workers (rule 3).

**Manual.** Drive a real account to its quota on staging and confirm the client message is honest
and the spend stops.

**Rollback.** Limits are config-driven; set them permissive to disable without a deploy.

**Done when.** Cost-per-user/feature/day is queryable, no unpriced default-path call remains, and
no single account can exceed its ceiling.

**Human actions.** Decide the actual tier limits — needs your real cost-per-paper numbers, which
this milestone's event data produces. Expect to set them provisionally and revise at M10.

---

### M4 — RevenueCat foundation

**Objective.** Products, entitlements, and a stable cross-platform identity, with sandbox purchases
working.

**Scope.** RevenueCat project and Play app configuration. Entitlement (`pro`), Offerings, monthly
and annual packages. `react-native-purchases` in the Expo dev-client build (native module — already
supported, `expo-dev-client` is in place). **App User ID = Supabase auth UUID**, never email.
Login/logout/account-switch identity handling. Restore Purchases. Paywall via the current Offering
rather than hardcoded product logic. Evaluate the official RevenueCat MCP for agent-operable
configuration, scoped least-privilege and documented without credentials.

**Files/services.** `mobile/package.json`, `mobile/app.json`, new purchase/paywall modules under
`mobile/src/`; new `docs/production/03-monetization-and-entitlements.md`.

**Risks.** Play Billing Library version must be currently supported — Google's deprecation schedule
retires Billing 7 for new apps/updates on **2026-08-31**, so verify the transitive version
RevenueCat ships at implementation time rather than trusting this note.

**Tests.** Identity stability across login/logout/switch. Restore on a fresh install. Offering
fetch failure degrades gracefully.

**Manual.** Sandbox purchase of both packages on a real device via the internal track.

**Rollback.** Paywall behind a flag; entitlement checks default closed but the app remains usable
on the free tier.

**Done when.** A sandbox purchase grants the entitlement and survives reinstall via Restore.

**Human actions.** Create the RevenueCat account; create the Play app; accept Play agreements;
complete tax/banking setup; generate the Play service credential; author store product IDs.

---

### M5 — Subscription-backed access

**Objective.** Server-side entitlement enforcement with a reconciled, idempotent projection.

**Scope.** RevenueCat webhook endpoint — authenticated per current RevenueCat guidance, idempotent
on event id, tolerant of duplicate and out-of-order delivery, handling expiration/refund/
cancellation/grace/billing-retry. Normalized `entitlements` projection in Postgres with documented
source-of-truth rules (RevenueCat is authoritative; the projection is a cache with a reconciliation
job). Wire tier → quota from M3. Customer Center for self-service management.

**Files/services.** New `app/routers/billing.py`, `app/entitlements.py`; `app/quotas.py`;
migrations; mobile paywall and subscription-management surfaces.

**Risks.** Two sources of truth is the classic failure — the projection must be rebuildable from
RevenueCat at any time, and there must be a reconciliation command to prove it.

**Tests.** Duplicate webhook is a no-op. Out-of-order delivery converges. Expiration revokes access.
Refund revokes. Grace period retains access. Spoofed webhook rejected. Entitlement cannot be
spoofed from the client.

**Manual.** Full sandbox lifecycle: purchase → cancel → expire → restore.

**Rollback.** Projection is derived; it can be dropped and rebuilt.

**Done when.** Access is server-enforced, no client claim is trusted, and reconciliation is a
single documented command.

---

### M6 — Durability: job persistence and backups

**Objective.** A restart or crash never silently destroys paid work, and data survives host loss.

**Rationale.** P0-10, P0-11. This becomes a refund-and-support problem the moment money changes
hands. `docs/improvements.md` §1.4 already specifies the job-persistence approach and the unified
`JobRegistry` (§1.1) made it a one-place fix.

**Scope.** Persist job state so an interrupted job is either resumed or reported as failed rather
than vanishing. **Add a graceful-shutdown drain** (found reviewing PR #218): jobs run in daemon
threads and the app has no shutdown hook, so a `fly deploy` — or a Fly host migration, which stops
the machine first — kills in-flight work. `auto_stop_machines = "off"` does not help; it only
disables Fly Proxy's *idle* shutdown. The drain is a FastAPI lifespan hook that stops admitting new
jobs on SIGTERM and waits for tracked workers within the configured `kill_timeout` (raised to the
300s maximum in `fly.toml` so the hook has room). Until it exists the operational rule is: check
for active jobs before deploying. **Reconcile against M3's reservation records rather than inventing a second
lifecycle** — an interrupted job and its orphaned reservation are the same event, and resolving
them separately is how a customer's quota gets stranded or their real spend under-counted. Use the
reservation ids and generation linkage M3 defines. Automated backups of the volume (project git
repos + `.app-state/`) and Postgres, off-host, with a **tested restore**. Retention policy.

**Risks.** Resume semantics for a half-spent LLM turn are subtle — reporting an honest failure with
the partial spend recorded is acceptable and much simpler than true resumption. Prefer that.

**Tests.** Kill the process mid-job; on boot the job is `failed` with its partial usage recorded,
never stuck `running`, **and its reservation is settled to actual spend rather than left reserved
or blindly released**. Restore drill from backup into a clean environment.

**Done when.** A restore has actually been performed, not just configured.

---

### M7 — Remaining compliance, safety, and legal surfaces

**Objective.** Everything Google Play requires that isn't a build artifact and wasn't already
forced forward into M2.5.

**Rationale.** P0-7, P0-8. Several are hard submission blockers. **Note the split:** the privacy
policy, terms, Data safety inventory, in-app AI-content report action, and the account-deletion
workflow all moved into **M2.5**, because a closed testing track requires them. What remains here
is the operator-facing and lower-urgency remainder.

**Scope — only what M2.5 did *not* already ship.** The privacy policy, terms, data inventory,
Data safety answers, account-deletion workflow, and in-app AI-content report action are **M2.5
deliverables** (a closed track requires them) and are deliberately *not* repeated here. What
remains:

- **Support contact** surfaced in-app and in the store listing.
- **Operator review queue** for the content reports M2.5 begins collecting — M2.5 ships the report
  path and somewhere for reports to land; M7 ships the workflow for acting on them.
- **AI-limitations disclaimer** with appropriate UX framing: the product presents model analysis of
  scientific papers and must not frame it as authoritative. Preserve source citations and links.
- **Paper-source terms audit** (P1-7): arXiv, Semantic Scholar, and OpenAlex, for commercial
  storage and redistribution of full text and figures.
- **Extending the M2.5 inventory and Data safety answers** to cover everything added since — M3's
  usage events and M5's billing data both change what is collected, and a mismatch between the form
  and the policy is a common rejection cause.

**Files/services.** New `app/routers/compliance.py`; migrations; both clients (settings/legal
screens, report action); new `docs/production/02-security-and-privacy.md`; hosted policy pages.

**Risks.** The paper-source terms audit could genuinely constrain the product — if commercial
redistribution of extracted full text isn't permitted, caching strategy or tiering may need to
change. Do this audit **early in the milestone**, not last.

**Tests.** Deletion removes every artifact and is idempotent. Report submission persists and
surfaces to the operator queue. Policy links resolve.

**Manual.** Delete a real staging account and verify nothing remains.

**Human actions.** Approve the privacy policy and terms text (legal consequence — yours to make).
Provide a support email. Make the Data Safety declarations in Play Console.

---

### M8 — Observability and operator tooling

**Objective.** The smallest stack that lets you tell within minutes that a release is broken.

**Scope.** Sentry for backend exceptions and React Native crashes. Structured `rc.*` log shipping
from the container. A minimal operator screen (or dashboard queries) covering: AI spend by day and
user, failed jobs, failed webhooks, quota breaches, content reports, deletion requests, subscription
state. Alerts on genuinely actionable conditions only — sustained error spike, webhook failure, AI
cost anomaly, provider outage, budget threshold.

**Risks.** Scrub secrets and paper content from Sentry payloads — the log filter already stamps the
active project; extend the same discipline to redaction.

**Done when.** You can answer "is production healthy and what did it cost today" without SSH.

---

### M9 — Android release automation

**Objective.** A reproducible, agent-operable path from commit to internal track.

**Scope.** EAS production build (`.aab`), signing, version code strategy (`appVersionSource: remote`
already set). `targetSdkVersion` already resolves to 36 (M1, P2-4) and is deliberately left unpinned, so
the **2026-08-31** Play floor needs no action here — re-verify against current documentation at
implementation time in case the floor has moved again. Play service account for EAS Submit. EAS Workflows for CI → build → submit to internal track.
EAS Update policy with runtime versioning and a rollback procedure — deliberately conservative, no
auto-submit on every merge to `main`.

**Risks.** Native module additions from M4 mean dev-client rebuilds — plan a device pass. (CI
billing, formerly a prerequisite here, was resolved as H1 on 2026-07-24.)

**Done when.** `main` → internal track is one documented command, and rollback is documented and
drilled.

**Human actions.** Create/verify the Play developer account; accept agreements; create the app
listing; generate and authorize the service account credential.

---

### M10 — Launch rehearsal

**Objective.** Prove the whole thing before strangers touch it.

**Scope.** Full regression including the E2E scenarios (auth lifecycle, cross-user isolation, quota
exhaustion, purchase/cancel/expire/restore, webhook duplication and reordering, provider timeout,
PDF failure, content report, account deletion, upgrade, OTA rollback). Evaluate Maestro for a small
number of mission-critical mobile flows. Store assets: name, descriptions, screenshots, feature
graphic, icon, content rating, target audience, ads declaration, reviewer credentials. The closed-testing
requirement **applies** (confirmed 2026-07-25) — by this point the 14-day clock should long since
have been satisfied via M2.5, so what remains here is applying for production access and its ≤7-day
review. Rollback drill. Revise M3 quota limits against real observed cost.

**Done when.** No known P0 remains and every launch-ready criterion is met.

**Human actions.** Recruit testers if the closed-test requirement applies; author store listing
copy; final policy attestations.

---

### M11 — Production release

Controlled rollout with staged percentage, active monitoring, and a rehearsed rollback.

---

## Document set

Five living documents plus human actions — deliberately fewer than the external brief's eleven,
because `docs/` already holds 28 files and stale documentation is worse than none. Play, iOS, and
web checklists live inside the milestones that action them rather than as standalone documents.

| Document | Status | Written during |
|---|---|---|
| `00-current-state-audit.md` | ✅ done | now |
| `10-roadmap.md` (this file) | ✅ done | now |
| `HUMAN_ACTIONS.md` | ✅ done | now |
| `01-architecture.md` | queued | M1 |
| `02-security-and-privacy.md` | 🚧 M2.5 code-derived inventory + Data Safety draft written; implementation and M7 expansion open | M2.5, expanded in M7 |
| `03-monetization-and-entitlements.md` | queued | M4 |
| `04-ai-costs-quotas-and-abuse.md` | queued | M3 |

**Rule:** every architecture or configuration change updates the relevant document in the same PR.
These are project memory — a future Claude or Codex session must be able to operate from them
without reconstructing context from chat history.

## Policy verification rule

Store policies change and this plan encodes a July 2026 snapshot. Before implementing or submitting
anything policy-sensitive, check the current official source and record the URL, date checked,
requirement, and implementation impact in the relevant milestone. Do not treat the dates in this
document (API 36 and Play Billing 7 on 2026-08-31; the 12-tester/14-day closed-test rule) as
verified — they are flags to check, and two of them are roughly five weeks out.
