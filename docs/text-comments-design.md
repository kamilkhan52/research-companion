# Comment-on-text: annotate a response, queue the notes, ask precisely (R9.2)

Kamil's framing (2026-07-17 device pass): while reading a long response, select a passage,
attach a comment to it, keep going and attach a few more, then send them all as the next
reply — the agent gets each **quoted span + its comment** alongside anything else typed, so the
reader can interrogate a specific paragraph instead of re-describing it. "I want it to be a
great UI/UX." This is the reviewable plan; no code ships with it.

It is the successor to the earlier *selectable response text* idea (previously declined), now
scoped as a purposeful annotate-and-queue flow rather than raw text selection.

## The one hard constraint that shapes everything: RN can't give us arbitrary text ranges

React Native's `<Text selectable>` provides the native copy menu, but — unlike `TextInput` —
it exposes **no selection range** to JS: there is no `onSelectionChange`, no way to read *which*
characters the user highlighted, and no way to add an "Add comment" item to the native
selection menu. A WebView renderer would give us DOM selection, but the discussion is rendered
by our native `Markdown.tsx` (equations, rc-paper links, figure cards) and moving it into a
WebView would regress all of that.

So arbitrary character-range selection is out. The design instead annotates at a **granularity
the renderer already owns**: the **sentence** (falling back to the whole block for
non-prose blocks — a list item, a table, an equation, a quote). This is not a compromise on
UX — sentence-level "tap the thing you mean, comment on it" is *clearer* than a fiddly
character drag on a phone, and it maps exactly onto how the reader thinks ("this claim here").

`Markdown.tsx` already parses blocks; the preview-cue system already splits prose into
sentences (`preview_jobs.completed_sentences`, the same tolerant `[.!?]`-then-space rule). We
reuse that splitter so a paragraph renders as a sequence of tappable sentence spans.

## The interaction (the part that has to feel great)

1. **Enter annotate on long-press.** Long-pressing anywhere in an assistant response enters a
   lightweight "annotate" affordance for that message: sentences become individually
   highlightable. (Long-press is already the message action trigger; a response long-press
   offers "Comment on this" alongside the existing Copy/Retry.) A single tap on a sentence
   selects it (a soft highlight); tapping again deselects.
2. **Add the comment.** With a sentence selected, a small inline bar appears — the quoted
   sentence (truncated) + a one-line "Add a comment…" input + **OK**. On OK the sentence keeps a
   persistent **annotation mark** (a left violet rule + a subtle underline, matching the
   in-project-link violet), and a comment count badge appears on it.
3. **Repeat across the message (and across messages).** The reader can annotate several
   sentences; each becomes a queued comment. Tapping an annotated sentence reopens its comment
   to edit or remove it.
4. **The compose area shows the queue.** Above the composer, a compact **"N comments
   attached"** chip strip: each chip previews its quote + comment, tappable to jump back to the
   sentence or remove it. The composer still takes free text.
5. **Send.** The reply carries the queued comments **and** the typed text (either can be
   empty — a pure-annotation reply is valid; the agent then addresses just the marked
   passages). On success the queue clears and the annotation marks are cleared (they were a
   pending-reply overlay, never part of the committed transcript).

Affordance discipline: annotate mode is visually quiet (no chrome takeover), dismissible by
tapping away, and every mark is reversible until send. Selection highlight + the mark use the
theme's violet (relationships/annotations), distinct from the mint (actions) and the figure
cards.

## Data model + persistence

A queued comment is `{ assistant_index, quote, comment }`:

