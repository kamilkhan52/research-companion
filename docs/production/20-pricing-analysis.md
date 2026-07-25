# Pricing and unit economics — Free tier and $10 Basic

*Written 2026-07-25. Cost basis: **the app's own usage ledgers**, 2026-07-07 → 2026-07-24 —
2,248 metered LLM calls, 34.6 M tokens, **$30.85 of real OpenRouter spend** across eight
`projects/*/.state/usage.json` files plus `.app-state/usage-unattributed.json`; 53 session
transcripts (209 records); 132 cached narration texts; 1,805 synthesized mp3 files (2.99 GB,
2,492 minutes of audio at the measured 160 kbps mono).*

*Constraint from the product owner: **both tiers are DeepSeek-only** for every LLM operation.
Every external price in this document was fetched live on 2026-07-25 — see §7.*

---

## 0. The three findings that drive everything

Before the tables, three measured facts that matter more than the tier design:

1. **Audio, not the LLM, is the expensive part.** At the current default (`tts-1-hd`, uncapped
   narration length) one analysis turn with audio costs **$0.53**, of which **$0.42 (79%) is
   text-to-speech**. The measured mean narration is 10,702 characters ≈ 11 minutes of speech ≈
   **$0.32 of `tts-1-hd` per turn**. Across the measured period the app synthesized ~2.4 M
   characters — **~$72 of TTS against $30.85 of LLM**. TTS is not on the ledger at all
   (`app/tts.py` has zero references to `usage`), so that $72 is invisible spend.

2. **We are paying ~2.45× DeepSeek list price for no reason.** `app/llm.py` sends no OpenRouter
   `provider` routing preference, so requests fan out across 18 endpoints for
   `deepseek/deepseek-v4-pro` priced from $0.435/M (DeepSeek first-party) to $1.74/M (Fireworks,
   Together, CoreWeave, …). Solving our own ledger for the implied rate gives **$1.064/M in,
   $2.128/M out — 2.45× the $0.435/$0.870 list**. This holds for usage recorded as recently as
   2026-07-24, so it is current, not stale. Pinning `provider: {only: ["deepseek"]}` is a
   ~60% cut to the LLM bill for one config line.

3. **The default turn path cannot measure its own cost.** `RC_AGENTIC=1` is the default;
   `agent_harness._record_run_usage` documents that Pydantic AI drops OpenRouter's dollar `cost`,
   so agentic turns record **tokens with $0 cost** plus a `pending` marker. There are 17 such
   pending records; `projects/embedded-llms` shows 6 analysis calls, 261 K prompt tokens, **cost
   $0**. A credits system therefore **cannot** be built on `usage.cost` as `app/usage.py`'s
   docstring assumes. It must meter **tokens × a local price table**. See §8.

---

## 1. Headline recommendation

### Free — "3 papers a month, your device's voice"

| What the user sees | Internal |
|---|---|
| **15 analysis turns / month** (≈ 3–4 papers discussed) | 150 credits |
| Reference graph: **1 build / month** | 17 credits |
| Discovery: **2 runs / month** | 2 credits |
| Audio: **unlimited, device voice only** (`BrowserTTS`) | 0 credits |
| Web search in chat: **off** | — |
| **Total allowance** | **200 credits** |

Worst-case cost of a free user who maxes it: **$0.14/month**. Model: `deepseek/deepseek-v4-flash`
for everything.

### Basic — $10/month — "20 papers, 45 minutes of studio voice"

| What the user sees | Internal |
|---|---|
| **60 analysis turns / month** (≈ 15–20 papers discussed) | 1,800 credits |
| **45 minutes of premium narration** (`tts-1`) | 675 credits |
| Unlimited device-voice audio beyond that | 0 credits |
| Reference graph, discovery, notes, web search | included, ~50 credits |
| **Total allowance** | **2,500 credits** |

Variable cost at full consumption: **$2.22**. Net revenue after Google Play and RevenueCat:
**$8.40**. **Gross margin 74%.**

**Credit peg: 1 credit = $0.001 (one tenth of a cent) of metered variable cost.** The peg is the
whole design — it makes the allowance a hard cost ceiling regardless of which operation the user
spends it on, and it survives a model price change (re-price the credit table, not the tier).

**Prices are `deepseek/deepseek-v4-pro` on the pinned DeepSeek first-party endpoint. If provider
pinning does not ship, multiply every LLM number below by 2.45 and the $10 tier's margin falls
from 74% to 32%.**

---

## 2. Unit economics, derived from the ledgers

