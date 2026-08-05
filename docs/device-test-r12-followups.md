# Device-test checklist — R12 follow-ups

Manual acceptance record for the work merged after the 2026-07-21 round-12 device pass. These are
the items that shipped in PRs #213, #214, #215 and now need a physical-device / human-judgment pass.
The broader round-12 pass lives in [`current-device-test-checklist.md`](current-device-test-checklist.md);
this document is scoped to focused follow-up items that need physical-device acceptance.

## How to record a result

For every scenario:

1. Change its checkbox to `[x]` after attempting it.
2. Replace `NOT TESTED` with `PASS`, `FAIL`, or `BLOCKED`.
3. For a failure, note the device, exact steps, expected vs actual, and a screenshot/recording.
4. Do **not** mark a scenario passed just because automated tests passed — this file is for behavior
   that needs a real device or human quality judgment.

## Test baseline

- **App-code baseline:** `main` @ `c053a4c` — application code from
  [#213](https://github.com/kamilkhan52/research-companion/pull/213) (R12.9/R12.11),
  [#214](https://github.com/kamilkhan52/research-companion/pull/214) (R12.13),
  [#215](https://github.com/kamilkhan52/research-companion/pull/215) (R12.7). Later docs-only commits
  don't change the served tree.
- **Backend URL:** `http://100.83.161.127:8000` (Tailscale — permanent, no per-session setup).
- **Metro dev-client link:**
  `exp+research-companion://expo-development-client/?url=http%3A%2F%2F100.83.161.127%3A8081`
- **Device / OS:** OnePlus 15 / Android 16.
- **Installed app build/version:** <!-- fill in -->
- **Pass started:** <!-- fill in -->
- **Pass completed:** <!-- fill in -->

### Get to a testable state first

1. On the dev Mac, in the deploy worktree `.claude/worktrees/device-main`: `git pull` (it is
   deliberately still at the pre-R12.9 `main` until you pull), then **restart the backend**
   (`RC_RELOAD=1 ./run.sh`, or restart manually) so it serves the merged code.
2. Start Metro on the live checkout and reload the app.
3. Confirm the backend is healthy (`curl http://100.83.161.127:8000/api/health` → `{"ok":true...}`)
   and the app connects (project switcher loads your projects).

### Native-build warning (affects section E only)

R12.7 audio touches **native** playback (background, lock-screen, queue persistence). Metro can
update the JS but **not** the native audio config. On the current dev-client:
- The in-app player UI + logic (Play next, Autoplay toggle, in-foreground advance) **can** be tested.
- Background / lock-screen / relaunch-queue behavior is **BLOCKED** until a native EAS build — mark
  those sub-items `BLOCKED` rather than `FAIL` if you're on the old dev client.

---

## A. Setup sanity — do this first

- [ ] **A1 — Merged code is being served** — `NOT TESTED`
  - After the pull + backend restart + Metro reload above, open any paper and start a short
    discussion. It should behave normally (no 405s, no connection errors).
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

---

## B. R12.9 — Canonical per-paper pass (first-read enrichment) — [#213](https://github.com/kamilkhan52/research-companion/pull/213)

*What changed: the reference/context + affiliation + figure extraction now runs once at a paper's
first read (not deferred to Map build), stored as one fingerprinted canonical record the Map build
reuses. A concise progress step shows during first read.*

- [ ] **B1 — First-read enrichment progress is visible** — `NOT TESTED`
  - Add and open a **new, not-yet-read** paper (ideally an arXiv paper so it retrieves quickly).
    Watch the retrieval / first-read screen.
  - **Expected:** a short step line appears while enrichment runs, e.g.
    `Reading first page… · Mapping references… · Finding figures…`, then clears when done. It should
    read as concise progress, not a spinner with no explanation, and must not block you from
    starting the discussion.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **B2 — Map build reuses first-read extractions (no re-pay, no perpetual "rebuild")** — `NOT TESTED`
  - In a project where you've already read a few papers, build (or rebuild) the **Map**. Watch the
    per-paper progress.
  - **Expected:** already-read papers are marked reused/cached rather than re-extracted (the build
    is noticeably quicker for them). After the build completes, the "rebuild / build Map" affordance
    should **turn off** for those papers (it must not stay perpetually lit as if stale).
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **B3 — Affiliations are consistent (no divergence)** — `NOT TESTED`
  - For a paper you read, compare the affiliations shown in the discussion/summary vs. after a Map
    build (Authors/Labs view).
  - **Expected:** they agree — no "late" or conflicting affiliations appearing only after the Map
    build (the D05-style divergence this unifies).
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

---

## C. R12.11 / D06 — Opening summary explains incoming project citations — [#213](https://github.com/kamilkhan52/research-companion/pull/213)

*What changed: citing-sentence "contexts" are now extracted at each paper's first read, so the
opening summary can explain how later project papers cite the paper being opened. This is the item
flagged as needing YOUR live-data acceptance — the wiring is correct; this confirms the data.*

- [ ] **C1 — Opening summary cites how later papers use this one** — `NOT TESTED`
  - Use a project with a completed **Map** where later papers genuinely cite an earlier one. Read
    the earlier paper, then read **2–3 of the later citing papers** (so their canonical extraction
    runs). Then open the earlier paper **fresh** and read its opening summary.
  - **Expected:** the summary explicitly explains how the later papers cite/use this paper, and
    distinguishes **substantive** use from a **background** citation — grounded only in the Map's
    evidence, never inventing relationships.
  - **If it fails:** note whether the summary said it lacked citing-sentence evidence, or cited the
    wrong relationships. (This helps pin whether it's a matching gap vs. an extraction gap.)
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

---

## D. R12.13 / D12 — Canonical-title confirmation & rename — [#214](https://github.com/kamilkhan52/research-companion/pull/214)

*What changed: the live discussion no longer detaches when you update/keep a title; the mid-string
rename caret no longer jumps; "Keep mine" persists so you're not re-prompted.*

- [ ] **D1 — Mid-string rename caret stays put** — `NOT TESTED`
  - Open a paper → menu → **Rename paper**. Put the cursor in the **middle** of the title and
    delete/insert a few characters.
  - **Expected:** the caret stays where you're editing — it does **not** jump one position left
    after each keystroke. Editing from the end must also still work.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **D2 — Live thread survives "Update title"** — `NOT TESTED`
  - Start (or resume) a discussion on a paper whose resolver suggests a different canonical title.
    When prompted, tap **Update title**.
  - **Expected:** the title updates AND the live discussion stays attached — you are **not** dropped
    back to the Reading-Mode selection screen, and reopening the paper shows the existing thread with
    its history, not a fresh ComposeFirst.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **D3 — Live thread survives "Keep mine"** — `NOT TESTED`
  - Same setup as D2, but tap **Keep mine**.
  - **Expected:** same as D2 — the thread stays attached and resumes on reopen.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **D4 — "Keep mine" persists (no nagging)** — `NOT TESTED`
  - After keeping a title that differs from the resolver's suggestion, **close and reopen** the
    paper's discussion a few times.
  - **Expected:** you are **not** prompted again to change it back — the decision sticks.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **D5 — Delete available from menu and swipe** — `NOT TESTED`
  - Confirm a paper can be deleted from **both** the paper overflow menu and the Library swipe
    action, and that Rename still preserves notes/discussion/history.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

---

## E. R12.7 — Responses as playlist tracks (Listening mode) — [#215](https://github.com/kamilkhan52/research-companion/pull/215)

*What changed: the full-screen player gained a "Play next" button and a session "Autoplay" toggle
(off by default), Listening mode only. "Next" = the next existing response in the thread. The live
Listening flow is unchanged.* **See the native-build warning above — background/lock-screen items
are BLOCKED on the current dev client.**

- [ ] **E1 — Controls appear only in Listening mode, in the player** — `NOT TESTED`
  - In **Listening** mode, play a response and open the **full-screen player**.
  - **Expected:** a **Play next** button and an **Autoplay** toggle are visible. In **Reading**
    mode, they are **not** shown. The mini-player and chat are unchanged (no new controls there).
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **E2 — Autoplay is OFF by default → stops at end of response** — `NOT TESTED`
  - With Autoplay **off** (default), let a response's audio play to the end.
  - **Expected:** playback **stops** at the end — it does not automatically jump to the next response.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **E3 — Manual "Play next" advances** — `NOT TESTED`
  - Tap **Play next**.
  - **Expected:** it plays the next existing response in the thread. If there is no next response,
    it shows a brief "No next response" message rather than doing nothing silently.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **E4 — Autoplay ON → auto-advances** — `NOT TESTED`
  - Turn **Autoplay on**, then let a response finish.
  - **Expected:** playback automatically continues to the next response.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **E5 — Live Listening flow is NOT regressed** — `NOT TESTED`
  - In Listening mode, hold a normal back-and-forth discussion (several turns) with Autoplay **off**.
  - **Expected:** successive responses still narrate and flow as they did before this change — the
    off-by-default toggle must **not** make live listening stop after every response.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **E6 — Background / lock-screen / relaunch (NATIVE BUILD)** — `NOT TESTED`
  - Only if on a native EAS build: verify next/autoplay behaves with the app backgrounded, from the
    lock-screen controls, and that the queue survives a relaunch. On the Metro dev client this is
    `BLOCKED`.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

---

## F. R12.6 regression re-check (post-confirmation fixes) — [#212](https://github.com/kamilkhan52/research-companion/pull/212)

*You confirmed the floating composer/pill/mini-player look. Two small review-fixes landed after
that: the chat error card and the scroll-to-bottom button were lifted above the floating composer,
and the project pill was reordered for screen-reader traversal. Quick re-check only.*

- [ ] **F1 — Nothing hides behind the floating composer; pill still floats** — `NOT TESTED`
  - Scroll a long discussion (the scroll-to-bottom chevron should sit **above** the composer, not
    behind it). If you can trigger a chat error, its card + Dismiss button should also sit above the
    composer. The Library project pill still floats over the list with papers scrolling behind it.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

---

## G. DR-002 / R12.14 — Stop a running Discover search

*What changed: a running search now has a cooperative Stop action. It stops before starting the
next provider/model stage, keeps any prior completed recommendations unchanged, and retains titles
already published by the running funnel as clearly labelled, non-ranked partial finds.*

- [ ] **G1 — Stop before any finds are ready** — `NOT TESTED`
  - Start Discover and tap **Stop search** as soon as it appears.
  - **Expected:** the control changes to `Stopping…`, then the panel says `Search stopped`; no
    spinner remains and the screen clearly says that no partial finds were ready. A new search can
    be started immediately.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **G2 — Stop after the scanning reel has finds** — `NOT TESTED`
  - Start a search, wait for several titles to scroll under **Scanning**, then stop it.
  - **Expected:** those titles remain under **Partial finds** with explicit copy that they were not
    saved as ranked recommendations. The reel no longer animates as if the search were running.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **G3 — Previous completed results survive** — `NOT TESTED`
  - Complete one search, start a different search, then stop the second one.
  - **Expected:** the first search remains below under **Previous results**. Stopping must not
    replace it with the incomplete second run.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

- [ ] **G4 — Network interruption and navigation are safe** — `NOT TESTED`
  - Start a search, briefly interrupt connectivity around Stop, then reconnect. Also leave and
    reopen Discover after stopping.
  - **Expected:** a lost response reconciles to the server's actual state; the UI never jumps back
    to Searching after it has observed cancellation, and reopening shows the stopped snapshot plus
    unchanged previous results.
  - **Result:** <!-- PASS / FAIL / BLOCKED -->
  - **Notes:**

---

## Overall

- **Result tally:** PASS __ / FAIL __ / BLOCKED __ / NOT TESTED __
- **Top issues to fix (ranked):**
  1.
  2.
  3.
- **General notes / anything unexpected:**