- `assistant_index` ties it to the response turn it annotates (stable across re-renders).
- `quote` is the **verbatim** sentence text (what the agent must see to know exactly what's
  referenced — never a paraphrase, never an index the agent can't resolve).
- `comment` is the reader's note.

The queue is **per-paper, persisted client-side** exactly like the reply/edit drafts already are
(`usePersistedDraft` / AsyncStorage, keyed by `draftKey(pid, 'comments', slug)`): annotating a
long response then getting interrupted must not lose the work. It is cleared on a successful
send (mirroring how the reply draft clears). It is purely client state — **nothing is written
to the transcript or git** until the reply turn is recorded, preserving "agent proposes, human
commits" and the append-only transcript.

## Threading into the next turn (no new agent-prompt protocol)

The reply endpoint already records the user's message verbatim into history
(`_prep_reply → sessions.record_user(slug, text, kind="reply")`), and the agent turn runs over
`sessions.build_history`. So comments thread in by **formatting them into the recorded user
message** — no marker protocol, no agent-prompt change:

- `ReplyReq` (and the job variant) gains an optional `comments: [{quote, comment}]`.
- The route composes the user message deterministically: a short lead-in, then each comment as a
  Markdown blockquote of the quoted sentence followed by the reader's note, then the free text.
  For example:

  > Regarding specific passages of your last response:
  >
  > > "The SIMD execution model of the PIM array is a poor fit for the reduction."
  > > — Why is SIMD specifically the mismatch here, versus a general bandwidth limit?
  >
  > > "a programming mismatch between collective operations"
  > > What's a concrete example of such a collective op in this workload?
  >
  > Also: of the three problems, I understand (i) and (ii) but not (iii).

  This is what gets recorded as the user turn and what the agent reads — the verbatim quotes
  anchor each question to the exact passage, and it renders naturally in the transcript too (a
  durable record of what the reader asked about). The formatting lives in one helper so the
  plain, job, and SSE reply paths share it.

- **Validation:** the server records the quotes as sent (it does not try to re-locate them in
  the prior turn — the client took them from the rendered text, and the append-only transcript
  is the source of truth). Empty `comments` ⇒ today's behavior exactly.

## Rendering the annotation marks (render-time, like figures)

Annotation marks are a **pending-reply overlay**, resolved at render time against the client
comment queue — not baked into the transcript (the same principle as figure cards: the durable
record is the text; the overlay is derived):

- When a response renders, `Markdown` (or a thin wrapper) is told which of *this message's*
  sentences carry a queued comment (by `assistant_index` + quote match) and marks them.
- Because it is render-time, marks appear/disappear as the queue changes and never persist past
  send. A committed transcript re-render shows no marks (the queue is empty).
- This needs `Markdown` to render prose as **per-sentence spans** when annotate is active for a
  message. The tokenizer stays the same; only paragraph blocks gain a sentence-split render path
  (guarded, so every other Markdown surface — notes, streaming, non-annotated messages — is
  untouched and unchanged).

## Phasing (each its own PR after this doc)

1. **Sentence-span render path in `Markdown`** — an optional per-message "annotatable" mode that
   splits paragraph text into tappable sentence spans (reusing the sentence splitter), with the
   select-highlight + annotation-mark styling. Pure render + Jest fixtures; no data flow yet.
2. **The comment queue + compose-area UI** — the persisted per-slug queue, the inline
   add-comment bar, the "N comments attached" chip strip, add/edit/remove. Component tests.
3. **Threading into the turn** — `ReplyReq.comments` + the shared message-composer helper
   (backend, network-free test on the formatting) + wire the reply/job/SSE paths + clear the
   queue on send.
4. **Polish pass** — enter/exit animation of annotate mode, long-press affordance, empty-text
   send, and a device pass (the real test of "great UX").

## Deliberate boundaries (v1)

- **Sentence/block granularity, not character ranges** — the RN constraint above; revisit only
  if a WebView renderer ever lands.
- **No server-side comment store / no threaded comment history** — comments are transient
  pending-reply state that become an ordinary user turn once sent; they are not a persistent
  annotation layer on the paper.
- **No cross-paper or notes annotation** — this is about interrogating a *response*, not
  margin-notes on the corpus.

## Verification

Jest for the sentence-span render + the queue UI (select → add → chip appears → remove); a
backend network-free test that `comments` compose into the recorded user message verbatim with
the quotes intact. Device pass: annotate several sentences across a long response, attach
comments, add free text, send — the agent's reply addresses each quoted passage; the marks and
queue clear.