### 2a. Measured token profile per operation

Aggregated across all eight ledgers. `calls` for `analysis` is per **turn** (the agentic loop
records one aggregate row per run, not per provider request), so 44,668 prompt tokens is the
whole ~12-request tool loop.

| Operation | Calls | Prompt tok/call | Completion tok/call |
|---|---:|---:|---:|
| `analysis` (one agentic turn) | 101 | 44,668 | 3,733 |
| `listening_preview` (one audio cue) | 1,745 | 11,373 | 86 |
| `graph_extraction` (one paper) | 181 | 20,692 | 28,082 |
| `narration` (stage-2 audio text) | 93 | 3,450 | 2,441 |
| `discovery` | 22 | 5,660 | 2,949 |
| `affiliations` | 99 | 807 | 441 |
| `notes` | 4 | 4,006 | 4,718 |

### 2b. Cost per operation under DeepSeek pricing

| Operation | V4 Flash pinned | V4 Pro pinned (list) | V4 Pro **unpinned (today)** | Ledger actual $/call |
|---|---:|---:|---:|---:|
| `analysis` turn | $0.00489 | $0.02268 | $0.05547 | $0.06023 |
| `listening_preview` | $0.00108 | $0.00502 | $0.01228 | $0.00465 |
| `graph_extraction` | $0.00721 | $0.03343 | $0.08177 | $0.08403 |
| `narration` text | $0.00078 | $0.00362 | $0.00887 | $0.00905 |
| `discovery` | $0.00108 | $0.00503 | $0.01230 | $0.01460 |
| `affiliations` | $0.00016 | $0.00073 | $0.00180 | $0.00200 |
| `notes` | $0.00126 | $0.00585 | $0.01430 | $0.01490 |

The right-hand column is the ledger's own recorded dollars (mixed-model, so it includes some
Gemini/GLM traffic). The "unpinned" column reproduces it to within ~10% on every row — that is
the model validating against reality, and it is why I trust the 2.45× figure.

### 2c. Text-to-speech

Measured constant: **970 characters per minute of speech** (largest narration, 36,987 chars →
2,287 s, verified with `afinfo`). Mean cached narration: **10,702 chars ≈ 11.0 minutes**.

| | per 1M chars | per minute | per narration (10,702 chars) |
|---|---:|---:|---:|
| `tts-1-hd` (**current default**) | $30.00 | **$0.0291** | **$0.3211** |
| `tts-1` | $15.00 | **$0.01455** | **$0.1605** |
| `BrowserTTS` | $0 | $0 | $0 |

### 2d. Unmetered variable costs (not in any ledger)

| Cost | Rate | Per turn |
|---|---|---:|
| Web search — Parallel Search API, `Basic` tier | $5 / 1,000 requests | $0.0075 @ 1.5 searches |
| Audio egress (Fly, NA) | $0.02/GB | ~$0.0002 |
| TTS | see 2c | see 2c |

Web search at $0.0075/turn is **29% of the recommended per-turn cost** and is completely
invisible to `usage.json` (`app/research_tools.py` has zero `usage` references). The 1.5
searches/turn assumption is **UNVERIFIED** — see §6.

### 2e. Cost per "typical paper read"

Definition: retrieve (no LLM cost) + **4 analysis turns** + narration + 1 graph extraction +
notes. The measured mean is 1.9 turns/paper (101 turns ÷ 53 sessions) and the p90 session is 6
turns, so 4 is deliberately on the expensive side of observed behaviour.

| Configuration | Per paper |
|---|---:|
| **Today**: V4 Pro unpinned, `tts-1-hd`, 17 cues/turn, uncapped narration | **$2.99** |
| V4 Pro pinned, `tts-1-hd` | $2.28 |
| V4 Pro pinned, `tts-1` | $1.44 |
| **Recommended stack**, premium audio | **$0.34** |
| **Recommended stack**, device voice (Free) | **$0.12** |

"Recommended stack" = V4 Pro pinned for `analysis`, V4 Flash for every ancillary op, listening
cues capped at 6/turn with a 4 K-token prompt, narration capped at 6,000 chars, 60% prompt-cache
hit rate. Per turn that is **$0.0262** all-in ($0.0143 LLM + $0.0043 graph + $0.0075 search).

The 25× spread between the first and last row is the entire finding. **The tier design does not
work at today's configuration and works comfortably after four changes** (§8).

### 2f. Per active user-month

