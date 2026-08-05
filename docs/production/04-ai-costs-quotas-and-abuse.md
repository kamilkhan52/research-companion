# AI costs, quotas, and abuse controls

*Living M3 design and execution record. Started 2026-07-31. The production roadmap remains the
milestone ledger; this document owns the spend inventory and the accounting/enforcement contract.*

## Status

| Slice | Status | What it establishes |
|---|---|---|
| Agentic OpenRouter cost | PR #312, ready for review | Native OpenRouter responses retain authoritative cost and generation id per tool-loop request. |
| OpenAI speech cost | PR #313, ready for review | Every provider dispatch is visible; `tts-1` and `tts-1-hd` are priced exactly by characters sent. |
| Paid-route consolidation | PR #314, ready for review | Retrieval, chat turns, narration, and synthesis are exposed only through background-job routes. |
| Append-only per-user events | PR #315, ready for review | Queryable cost per user, project, feature, and day without replacing the project aggregate. |
| Durable reservation lifecycle | PR #316, ready for review | Transactional per-user ceiling, explicit dispatch and terminal states, leases, and generation linkage. |
| Crash reconciliation | PR #317, ready for review | Expire safe undispatched leases; recover completed OpenRouter generations exactly; charge ambiguity conservatively. |
| Exact-once job admission seam | stacked implementation, in review | Prepare one durable reservation only for a newly published job; joins and cache hits do not reserve again. |
| Paid-work admission + rate limits | queued | Gate every surviving provider workflow before network dispatch. |
| Tier/model gates + kill switch | queued | A caller cannot select spend outside their entitlement; operator can stop all new spend. |

Accounting and enforcement are deliberately different systems:

- **Accounting is observational and best-effort.** A provider response must not fail because the
  analytics ledger cannot be written. Unknown cost stays visibly `estimated`.
- **Admission is authoritative and fail-closed.** Once reservations land, paid work starts only
  after an atomic reservation succeeds. A missing quota store is a refusal, not free passage.

## Provider-spend inventory

This is wider than “LLM jobs.” Every row must eventually pass ownership, rate-limit, and
reservation admission. The synchronous and SSE compatibility routes were removed before the
reservation layer so they cannot become alternate admission paths.

| Provider spend | Code seam | Initiating surfaces | Accounting now | Remaining admission work |
|---|---|---|---|---|
| OpenRouter analysis/tool loop | `agent_harness.py` | chat start/reply/continue/retry/edit/finish/request-changes jobs | Exact per provider request in #312; missing cost pending by generation id | Per-user event + reservation; tier-check `DeliveryReq.model` |
| OpenRouter single-shot analysis/narration | `llm.py` via `agent.py` | agentic fallback and audio-job narration | Exact when response usage arrives; interrupted streams pending | Same reservation gate as agentic path |
| OpenRouter discovery screening | `discovery.py` → `llm.py` | `/discover` background job | Exact provider usage | Reserve the bounded stage budget and rate-limit starts |
| OpenRouter graph extraction | `graph.py` → `llm.py` | `/graph/build` background job | Exact per paper extraction | Reserve the bounded corpus fan-out before admission |
| OpenRouter notes and author/lab research | `notes_jobs.py`, `author_profiles.py`, `affiliations.py` → `llm.py` | notes agent jobs, author profile and lab research jobs | Exact provider usage | Enumerate fan-out maxima and reserve each job |
| OpenAI speech | `tts.openai_speech` | audio jobs and listening previews | One `speech_synthesis` ledger call per dispatch; exact for character-priced models | Reservation per segment/attempt |
| Firecrawl fetch/search | `research_tools.py` | tool-enabled chat | Not in `usage.py` | Add request event, tool-call rate limit, and reservation/allowance |
| OpenAlex and Semantic Scholar APIs | `openalex.py`, `semantic_scholar.py` | discovery, citation/metadata enrichment | Paced/cached, but not represented in the cost ledger | Record usage-priced calls and keep provider-specific daily caps |

## OpenAI speech accounting contract

