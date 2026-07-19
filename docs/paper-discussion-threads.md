# Independent discussion threads

R10.21 adds independent conversations to a paper without turning the selected thread into
mutable project-global state.

## Identity and storage

- `main` is the permanent compatibility thread. Its transcript remains
  `sessions/<slug>.jsonl`, its retry state remains
  `.state/branches/<slug>.branches.json`, and its session metadata remains at the top level of
  `.state/sessions.json`.
- Additional ids are generated server-side and restricted to lowercase ASCII letters, digits,
  and hyphens. Their transcripts live at `sessions/<slug>.threads/<thread-id>.jsonl`; retry
  state lives under `.state/branches/<slug>.threads/`.
- Additional metadata is nested under the paper's `threads` index entry. Existing projects
  need no migration.
- Every session/turn/retry/mode/review request carries `thread_id` (omitted means `main`).
  The backend binds it in a request/worker-local context variable. It is never saved as a
  globally active choice, so two clients can use different threads safely.

## Jobs and lifecycle

Chat jobs deduplicate by `(project, paper, thread)`. Different threads can generate at the
same time; double taps within one thread still join the same job. A short paper-level
admission lock makes job registration and notes approval atomic without holding that lock
during generation.

Each thread has its own transcript, opening prompt, reading mode, retry branches, and
conversation state. Notes remain paper-level:

1. Finishing a thread adds the substantive reader/analyst turns from every other thread to the
   existing background finish job. The paper full text is not duplicated.
2. Approval is refused while any thread still has a running response.
3. One human approval stamps/clears pending proposals and retry branches across the paper and
   rests every thread at `committed`. Continuing later reopens only the chosen thread.

This preserves the agent-proposes/human-commits boundary: no thread writes scholarly notes
directly.

## Move and copy

Project relocation exports and imports every thread transcript and branch file with the
paper's session metadata. Copy produces independent destination files; Move removes all source
thread files only after the destination materializes successfully. Git pathspec handling
includes every tracked thread transcript.

## Mobile interaction

`More → Discussion threads` switches among named rows and offers `Start a new thread`.
An empty thread opens directly on the normal composer with “Start with any question about this
paper…”. The user's first message becomes its label; the analyst receives the usual regenerated
opening with full paper text and the same tools as main. Query caches, persisted drafts, audio
identity, retry branches, and notes review are all thread-qualified.