Assumption: a **typical** user reads **15 papers/month at 4 turns each = 60 turns**, listens to
45 minutes of premium narration and leaves device voice on for the rest.

| User | Turns/mo | Premium audio | Variable cost (recommended stack) |
|---|---:|---:|---:|
| Light | 20 | 15 min | $0.74 |
| **Typical** | **60** | **45 min** | **$2.22** |
| Heavy (at the cap) | 60 | 45 min | $2.22 — *the cap is the point* |
| Heavy, **uncapped** (what happens today) | 150 | 660 min | **$13.53** |

The last row is why metering is not optional: a Basic user who simply leaves audio on for 150
turns at today's uncapped narration length consumes 662 minutes of TTS — **$9.63 at `tts-1`,
$19.26 at `tts-1-hd`** — against $8.40 of net revenue.

---

## 3. Margin analysis, $10 Basic

**Revenue waterfall**

| Line | Amount | Source |
|---|---:|---|
| Subscription price | $10.00 | — |
| Google Play service fee (US, subs) | −$1.50 | 10% base + 5% billing fee = 15% |
| RevenueCat (1% of tracked revenue above $2,500 MTR) | −$0.10 | $0 until we cross $2,500 MTR |
| **Net revenue** | **$8.40** | ($8.50 while under $2,500 MTR) |

**Contribution at the recommended allowance**

| Line | Amount |
|---|---:|
| Net revenue | $8.40 |
| LLM (60 turns × $0.0143) | −$0.86 |
| Graph extraction (15 papers × 2.4 × $0.0072) | −$0.26 |
| Web search (60 × $0.0075) | −$0.45 |
| Premium TTS (45 min × $0.01455) | −$0.65 |
| Egress + misc | −$0.02 |
| **Total variable** | **−$2.22** |
| **Gross contribution** | **$6.18 (74% GM)** |

**Allowance sensitivity**

| Allowance | Variable | GM |
|---|---:|---:|
| 50 turns + 30 min | $1.74 | 79% |
| **60 turns + 45 min** | **$2.22** | **74%** |
| 80 turns + 60 min | $2.97 | 65% |
| 100 turns + 90 min | $3.93 | 53% |

I recommend 60/45. It is a credible offer (roughly "a paper a day, with audio"), it lands at the
74% margin SaaS benchmark, and it leaves room to raise the allowance later as a retention lever
rather than having to cut it.

**Fixed costs**

| Item | $/month | Note |
|---|---:|---|
| Fly prod: shared-cpu-2x 2 GB, `dfw` | $14.24 | `fly.toml` `[[vm]] cpus=2, memory_mb=2048` |
| Fly prod volume, 20 GB | $3.00 | $0.15/GB |
| Fly staging: shared-cpu-1x 1 GB, `dfw` | $7.12 | `fly.staging.toml` |
| Fly staging volume (assumed 10 GB) | $1.50 | size not in repo — **UNVERIFIED** |
| Supabase | $0 | Free plan, auth-only, 50 K MAU |
| **Total** | **$25.86** | **$50.86** if Supabase Pro is required (§5) |

**Break-even**

| Scenario | Paying users to cover fixed cost |
|---|---:|
| No free tier | **4.2 → 5 users** |
| 10 free per paying user, $0.15 each | 5.5 → **6 users** |
| 20 free per paying user, $0.15 each | 8.1 → **9 users** |
| With Supabase Pro, 20:1 free ratio | 16.0 → **16 users** |
| 20:1 free ratio at **$0.30**/free user | contribution collapses to $0.18 → **148 users** |

Fixed cost is trivially covered — this is not an infrastructure-cost business. The break-even is
governed almost entirely by the **free-tier drag**, and that last row shows how fast it goes
wrong if the free allowance doubles.

---

## 4. Free-tier exposure

Worst case = one free user consumes 100% of the allowance every month.

| Free allowance | Cost/user-month | 100 users | 1,000 users |
|---|---:|---:|---:|
| 10 turns | $0.10 | $10 | $101 |
| **15 turns (recommended)** | **$0.14** | **$14** | **$141** |
| 20 turns | $0.18 | $18 | $182 |
| 25 turns | $0.22 | $22 | $222 |

At 1,000 free users the recommended allowance costs **$141/month**, covered by **23 Basic
subscribers**. That is an acceptable customer-acquisition cost.

**The two ways this becomes a disaster, both currently possible:**

- **If premium TTS is available on Free.** 15 turns × 10,702 chars at `tts-1-hd` = $4.82/user-
  month → **$4,820/month at 1,000 free users**. This is a 34× blowout and is the single reason
  `BrowserTTS` must be hard-enforced server-side on Free, not merely defaulted in the UI.
