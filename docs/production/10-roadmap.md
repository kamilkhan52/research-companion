# Production launch roadmap

*Written 2026-07-24 against `origin/main` @ `e5fe869`. Evidence base: `00-current-state-audit.md`.
This is the execution ledger — update the Status column as milestones land, same convention as
`docs/product-roadmap.md`.*

**Workflow per milestone:** branch → implement → review → fix findings → PR → merge. Milestones
that change external billing configuration, the production database, or store configuration need
explicit human approval before execution.

**Reviews are Claude's, as of 2026-08-10** — the codex account is out of quota. That changes what
review is worth guarding against, because the two reviewers fail differently: running one model
repeatedly stops questioning the design by about the third pass and starts checking its own
previous fixes. When rounds are limited, spend them on the highest-severity finding and its test,
not on breadth. `AGENTS.md` is the review contract and states what counts as a finding.

**A reviewer's proposed fix is not automatically safer than the code.** On 2026-08-10 a review of
[#350](https://github.com/kamilkhan52/research-companion/pull/350) proposed replacing a threshold
check with one derived from the number already on screen; it would have failed at exactly the
threshold (`0.2 <= 1 - 0.8` is false in IEEE 754) and fired when the allowance was exhausted.
Verify a proposed fix as carefully as the line it replaces.

**Scope of this file:** what is open, and the decisions that bind future work. Completed milestone
detail, dated handoffs, and the R14 device pass moved to [`90-history.md`](90-history.md) on
2026-08-09; the device-test procedure moved to
[`40-device-test-runbook.md`](40-device-test-runbook.md). Device feedback belongs in
[`../device-review-ledger.md`](../device-review-ledger.md), not here.

---

## Current position (updated 2026-10-25)

**Delta at 2026-10-25 — the hosted deployment is shut down.** Kamil had Fly production and
staging stopped on 2026-10-20 and deleted on 2026-10-25: development has slowed, no release is in
sight, and all work is now local on the Mac mini. Both `/data` volumes were backed up and checked
file by file first, to `~/Backups/fly-research-companion-2026-10-25/` on the Mac mini. The
details, and what a relaunch would take, are in `CLAUDE.md` → Environments and deployment. The
remainder of M2.5 and M4–M11 are paused, not cancelled. Supabase was not touched, but staging
Supabase and the Google OAuth client still allow the deleted `*.fly.dev` hosts as redirect
targets (HUMAN_ACTIONS H31).

### Position at 2026-09-29

**Delta at 2026-09-29** (PRs #529–#535 and #536):
- DR-052's surface merge is complete in code: step 3 (#529) moved the unified list under the graph
  and removed the Discover tab; step 4 makes the Map's search box the one query input. The row is
  `implemented — verify`; the open device question is the graph-pan versus page-scroll boundary.
- Three papers were filed with another paper's full text in two days. #533 guarded the
  rate-limit fallback and the PDF hunt, #534 guarded the ordinary title search and added
  **Reset fetched text** (DR-165, DR-167). `retrieved` now means "has text".
- DR-164 (#532): Discover screening reads model answers by content; a year can no longer become
  a 10/10 score. DR-096 is back to `partial`: an explicit query must outrank project context,
  and that weighting is not built.
- DR-166 (#530): a narration that comes back under 60% of its source is narrated once more.
- DR-141 (#535): reference extraction sent only the first 120,000 characters, so long papers
  (DeepSeek-V4.1-Flash, Llama 2, GPT-3, PaLM, T5) never had their reference list read.
- DR-161: Kamil decided the single name is **Seminar**; the consistency pass is not started.
- The device ledger has 167 rows: 108 `implemented — verify`, 44 closed, 7 partial, 4 open, 2 planned, 2 deferred.
- Not determined: why an overnight map build did not finish (2026-09-23). Builds are in-process
  and die with any server restart; M6 owns job persistence.

### Position at 2026-09-19


**Delta at 2026-09-19** (DR-160/DR-162 and DR-052 surface work in
[#526](https://github.com/kamilkhan52/research-companion/pull/526) and
[#527](https://github.com/kamilkhan52/research-companion/pull/527), with DR-052 staging in
[#528](https://github.com/kamilkhan52/research-companion/pull/528) and
[#529](https://github.com/kamilkhan52/research-companion/pull/529)):
- PR #524's September 15 feedback triage and PR #523 / DR-159 are reviewed, merged, and deployed to
  both the server and device worktrees. DR-159's notes conflict now preserves both the newer notes
  and retained proposal through explicit recovery.
- DR-133's narration-follow refinement and DR-158's explicit current-sentence rail jump are
  implemented together in [#525](https://github.com/kamilkhan52/research-companion/pull/525):
  playback-gated gentle following, a reduced-motion-aware highlight fade, one rail-owned navigation
  surface, and an explicit centered return to the sentence being narrated.
- Five new September 15 bubble entries reconcile to three rows: DR-160 is one malformed-PDF-text
  defect shared by arXiv fetch and upload; DR-161 is the deliberate product/agent naming decision;
  and DR-162 is the related-work reading offer's copy reduction.
- DR-160 is fixed at the shared PDF-extraction boundary: pypdf's two lone `U+D835` surrogates are
  replaced before persistence, valid pairs remain intact, and the strict UTF-8 writer is unchanged.
  Both the arXiv and upload job paths pin the exact Stratum-shaped failure.
- DR-162 reduces both related-work reading-offer surfaces to the requested singular/plural
  **Seminar would like to read…** sentence; the visible rows and actions retain the mechanics.
- DR-052 surface staging step 1 puts query-ranked Discover matches and the Map's existing
  project-ranked recommendations behind one list, de-duplicated without blending score scales and
  with explicit per-row provenance. Step 3 moves that list and paid query below the graph, removes
  the duplicate Map sheet and visible Discover tab, redirects old entry points to Map, and retains
  independent controls for simultaneous graph-build and Discover jobs. Step 4's shared input and
  graph highlighting remain, so DR-052 stays `partial`.
- The live device ledger now has 162 rows: 103 `implemented — verify`, 44 closed, 7 partial, 4 open,
  2 planned, and 2 deferred. Device acceptance remains the active bottleneck.

## Position at 2026-09-13 (superseded by the block above)

**Delta at 2026-09-13** (live repository audit at `5641bd4`):
- `main` and `origin/main` are aligned, the server and device worktrees are deployed to the same
  commit, and no PR, background job, or dispatch is active. PR #521 / DR-157 is the latest merge;
  deployment is complete but physical-device acceptance remains open.
- Five September 10 device entries are now the active implementation queue: DR-133's narration
  follow refinements, DR-158's rail jump to the currently narrated sentence, and DR-159's stale
  notes-proposal conflict. The two new-item entries become DR-158 and DR-159; the three DR-133
  remarks remain on that existing row.
- DR-052's remaining surface decisions are settled: one input filters graph nodes while typing and
  starts paid Discover only on submit; concurrent Map/Discover jobs retain independent status and
  Stop controls; query-ranked results lead graph-derived recommendations with provenance per row;
  and the first combined release keeps the **Map** tab name. Kamil confirmed all four answers
  directly in chat on 2026-09-13.
- **M4 remains blocked only on H8's Google Payments merchant profile.** The live device ledger has
  159 rows: 98 `implemented — verify`, 44 closed, 8 partial, 5 open, 2 planned, and 2 deferred.
  Device acceptance remains the active bottleneck.

## Position at 2026-08-31 (superseded by the block above)

**Delta at 2026-08-31** (one bubble item, two PRs #463/#464; milestone position unchanged, M4
still blocked only on H8's merchant account):
- **DR-112 — affiliations now show on Discover cards.** The data was already produced and already
  on the wire; only the card never drew it. Kamil's assumption that it also feeds RANKING is
  false and deliberately so: `score_abstracts` excludes it because the OpenAlex authorship call is
  deferred until after screening (~60 papers instead of thousands), and `score_candidates`, the
  one function that ever put affiliations in a prompt, is dead code called only by tests. Half the
  rows legitimately carry none — OpenAlex returns their authorships with empty affiliation
  strings — so the card has an explicit absent state. "Rank by affiliation" is a costed design
  change, not a wiring-up.
- **DR-113 — one paper was being listed twice, and the other copy discarded.** Three independent
  identifier mismatches each made `merge_candidates` call one paper two: an arXiv DOI vs a
  publisher DOI, `v2` vs the bare id, and — the one that produced Kamil's actual duplicate — DOIs
  arriving from OpenAlex as `https://doi.org/…` URLs while the comparison used the bare form. The
  row kept apart then re-registered the incumbent's keys and took an `order` slot resolving to it,
  so the list materialised one object twice. Measured against the pre-fix helper, **110 of 120**
  orderings of a five-row set produced that. A row kept apart now also gets its own
  `candidate_id`, or the client's duplicate guard would have deleted the very paper the split
  preserved. The client collapses repeats at render too, because results already on disk still
  hold them and a fresh Discover run costs real money.
- **DR-114 opened** (found by property-testing, not reported): a title-only match can absorb
  another paper's arXiv id, producing a card whose title and abstract are one paper's and whose id
  is another's — **Add-to-library from that card fetches the wrong PDF**. ~1 in 6 orderings,
  pre-existing, pinned as a strict xfail rather than a comment. The fix changes what an alias
  match may contribute to a cluster's identity, so it earns its own change and device pass.
- **Process note**: three Opus review rounds on #464 each found something real (the URL-form DOI
  case, a shared `candidate_id`, a DOI comparison that discarded the registrant prefix and would
  have merged two different papers). The review gate is earning its cost.
- **Local full-suite red is not always a signal**: `test_affiliation_jobs.py::test_retrieval_
  affiliation_job_caches_and_ranks_the_top_two` fails in a full local run on clean `main`, and
  passes in CI and in isolation. Its `_wait` helper already polls every 10 ms; what it cannot
  survive is its 3-second DEADLINE, which a machine running the rest of the suite can exceed
  before the job thread is scheduled. Worth raising (or making env-tunable) in its own PR — not a
  rewrite of the wait, which is already the right shape.
- **82 ledger rows at `implemented — verify`** (21 closed, 1 open, 5 partial, 3 planned, 2
  deferred; 114 total) — device acceptance remains the bottleneck.

## Position at 2026-08-26 (superseded by the block above)

**Delta at 2026-08-26** (device-feedback cleanup; milestone position unchanged):
- **The open bubble backlog is clear.** DR-090 had already shipped in #433 but its ledger state
  was stale. DR-106/DR-111 landed in #460: the proposal card labels its request summary honestly,
  and applied Paper Notes proposals self-heal without consuming relocation queues. DR-109 landed
  in #461: inline formulas use reflow-safe native text with readable TeX conversion, while display
  equations retain MathJax SVG rendering.
- **80 ledger rows are at `implemented — verify`** (21 closed, 0 open, 5 partial, 3 planned,
  2 deferred) — physical-device acceptance remains the bottleneck.

**Delta at 2026-08-24** (a device-feedback day — four PRs #454–#457, all merged; the milestone
picture is unchanged, M4 still blocked only on H8's merchant account):
- **Eleven bubble entries triaged** (#454): DR-098 reopened by a fail, six new rows DR-103–DR-108,
  and every one answered in the bubble.
- **DR-098 round 2** (#455): the round-1 split fired ONCE at the top level, so a still-over-wide
  line dropped to the scroll strip (measured: 540px and 615px remainders in a 364px column).
  Splitting is now tiered and recursive — arrows → relations → top-level `+`/`-` → argument
  commas, with `\right.`/`\left.` rebalancing — and the tests assert the property (every line
  fits, measured with the app's own MathJax) rather than a fixed set of break points.
- **DR-104 + DR-107** (#456): citation targets now carry the work's full title (prompt AND the
  client, which was discarding the target in favour of the short label); a 200 carrying no
  completion is retried like a 5xx, metered before it is discarded, and logged by SHAPE — the
  Finish failure Kamil hit had no diagnostics at all.
- **DR-103/105/108 + DR-110** (#457): the notes indicator moved below the answer; the comment tray
  collapses to an "N comments" pill; the mini player gained sentence jumps; the top-bar marquee
  moved to the UI thread (DR-101's lesson again — a JS-callback reset is lost under load); and a
  sentence boundary inside inline markup no longer splits a span in half, which was making a
  commented response lose its formatting.
- **Two defects found by verification, not by Kamil**: DR-109 (inline math drawn over its
  neighbouring words — not reproducible on demand, recorded with evidence) and DR-110 (fixed
  above).
- **Still never measured**: a real production Discover run against the DR-052 + DR-096 lanes.
  Needs Kamil's go-ahead — it spends real money on the production account.
- **76 ledger rows at `implemented — verify`** (21 closed, 3 open, 5 partial, 3 planned,
  2 deferred) — device
  acceptance remains the bottleneck.

## Position at 2026-08-22 (superseded by the block above)

**Delta at 2026-08-22** (a device-feedback day — ten PRs #441–#450, all merged; the milestone
picture is unchanged, M4 still blocked only on H8's merchant account):
- **The DevTest bubble's Claude dispatch works end-to-end.** The first real dispatch was
  sandbox-mute and opened #441 itself (inbox `--add-dir` + the skill's tool allowlist); its
  second run shipped #446 autonomously (DR-097 + DR-091 round 2). Replies now reconcile:
  phone-raised `NEW-…` items fold into their DR rows (DR-097 — before this, every
  `append_response` to a DR id was invisible on a phone-raised item).
- **Kamil's biggest device pass: 15 rows closed** (#442). New rows DR-096–DR-101 all shipped
  same-day: grounded Discover query plans (#444), on-demand figure manifests at chat-turn
  start (#446), multi-line wrapping for over-wide display math (#447, DR-098), figure-image
  skeletons (#448, DR-099), transcript first-paint — profile-driven list tuning + skeleton
  held to the list's first viewable item (#449, DR-100; research + deferred levers in
  `docs/transcript-first-paint.md`), and the skeleton pulse itself (#450, DR-101 — RN
  Animated's loop is JS-orchestrated and froze under load; skeletons now pulse via Reanimated
  on the UI thread, and the discussion skeleton is long-form prose, not chat bubbles).
- **DR-089 (scroll during streaming) FIXED** (#443): the streamed reveal pauses while the
  reader is scrolled up — content pinning, after two instrumented viewport-correction designs
  lost to the inverted list. DR-043's silent menu taps fixed in the same PR.
- **Still never measured**: a real production Discover run against the DR-052 + DR-096 lanes.
- **69 ledger rows at `implemented — verify`** (21 closed, 1 open, 5 partial) — device
  acceptance remains the bottleneck.

**Delta at 2026-08-21** (a heavy device-feedback + feature session; nothing below changed the
M-milestone picture — M4 is still blocked only on H8's merchant account):
- **DR-052 (Map/Discover merge) is COMPLETE** — all four PRs merged (#407/#409/#431/#432/#436).
  See `corpus-neighbourhood-spec.md` §7. Never measured against a real production Discover run.
- **A per-paper reference graph shipped** (#437, DR-093): a readable ego view (paper centred,
  references left, citers right) reusing the Map canvas, replacing the old "open the full Map"
  behaviour of a paper's Reference-graph action.
- **The Seminar rename finished**: in-app strings (#426), legal pages (#427), and the new
  **"Quiet Aperture" app icon** (#438, DR-094 — needs a dev-client rebuild to see).
- **The immersive discussion canvas merged** (#413, DR-095) after two days of device preview.
  **DR-089 (chat scrolls during streaming when scrolled up) merged UNFIXED and now targets
  main** — the next known UI fix (an explicit viewport-pin guard).
- Also merged: arXiv SVG figures (#434, DR-091), Claude-dispatch from the DevTest bubble
  (#435, DR-092 — tailnet/loopback-only, an RCE gate caught in review), Continue-Reading
  stale-title fix (#433, DR-090).
- **Repo hygiene**: 317 stale remote branches + all local leftovers deleted; remote is now
  `main` only; the sole worktree is `device-main` (Metro 8081 serves it, so the phone gets the
  full merged state). Deleted-branch SHAs recorded in the session scratchpad as a recovery net.
- **~45 ledger rows sit at `implemented — verify`** — device acceptance, not code, is the
  standing bottleneck.

**Delta since the 2026-08-10 write-up below** (accurate for its date):
- **M3 closed fully on 2026-08-14** — web-search metering was the last seam (detail below,
  dated 2026-08-12, and §8.4 of the pricing analysis).
- **M4 is in progress and blocked on exactly one thing that is Kamil's**: the Google Payments
  merchant account (H8). The client foundation (RevenueCat SDK, identity, paywall behind a
  flag) merged 2026-08-14 (#405); the Play app exists as **Seminar** (`io.scholiast.seminar`,
  created 2026-08-18 — the app was renamed; the company stays Scholiast, see #414 and DR-086).
  H9 (authoring the $10 Basic / $25 Pro products) is agent-doable once the merchant profile
  exists.
- **`pydantic-ai-slim` is pinned `<2.3`** after an unpinned CI resolve turned main red on
  2026-08-19 with no code change (spend-ceiling hooks reach into pydantic-ai internals; a turn
  would have settled at its MAXIMUM). Upgrading is deliberate work, never a fresh-install
  side effect — see CLAUDE.md's dev-workflow note.
- **DR-052 (Map/Discover merge) PRs 1–2 merged** (#407, #409); PRs 3–4 (lane-1 significance,
  client convergence) are next in that track.

**The 2026-08-10 position:**

**M1 is complete and production is LIVE, running Kamil's real corpus.**
`https://research-companion.fly.dev` in `sjc`: volume attached, database connected, all migrations
applied, tenancy lockout verified against the live schema (RLS on, 0 policies, 0
`anon`/`authenticated` grants), two accounts allowlisted, five of his projects imported with full
git history, and his own prompt overrides and model picks in place. H26/H27/H28 are all
closed.

**M2.5 is code-complete and the app is in continuous production-device review.** What gates the
AAB is Kamil's sign-off plus H13, followed by the first production-profile build. Uploading before
there are testers does not bank closed-test time. (It does NOT freeze the package name either —
that belief was refuted on 2026-08-18: Play binds the package permanently when the app is
CREATED. See H8. The conclusion is unchanged and stronger — an early upload buys nothing.)

**Fifteen reviewed PRs had accumulated unmerged since 2026-08-01** in two independent stacks; both
landed on 2026-08-05. Discovery: **#310** cooperative Stop, **#311** slice 2, **#324** the
device-review ledger. M3: **#312**–**#323** — exact-cost
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
4. **M3 enforcement landed across 2026-08-06 to 2026-08-09 in #325–#329**, closing what point 4
   used to describe as the remaining gap. Per-account rate limits (**#325**), the spend ceiling
   actually connected — reserve on admission, settle to actual (**#326**), per-call token and
   timeout ceilings (**#327**), named plans with `tester` as the default at 5,000 credits
   (**#328**), and the metering of paths that held budget while charging nothing (**#329**).

   Three things in that stack are worth carrying forward as lessons rather than line items. Spend
   escapes through **unenumerated seams** — a pool thread, a registry hop, a partially-bound worker
   — and binding a subset of contextvars fails OPEN, so `config.bound_scope` carries project, user
   and reservation together or not at all. A job that loops cannot be gated by its admission ticket
   alone, which is why `spend_ceiling.per_unit` exists and why the graph build's per-paper gating
   became the pattern for labs-per-author and the retrieval hunt. And **#329 uncovered a production
   defect unrelated to spend**: `AgentRunResult.usage` became a property in pydantic-ai 2.x, and
   because the call sat inside `lab_research`'s own `try`, every Labs pass had failed silently
   since 2026-07-17 — see DR-008 in `docs/device-review-ledger.md`.

   **Deployed to staging and production on 2026-08-09** (`03c1c87`). Code-only — 0007/0008 were
   already applied — and verified on both: health 200, `/api/plan` answering 401 rather than 404
   (so the new routes are live, not a stale image), and the data-API lockout asserting on 10/10
   tables.

   **#329 took ten review rounds**, and the shape of that is worth recording because it will repeat.
   Five Opus passes converged on "mergeable"; GPT-5.6 Sol then found two P1s immediately, and four
   more over the next three passes. Running one reviewer repeatedly stopped being useful around
   pass three — later passes were checking whether the previous pass's fixes were right rather than
   questioning the design, and it took a different model to ask whether `per_unit` was papering
   over the fact that admission and per-unit gating are two mechanisms wearing one name. **Switch
   reviewers before running the same one a fourth time.**

   The other repeated lesson: three separate times a fix introduced an OVER-charge that no test
   caught, because the tests all drove failure paths and none drove a successful one. The worst
   would have settled every streamed turn at its maximum — $0.15 for a $0.004 turn, a Tester's
   whole month in thirty-three turns. **A bound needs a test proving the ordinary case still
   passes through it**, not only that the exceptional case is caught.

   **M3 is functionally complete as of 2026-08-10.** The plan/usage surface shipped in
   [#336](https://github.com/kamilkhan52/research-companion/pull/336) and was reframed to show what
   REMAINS rather than what was consumed ([#350](https://github.com/kamilkhan52/research-companion/pull/350),
   DR-041). Per-account plans landed in [#342](https://github.com/kamilkhan52/research-companion/pull/342),
   so two accounts can differ and an operator can grant one. The mid-flow 402/429 refusals landed in
   #345/#346 (DR-034). Account isolation across sign-in landed in
   [#351](https://github.com/kamilkhan52/research-companion/pull/351) (DR-037, DR-044), and
   `codex/job-terminal-after-settlement` publishes a job's terminal status only after its
   reservation settles (DR-035).

   The three remainders this section used to list are closed as of 2026-08-12: DR-036 (the
   account's standing refreshes at the API layer after metered jobs) and DR-049 (background-job
   refusals carry structured metadata; the client's exact-prose matcher is gone) both shipped —
   see their ledger rows — and `research_tools` web search is now METERED: every provider call
   (Brave, newly added as primary → Firecrawl → keyless DuckDuckGo) records a pinned per-call
   price from `spend_limits.py` through `usage.record`, feeding both the ledger and the turn's
   spend reservation. Prices verified against published rate cards 2026-08-12; §8.4 of the
   pricing analysis records the closure. The one open piece is operational, not code: H29 (a
   Brave key on production, optional — ~1,000 searches/month are free on any Brave account).

   **What actually gates progress now is device acceptance, not code.** Thirty-six ledger rows sit
   at `implemented — verify`. Merging is not acceptance, and a row only closes when Kamil has seen
   it.

### Still open, in order

*The done items that used to head this list are in [`90-history.md`](90-history.md).*

1. **Data safety answers in Play Console** (Kamil, H13). `02-security-and-privacy.md` holds the
   code-derived inventory they must match, and the policy now published must match both.
2. **Then the AAB and the closed track** — one production-profile EAS build with `app.json` pointing
   at that origin and cleartext removed, which is the last piece of "encrypted in transit".

   **Correction, 2026-07-29 — earlier revisions of this file overstated the urgency of this step,
   and the plan was ordered around the overstatement.** They said the AAB "starts the 12-tester /
   14-continuous-day clock" and that everything else was therefore on its critical path. Checked
   against Google's live requirement rather than repeated from memory: the rule is **12 testers who
   have each been opted in continuously for at least 14 days**, where "opted in" means the person
   opened the link, accepted, and installed from Play under that Google account. The clock is
   counted per tester and therefore effectively starts when the **twelfth** tester is in — not at
   upload.

   So **uploading an AAB with only Kamil on the track banks no clock time whatsoever.** It used
   to be said that it also froze the package name; that is wrong (2026-08-18 — Play binds the
   package when the app is created, and ours is already bound as `io.scholiast.seminar`). So an
   early upload buys literally nothing: all cost, no benefit, taken early.
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

## Locked decisions

Settled 2026-07-24 with the product owner. These are the assumptions the whole sequence rests on;
revisiting one invalidates the milestones downstream of it.

**Project export/import is not a product feature (Kamil, 2026-08-10).** The git-bundle
export/import in `projects.py` was built to migrate Kamil's own projects onto production, and it
did that. It may later be the mechanism under a sharing or public-projects feature, but it is not
one today. Do not design around its current shape, schedule work to polish it, or treat its absence
from the client as a gap. Its import path stays a maintained trust boundary because a latent
capability that materializes untrusted trees is worth keeping safe, not because a feature depends
on it.

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
| M1 | Hosting, environments, and secrets | — | L | ✅ **complete** — production live on Fly, running Kamil's real corpus (both Fly apps deleted 2026-10-25; see Current position) |
| M2 | Identity, tenancy, and per-user isolation | M1 | L | ✅ **complete** — ownership enforced, per-user settings, verified against the live schema |
| M2.5 | Closed-track compliance minimum (incl. account deletion) + first build | M1, M2 | L | **code-complete** — deletion, reporting and legal surfaces shipped; the AAB and Play Data Safety answers are the remainder |
| M3 | Metering, quotas, and abuse controls | M2, M2.5 | L | **shipped, with a remainder** — exact-cost metering, the reservation ledger, per-operation caps and plans are live; see "Current position" |
| M4 | RevenueCat foundation | M2 | M | **in progress** — client foundation shipped 2026-08-14 (SDK, identity, paywall behind flag; `03-monetization-and-entitlements.md`); Play app created; remainder gated on H8's payments profile → H9 products → H10 credential |
| M5 | Subscription-backed access | M3, M4 | M | queued |
| M6 | Durability — job persistence and backups | M1, M3 | M | queued |
| M7 | Remaining compliance, safety, and legal surfaces | M2, M2.5 | M | queued |
| M8 | Observability and operator tooling | M1 | M | queued |
| M9 | Android release automation | M1, M7 | M | queued |
| M10 | Launch rehearsal | all | M | queued |
| M11 | Production release | M10 | S | queued |

**M1, M2, M2.5 and M3 have their full detail in [`90-history.md`](90-history.md)** — objective, work
items, verification, rollback, and the review lessons each produced. What is still open from them is
in "Current position" above, so nothing below M3 needs reading to know what to do next.

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

Deliberately fewer than the external brief's eleven, because stale documentation is worse than none.
Play, iOS, and web checklists live inside the milestones that action them rather than as standalone
documents.

| Document | Status | Written during |
|---|---|---|
| `00-current-state-audit.md` | ✅ done | now |
| `10-roadmap.md` (this file) — what is open | ✅ live | now |
| `40-device-test-runbook.md` — how to prove what is served | ✅ live | M2.5 |
| `90-history.md` — completed milestones and dated handoffs | ✅ live | split out 2026-08-09 |
| `HUMAN_ACTIONS.md` | ✅ live | now |
| `20-pricing-analysis.md` — unit costs behind the credit peg | ✅ done | M3 |
| `30-ui-layer-brief.md` | ✅ done | M2.5 |
| `02-security-and-privacy.md` | 🚧 M2.5 code-derived inventory + Data Safety draft written; implementation and M7 expansion open | M2.5, expanded in M7 |
| `04-ai-costs-quotas-and-abuse.md` | ✅ done | M3 |
| `01-architecture.md` | queued | M1 |
| `03-monetization-and-entitlements.md` | ✅ done — design record + remaining order | M4 |

**Rule:** every architecture or configuration change updates the relevant document in the same PR.
These are project memory — a future Claude or Codex session must be able to operate from them
without reconstructing context from chat history.

## Policy verification rule

Store policies change and this plan encodes a July 2026 snapshot. Before implementing or submitting
anything policy-sensitive, check the current official source and record the URL, date checked,
requirement, and implementation impact in the relevant milestone. Do not treat the dates in this
document (API 36 and Play Billing 7 on 2026-08-31; the 12-tester/14-day closed-test rule) as
verified — they are flags to check, and two of them are roughly five weeks out.