The app sends normalized spoken text, and cost is charged on exactly that dispatched text.
OpenAI currently publishes `tts-1` at **$15 per 1M characters** and `tts-1-hd` at **$30 per 1M
characters**. Sources: [tts-1-hd model pricing](https://developers.openai.com/api/docs/models/tts-1-hd)
and [speech API request contract](https://platform.openai.com/docs/api-reference/audio/createSpeech).

A successful retry is one more provider dispatch. A returned 4xx/5xx is a definite rejection and
records no speech cost. A transport failure after connection is different: a read failure may mean
OpenAI completed and billed the synthesis while this process never received the bytes. That
ambiguous attempt is conservatively charged *and marked estimated*; a later successful retry is
separately charged exactly. A connection failure before dispatch records nothing.

`gpt-4o-mini-tts` does not have a character-price contract and the binary speech response does not
return per-request cost. It is therefore counted but left pending/estimated rather than assigned a
fictional value. The tier/model-gate slice must either remove it from production choices or add an
authoritative settlement source before it can be admitted under a hard ceiling.

Audio jobs are registered under a user-pseudonym scope so caches and cancellation are isolated.
That scope is **not** a billing project. The worker must rebind the validated initiating project
(or the explicit unattributed ledger) around speech dispatches; otherwise `usage.record` attempts
to resolve `user:<hash>` as a project and the cost disappears.

## Append-only event contract

`rc_usage_events` stores one `usage` row per observed provider dispatch and a `pending` marker when
an accepted call lacks authoritative cost. Reconciliation never rewrites the marker: it appends the
resolved `usage` row with the same generation id. A partial unique index on
`(user_id, generation_id, event_type)` makes retries idempotent without collapsing separate TTS
dispatches, which have no provider generation id.

The insert proves the live `(user, project)` ownership pair inside the SQL statement. App-global
user work maps the explicit unattributed sentinel to a null project; a foreign or retired project
cannot receive a row. The table is included in the automatic `rc_*` Data API lockout, contains no
request/response content, and cascades on account deletion while surviving ordinary project
deletion as historical cost metadata.

Event analytics and the git-side aggregate are independent best-effort writes. Either can fail
without failing a provider result, and `usage_events.daily_summary` can query cost by account,
calendar day, and feature. This remains intentionally separate from reservations: their database
write authorizes spend and therefore must fail closed.

## Durable reservation contract

`rc_usage_reservations` is the authoritative system that is deliberately *not* coupled to the
best-effort event writer. Admission locks the verified `rc_users` row, which serializes concurrent
reservations for one account, then locks and proves the live owned project row. Inside that same
transaction it sums both active pessimistic maxima and settled actual cost for the server-derived
UTC calendar month. Concurrent starts therefore cannot each spend the same remaining balance.
Missing Postgres, a missing account row, ownership loss, or an ambiguous database result refuses
admission with a sanitized error.

Each row has one durable lifecycle: `reserved → settled | released | expired`. A stable internal
retry key makes admission idempotent. `begin_attempt` must land immediately before each provider
request; after the first attempt, both Python and a schema constraint prohibit `released`/`expired`.
An undispatched expired lease can safely free capacity. A dispatched orphan remains reserved until
OpenRouter generation reconciliation supplies exact cost, or until it is conservatively settled to
its full maximum. Every network request first inserts an `rc_usage_reservation_attempts` row whose
maximum must fit inside the parent reservation. A lost database response returns that attempt as
`should_dispatch=false`, preventing an idempotency retry from sending the provider request twice.
An attempt can retain an OpenRouter generation id while its cost is pending, then resolve exactly
or conservatively. Exact parent settlement additionally requires a durable
`dispatches_complete_at` marker. A worker writes that marker after it knows no further request can
begin and every accepted OpenRouter response has at least linked its generation id; cost resolution
is deliberately independent and may still be pending. Without the marker, an unseen request may
have been in flight at the crash. Keeping the two proofs separate lets a completed generation
reconcile exactly after restart without pretending a mid-dispatch crash was complete.

The registry's next exact-once seam performs durable preparation outside its process-wide lock,
but serializes identical callers so only a genuinely new job reserves. A concurrent join waits for
that preparation and reuses the published job; unrelated polling and job starts stay responsive.
An in-flight preparation counts as active work for project/account deletion drains. Publication or
thread-start failure invokes a best-effort rollback, while a started job hands settlement to the
normal worker lifecycle. Cache hits occur before this seam and therefore do not reserve.

These slices establish and test the crash/state and job-admission contracts independently. They do
not yet claim that paid routes are gated: provider integration, pessimistic per-workflow estimates,
lease renewal, rate/concurrency limits, and the instance kill switch are the next slices. Actual
monthly tier amounts remain the documented human decision.

## Startup reconciliation

After migrations succeed, one daemon monitor scans expired leases in bounded batches. It expires
only reservations with no dispatch evidence. Every dispatched candidate is re-checked under its
row lock before reconciliation, so a worker renewal that wins after the snapshot scan cannot be
settled underneath live work. Once the locked check observes expiry, normal code cannot resurrect
the lease. A dispatched reservation with a complete dispatch set
and all-exact attempts settles to their sum. For a completed OpenRouter attempt whose cost remains
pending, the monitor calls the documented cost-only `GET /api/v1/generation?id=…` metadata endpoint,
never the separate generation-content endpoint, then resolves the durable attempt. If the dispatch
set was never marked complete, a generation id is absent, or any attempt was already conservative,
the parent settles to its full reserved maximum. A metadata or database outage leaves the maximum
reserved for another pass rather than turning a temporary failure into a permanent full-price
charge; no ambiguity releases possibly-spent capacity.

## Next implementation order

1. Land exact OpenRouter and speech accounting, then verify one real staging response from each
   provider without generating a large workload.
2. Verify the append-only Postgres usage events on staging while retaining the current aggregate
   as a presentation/cache layer.
3. Land the durable reservation states, leases, dispatch marker, exact/conservative settlement,
   and generation linkage.
4. Gate **every row in the inventory** through one admission seam, with pessimistic per-workflow
   maxima. Refuse new paid work when the quota store is unavailable.
5. Add concurrent rate limits, monthly tier quotas, model allowlists, soft 80% warnings, and the
   instance kill switch. Actual tier amounts remain a human decision informed by the new events.
6. Verify reconciliation on staging with one deliberately stale completed OpenRouter generation.
   Character-priced speech settles from its durable exact attempt; there is no provider id to poll.