- **If web search is available on Free.** It nearly doubles the per-turn cost ($0.0081 → $0.0156)
  and it is billed by a third party we cannot rate-limit per user today.

**Anti-abuse floor:** free accounts are self-service Supabase sign-ups. Ten throwaway accounts is
$1.40. Gate the free allowance on a verified email at minimum; the interim `RC_ALLOWED_USERS`
allowlist (`app/auth.py`) is not a substitute once sign-up is open.

---

## 5. TTS recommendation

**Recommendation: `BrowserTTS` is the correct Free-tier answer, and it is a genuinely weak
product experience. Ship it on Free anyway, and make premium voice the single clearest reason to
upgrade.**

The honest assessment, since this is a listening-first product:

- `BrowserTTS` is a passthrough — `app/tts.py` returns `{"mode": "browser", "text": ...}` and the
  client speaks it. Cost is exactly $0 and there is no server-side quota to enforce, no cache to
  evict, no egress. That is worth a lot.
- The voice is whatever the device has. On modern Android that is Google's neural TTS, which is
  respectable for a 30-second cue and **tiring across an 11-minute paper narration** — flat
  prosody, no handling of the equations, citations and acronym-dense prose this content is full
  of. On older devices it is materially worse, and quality varies by handset in a way we cannot
  control or support. For a product whose pitch is "listen to papers," a free user's first
  listening session will be the weakest impression of the app they ever get.
- That is exactly why it is the right free tier. The free tier's job is to demonstrate the
  *analysis*, not to be a complete product. The audio quality gap is the most legible upgrade
  trigger we have — better than a turn counter, because the user *hears* it.

**Mitigation, not compromise:** give Free users a **3-minute premium-voice sample per month**
(cost: $0.04) so the gap is demonstrated rather than merely described. Do not extend it further —
every additional free premium minute is $0.0146, and at 1,000 free users each free minute costs
$15/month.

**For paid tiers: switch the default from `tts-1-hd` to `tts-1`.** `tts-1-hd` is 2× the price for
a difference that is close to inaudible through phone speakers and earbuds, which is how this
content is consumed. That single change halves the largest variable cost in the business.
Keep `tts-1-hd` as an option on a future Pro tier. `gpt-4o-mini-tts` is already in the UI picker
(`web/src/components/Settings.tsx`) but is token-priced rather than character-priced and I could
not verify its rate — see §7.

**Also cap narration length.** 10,702 characters (11 minutes) per turn is a product decision
nobody made; it is just however long the model wrote. A 6,000-char cap (~6 minutes) cuts TTS cost
44% and is very likely a *better* listening experience.

---

## 6. Assumptions and sensitivities

**What the model is most sensitive to, in order:**

1. **Premium TTS minutes per user-month.** This is the number. At the recommended 45 min it is
   $0.65 of a $2.22 variable cost, but it is the only line with no natural ceiling — a user can
   listen for 10 hours as easily as 45 minutes. At `tts-1-hd` with uncapped narration, a single
   engaged user costs $19/month against $8.40 of revenue. **Everything else is rounding error
   next to this.** It must be a hard server-enforced quota, not a soft default.
2. **Whether provider routing gets pinned.** 2.45× on every LLM line. 74% GM → 32% GM.
3. **Free:paid ratio.** At 20:1 with a $0.30 free allowance, contribution per paying user falls
   to $0.18 and break-even goes from 9 users to 148.
4. **Turns per paper.** Measured at 1.9; I modelled 4. If real engaged users do 8, the 60-turn
   allowance covers 7 papers instead of 15 and the offer looks thin — a marketing problem, not a
   margin problem, since the credit cap holds either way.
5. **Prompt-cache hit rate.** I assumed 60%. DeepSeek V4 Pro's cache-read price is $0.003625/M —
   **120× cheaper than fresh input** — and an agentic turn re-sends the same system prompt and
   paper text across ~12 requests, so this should be high. At 0% the per-turn cost rises from
   $0.0262 to $0.0377 (+44%) and Basic's GM falls from 74% to 66%. **We do not measure this** —
   `usage.py` records no cached-token field. Instrumenting it is the cheapest high-value thing on
   this list.

**Stated assumptions, and how to confirm them:**

