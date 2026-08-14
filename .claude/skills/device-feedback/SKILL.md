---
name: device-feedback
description: Triage Kamil's in-app device-test feedback (.dev-feedback/ inbox) into the device-review ledger — verdicts, remarks, screenshots, and new issues from the DevTest bubble (DR-060).
---

# /device-feedback — triage the in-app device-test inbox

Kamil records device-test feedback from inside the app (the dev-build bubble): pass/fail/remark
verdicts per ledger item, screenshots of the screen he was on, and brand-new issues. It all
lands in `.dev-feedback/` at the repo root — **his inputs, preserved verbatim; never edit or
delete them**. This skill turns that inbox into ledger updates.

## Where things are

- `.dev-feedback/feedback.jsonl` — one JSON entry per line, append-only. Three kinds:
  - `{"kind": "feedback", "ts", "item_id", "verdict": "pass|fail|remark", "comment", "route", "screenshot"}`
    — `route` is the app screen he was on; `screenshot` is a repo-relative PNG path or null.
  - `{"kind": "new_item", "ts", "id": "NEW-…", "title", "description"}` — an issue he opened
    from the phone; the `NEW-…` id is provisional until you assign a DR number.
  - `{"kind": "response", "ts", "item_id", "text"}` — YOUR reply (DR-080), written via
    `devtest.append_response` in step 3 below; renders as markdown under the item in the
    phone's bubble.
- `.dev-feedback/screenshots/*.png` — view them with the Read tool; they render as images.
- `.dev-feedback/processed-through` — the triage cursor (a timestamp). Entries with `ts` newer
  than it are unprocessed. `GET /api/devtest/status` on the dev server reports the same count.

## The triage procedure

1. Read the cursor (missing file = nothing processed yet), then every `feedback.jsonl` entry
   with `ts` after it, oldest first. Read each entry's screenshot when present — it usually
   carries the context the comment abbreviates.
2. For each entry, update `docs/device-review-ledger.md`:
   - **pass** on an `implemented — verify` row → flip to `closed`, appending
     "Device-confirmed <date>" (+ his comment verbatim if any) to the evidence column.
   - **fail** → flip the row to `open` (or keep `partial`), appending his comment verbatim,
     the `route`, and the screenshot path. His words are the requirement — do not paraphrase
     them away; quote them.
   - **remark** → append the comment to the row's evidence with its date. State unchanged
     unless the remark plainly reopens or closes it.
   - **new_item** → create the next `DR-0XX` row (max existing + 1), `open`, with his title as
     the feedback text and his description in the evidence column; note the provisional
     `NEW-…` id so the app's untriaged entry reconciles on his next refresh.
3. **Answer him in the bubble (DR-080).** For every triaged entry that deserves a reply —
   a diagnosis, "fixed in PR #N, please re-test", "split into DR-0XX, this one can close",
   or "couldn't reproduce, which screen?" — append a `response` entry:
   `.venv/bin/python -c "from app.routers import devtest; devtest.append_response('DR-0XX', '''<markdown>''')"`
   It renders formatted under the item in the phone's bubble, so he can decide pass/close
   from there without reading the ledger. Keep it short and decision-oriented. A pass
   verdict needs no reply unless something is worth flagging.
4. Advance the cursor to the newest processed `ts`:
   `.venv/bin/python -c "from app.routers import devtest; devtest.mark_processed_through('<ts>')"`
   (or write the file directly). Never advance it past entries you did not actually triage.
5. Commit the ledger changes on a branch and open a PR titled for the pass (the ledger's
   workflow: merging never closes a row — only his pass verdicts do, which is what you just
   recorded).
6. If any feedback names a defect that is quick and unambiguous, fix-and-PR per the normal
   flow — but the LEDGER update always happens first, so his input is durably recorded even if
   the fix stalls.

## Rules

- The inbox is input, the ledger is the record. When a ledger row needs its screenshot to
  survive local cleanup (the ledger's own workflow rule), COPY it to
  `docs/device-review-assets/<DR-id>/` and reference that path — never the temporary
  `.dev-feedback/` path — and keep such copies small (they are jpg). Screenshots that only
  informed your triage and are not referenced by a row stay in the gitignored inbox.
- `.dev-feedback/` exists only on the dev machine. If it is missing, there is nothing to
  triage — say so; do not invent entries.
- When Kamil asks "look at my device feedback" or similar, this skill is what he means.