| Assumption | Value | How to confirm |
|---|---|---|
| Turns per typical paper | 4 | Ledger already has it (1.9 measured); revisit after 100 real users |
| Web searches per agentic turn | 1.5 | **UNVERIFIED** — instrument `research_tools.web_search` with a counter; it is not metered at all today |
| Prompt-cache hit rate | 60% | **UNVERIFIED** — record `cached_tokens` from OpenRouter's usage payload in `usage.py` |
| Listening cues per turn | 17.3 measured → 6 capped | Measured (1,745 ÷ 101); the cap is a product change |
| Chars per minute of speech | 970 | Measured from mp3 durations |
| Free:paid ratio | 20:1 | Unknowable pre-launch. Watch it from week one |
| Staging volume size | 10 GB | `fly volumes list -a research-companion-staging` |

**What would have to be true for this to be wrong:**

- If DeepSeek V4 Pro is not good enough for analysis turns and we need a frontier model, the
  per-turn LLM cost goes from $0.014 to roughly $0.15–0.40 (the ledger's Claude Sonnet 5 rows
  averaged $0.22/call) and **the $10 tier does not work at any useful allowance**. The
  DeepSeek-only constraint is load-bearing; validate output quality before committing to it.
- If users treat this as a background listening app rather than a reading app, TTS volume goes
  up 5–10× and the tier must be repriced around audio minutes, not turns.
- If Google Play's US structure changes back from 10%+5%, or if a future EU DMA outcome lets us
  bill outside Play, net revenue moves ±$0.50–1.50 per user.

---

## 7. External prices used — every one verified 2026-07-25

| # | Item | Value | Source | Status |
|---|---|---|---|---|
| 1 | `deepseek/deepseek-v4-pro` | $0.435/M in, $0.870/M out, $0.003625/M cache read, 1 M ctx | `https://openrouter.ai/api/v1/models` (live JSON) | ✅ 2026-07-25 |
| 2 | `deepseek/deepseek-v4-flash` | $0.0938/M in, $0.1876/M out, $0.01876/M cache read, 1 M ctx | same | ✅ 2026-07-25 |
| 3 | `deepseek/deepseek-v3.2` (cheaper legacy option) | $0.269/M in, $0.400/M out | same | ✅ 2026-07-25 |
| 4 | V4 Pro **endpoint spread** (18 providers) | $0.435–$1.740/M in; $0.870–$3.480/M out | `https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-pro/endpoints` | ✅ 2026-07-25 |
| 5 | OpenRouter markup on inference | **None.** "We pass through the pricing of the underlying providers without any markup on inference pricing." | `https://openrouter.ai/docs/faq` | ✅ 2026-07-25 |
| 6 | OpenRouter credit-purchase fee | 5.5% ($0.80 min) via Stripe; 5% crypto; BYOK 5% after 1 M req/mo | same | ✅ 2026-07-25 |
| 7 | OpenAI `tts-1` | **$15.00 / 1M characters** | `https://developers.openai.com/api/docs/models/tts-1` | ✅ 2026-07-25 |
| 8 | OpenAI `tts-1-hd` | **$30.00 / 1M characters** | `https://developers.openai.com/api/docs/models/tts-1-hd` | ✅ 2026-07-25 |
| 9 | OpenAI `gpt-4o-mini-tts` | token-priced, rate not found | `https://developers.openai.com/api/docs/pricing` (TTS models absent from the pricing table) | ❌ **UNVERIFIED** |
| 10 | Google Play subs fee, US/EEA/UK from 2026-06-30 | **10% base + 5% billing fee = 15%**; billing fee unavoidable via Play Billing | `https://support.google.com/googleplay/android-developer/answer/112622` | ✅ 2026-07-25 |
| 11 | Google Play subs fee, rest of world | 15% flat, regardless of annual revenue | same | ✅ 2026-07-25 |
| 12 | RevenueCat | Free to **$2,500 monthly tracked revenue**; **1% of MTR** above | `https://www.revenuecat.com/pricing/` | ✅ 2026-07-25 |
| 13 | Fly shared-cpu-2x 2 GB, `dfw` | $0.0198/hr = **$14.24/mo** | `https://fly.io/docs/about/pricing/` | ✅ 2026-07-25 |
| 14 | Fly shared-cpu-1x 1 GB, `dfw` | $0.0099/hr = **$7.12/mo** | same | ✅ 2026-07-25 |
| 15 | Fly volume | **$0.15/GB/mo** provisioned; snapshots $0.08/GB, first 10 GB free | same | ✅ 2026-07-25 |
| 16 | Fly egress, North America | **$0.02/GB** | same | ✅ 2026-07-25 |
| 17 | Supabase Free | **50,000 MAU**, 2 active projects, **paused after 1 week of inactivity** | `https://supabase.com/pricing` | ✅ 2026-07-25 |
| 18 | Supabase Pro | **$25/mo**, 100,000 MAU, then $0.00325/MAU | same | ✅ 2026-07-25 |
| 19 | Parallel Search API | Turbo $1 / 1,000 req; **Basic & Advanced $5 / 1,000 req** (10 results); +$1 / 1,000 extra results | `https://parallel.ai/pricing` | ✅ 2026-07-25 |
| 20 | Firecrawl (fallback search/fetch) | not checked | — | ❌ **UNVERIFIED** |
| 21 | Effective DeepSeek rate we actually pay | $1.064/M in, $2.128/M out | derived from our own ledgers (least-squares over 7 projects, $20.18 of V4 Pro spend) | ✅ derived, not quoted |

**Supabase caveat worth a decision:** the Free plan is stated as 50,000 MAU, which is far beyond
anything we need for a JWT-only integration — but Free projects are **paused after one week of
inactivity**, and the plan allows only **2 active projects** (we already have prod + staging, so
we are at the cap). A paused auth issuer is a total outage. Either accept the risk with a
heartbeat, or budget **$25/mo for Pro**, which moves break-even from 9 to 16 paying users. I
recommend Pro at launch; it is 3 paying customers.

---

## 8. What in the repo contradicts this plan

These are prerequisites, not nice-to-haves. In priority order:

1. **`app/llm.py` sends no provider routing preference.** Add `"provider": {"only": ["deepseek"],
   "allow_fallbacks": false}` (or an explicit cheap-endpoint order) to the request body. **Worth
   ~60% of the LLM bill.** Verified against the endpoints API: we are routing to endpoints
   costing up to 4× first-party DeepSeek.

2. **The default turn path cannot report cost** (`agent_harness._record_run_usage`, and
   `app/usage.py`'s "cost comes straight from OpenRouter" design note). 17 pending records and at
   least one project with real token usage and $0 recorded cost. **A credits ledger must be built
   on `tokens × local price table`**, with OpenRouter's `usage.cost` used only as a reconciliation
   check. This is a design change to `usage.py`, not a bug fix.

3. **TTS is entirely unmetered.** `app/tts.py` has zero `usage` references, yet TTS is the largest
   variable cost in the business (~$72 vs $30.85 of LLM over the measured period). Nothing can be
   quota'd until characters synthesized are recorded per project/user.

4. **Web search is entirely unmetered.** `app/research_tools.py` calls the Parallel Search MCP
   (and Firecrawl) with no accounting. Real cash, per agentic turn, invisible.

5. **`listening_preview` is the biggest LLM volume in the app and looks unintentional.** 1,745
   calls vs 101 analysis turns = **17.3 cues per turn**, each sending **11,373 prompt tokens to
   produce 86 tokens of output**. That is 197 K prompt tokens per turn spent on cues — 4.4× the
   analysis turn's own prompt. Capping at 6 cues and trimming the cue prompt to ~4 K tokens takes
   preview cost from $0.087/turn to $0.0016/turn at the same product surface. This is the single
   largest LLM saving available.

6. **The audio cache has no eviction.** 2.99 GB in ~3 weeks from **one** user, against a 20 GB
   volume (`fly.toml`). At 100 paying users that is ~300 GB/month of accumulation. The M3 eviction
   work is a hard prerequisite for launch, not a follow-up — and at $0.15/GB an unbounded cache is
   also a slow-growing fixed cost.

7. **No per-user attribution exists.** Ledgers are per *project*; `usage.py`'s docstring correctly
   anticipates `by_user` as "one more key on the aggregate." Until that lands, quotas cannot be
   enforced and neither tier can ship.

8. **Nothing enforces a model.** Both tiers are defined as DeepSeek-only, but the model is a
   user-editable setting (`app/routers/catalogue.py` `FAVORITE_FAMILIES`, per-turn model override (`DeliveryReq.model`)). A tier
   must pin the allowed model server-side; today a Basic user could select `claude-opus-4.6`
   (ledger: $0.44 for a single call) and burn a month's revenue in twenty turns.

**Suggested sequencing:** (1) and (5) are config/product changes worth ~70% of the LLM bill and
can land this week. (3), (4), (7) are the metering prerequisites for any paid tier. (6) is the
launch blocker on the infrastructure side. (2) and (8) are the credits-system design work.
