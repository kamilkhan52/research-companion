# Current device-test checklist

Canonical manual acceptance record for the current Android build — the **scenarios and how to run
them**. Update this file directly as tests are performed.

**What lives where** (four files look similar and are not):
[`device-review-ledger.md`](device-review-ledger.md) owns each piece of feedback from report to
device acceptance and is the answer to "what is waiting on Kamil"; this file owns the reproduction
steps those rows link to; [`product-roadmap.md`](product-roadmap.md) decides product delivery order;
[`production/10-roadmap.md`](production/10-roadmap.md) decides launch-milestone order. A failure
recorded here opens or updates a `DR-###` row there — it does not become a queue of its own.

## How to record a result

For every scenario:

1. Change its checkbox to `[x]` after attempting it.
2. Replace `NOT TESTED` with `PASS`, `FAIL`, or `BLOCKED`.
3. For a failure, record the device, exact steps, expected/actual behavior, and a screenshot or
   screen recording when useful.
4. Do not mark a scenario passed because its automated tests passed; this document is specifically
   for behavior that needs a physical device or human quality judgment.

## Test baseline

- **Current app-code baseline:** `main` merge `31e9179` (PR
  [#198](https://github.com/kamilkhan52/research-companion/pull/198)). Later docs-only merges do
  not change the served application tree.
- **Backend URL:** `http://100.83.161.127:8000`
- **Metro dev-client link:**
  `exp+research-companion://expo-development-client/?url=http%3A%2F%2F100.83.161.127%3A8081`
- **Expected data:** the project switcher should currently receive four projects from the backend.
- **Native-build warning:** launcher/splash assets, iOS background declarations, native audio
  configuration, and `expo-document-picker` cannot be updated by Metro. Mark native-only portions
  `BLOCKED` if the installed dev build predates the referenced PR, then test the documented fallback.
- **Device / OS:** OnePlus 15 / Android 16
- **Installed app build/version:** <!-- fill in -->
- **Pass started:** 2026-07-21 03:01 PDT
- **Pass completed:** <!-- fill in -->

## A. Immediate regression checks — do these first

- [x] **D01 — Discussion composer grows with the message** ([#198](https://github.com/kamilkhan52/research-companion/pull/198))
  - Enter a message that wraps across at least six visual lines; also try explicit line breaks.
  - The field should grow smoothly from one line to roughly four lines, keep its rounded card
    intact, then scroll internally. Sending/clearing should return it to one line.
  - The composer should remain full-width, with Send inside the rounded card and no straight
    separator or border extending beyond the card.
  - Repeat while editing an earlier message; focus, cursor, draft text, and Send must still work.
  - **Result:** PASS
  - **Notes / evidence:**
    - OnePlus 15: user confirmed all specified composer growth, internal scrolling, clearing, full-width card, Send placement, and edit-mode behaviors work.

- [x] **D02 — Pending-response activity is contextual** ([#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Start a first read, a later reply, and—if available—a turn that searches or reads figures.
  - Before answer text appears, expect truthful states such as “Reading the paper,” “Viewing
    figures,” “Tracing project citations,” “Searching the literature,” or “Analyzing results.”
  - The old generic “Preparing a response” should not appear, and the activity should disappear
    once response text is visible.
  - **Result:** PASS
  - **Notes / evidence:**
    - Contextual heading such as “Reviewing the paper” appears instead of the old generic state.
    - UX follow-up: remove the explanatory subtitle about connecting the message to the paper/previous discussion; keep only a short, truthful activity phrase.
    - Implementation follow-up: confirm whether the subtitle is hardcoded. Prefer compact state/tool-driven templates; a model-generated fallback should be tightly bounded if used.

- [x] **D03 — Paper summary cannot draft Notes without permission** ([#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Start a new paper discussion and let the opening response finish.
  - It must remain an ordinary discussion response even if the model emits Notes-like sections.
  - Then choose Finish reading and confirm that an explicitly requested Notes proposal still opens
    the human review/commit flow.
  - **Result:** FAIL
  - **Notes / evidence:**
    - OnePlus 15: after manually selecting Finish reading, the app said it wrote Notes but did not show generation progress or automatically open the review/commit screen.
    - Leaving and reopening the chat revealed the proposal. Comment/Edit actions were visible before the Note itself was visible.
    - Expected: show an in-progress Notes-generation state, auto-open the proposal when ready, and place Cancel, Approve and Commit, and Request edits together on the Note review screen.

- [x] **D04 — Last Interacted sorting** ([#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Interact with discussions on two different papers, then return to Library sorting.
  - “Last interacted → Most recent first” must put the newest discussion first; the reverse option
    must invert known timestamps. Papers never discussed should remain last in both directions.
  - **Result:** PASS
  - **Notes / evidence:**
    - Most-recent and reverse Last Interacted sorting behaved correctly; never-discussed papers remained last.

- [x] **D05 — Top-two affiliations appear without blocking first read** ([#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Fetch a paper whose first page contains several institutional affiliations, then begin reading.
  - Fetch/analysis must not wait for affiliation extraction. Once ready, at most the two most common
    affiliations should appear beside title/year in Library and Discussion without crowding them.
  - Leave/reopen the screen to ensure `pending` resolves rather than polling forever.
  - **Result:** PASS
  - **Notes / evidence:**
    - Affiliations were ultimately visible directly under the title/year in Discussion and also in the Reading List/Library, without crowding the header.
    - One earlier paper initially showed no affiliation; later papers displayed it after Map/metadata work. Investigate whether a graph rebuild or delayed extraction is required when metadata is absent.
    - Evidence: `/mnt/data/150496.jpg`, `/mnt/data/Screenshot_2026-07-21-08-28-38-77_c32734a745be661d33dd70aa24fcce64.jpg`, `/mnt/data/Screenshot_2026-07-21-08-28-47-13_c32734a745be661d33dd70aa24fcce64.jpg`.

- [x] **D06 — Opening summary explains incoming project citations** ([#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Use a project with a completed Map where later project papers cite the paper being opened.
  - The first summary should explain how those later papers use it and distinguish substantive use
    from a background citation. It must not invent relationships absent from the Map evidence.
  - **Result:** FAIL
  - **Notes / evidence:**
    - OnePlus 15: discussion was started after building the Map, but the opening summary did not explain how later project papers cite/use the opened paper.
    - The assistant indicated it had abstracts/metadata but not exact citing-sentence evidence. Expected substantive-vs-background incoming-citation context grounded in the completed Map.
    - Evidence: `/mnt/data/Screenshot_2026-07-21-08-33-10-89_c32734a745be661d33dd70aa24fcce64.jpg` and the two adjacent Map/Discussion screenshots listed under D05.

- [x] **D07 — Hardware Back dismisses only the active sheet** ([#171](https://github.com/kamilkhan52/research-companion/pull/171))
  - Open Projects options and at least one other bottom sheet, then press Android Back.
  - The first Back should lower only the sheet; it must not also navigate the underlying screen.
    A second Back may navigate normally.
  - **Result:** PASS
  - **Notes / evidence:**
    - Android Back dismissed only the active sheet on the first press and navigated normally afterward.

- [x] **D08 — Keyboard automatically expands and scrolls sheets** ([#171](https://github.com/kamilkhan52/research-companion/pull/171))
  - Test create/rename/split fields, including a Projects sheet with four or more projects.
  - Focusing the field should reveal the input and actions above the keyboard automatically.
    Manual drag and content scrolling must continue to work while the keyboard is open.
  - **Result:** FAIL
  - **Notes / evidence:**
    - Project Rename adjusts correctly for the keyboard.
    - New Project fails with roughly four or more existing projects: the project-name input remains at the bottom of the list, becomes hidden under the keyboard, and the sheet does not auto-expand/scroll to reveal the field and actions.

- [x] **D09 — Empty project has two clear Add Papers paths** ([#183](https://github.com/kamilkhan52/research-companion/pull/183))
  - Open a new empty project.
  - Expect a prominent designed surface with separate “specific paper” and Discover/Explore paths,
    not a long text-only button or a flow that makes paper addition belong only to Discover.
  - **Result:** PASS
  - **Notes / evidence:**
    - Both specific-paper and Discover/Explore add paths are visible.
    - UX issue: a new empty project also shows Continue Reading, which distracts from the empty-state purpose and should not appear there.
    - Product direction: use one compact, uniform Add entry point—preferably a round + button opening Add options—and consider replacing the standalone Discover tab with this Add flow.
    - Remove oversized “Have a specific paper? Add by name or link?” surfaces wherever they appear.
    - Explicit add-by-link/title flow should navigate directly to the live discussion after analysis starts. Reopening an already-started analysis must show its running state/thread, never the Reading Mode start screen again.
    - The paper-summary bubble begins with a preferred rounded shape but ends with a squarer presentation; preserve the initial visual treatment throughout.

- [x] **D10 — Hierarchical sort directions remain clean** ([#183](https://github.com/kamilkhan52/research-companion/pull/183))
  - Open each sort category and its second-level directions, then Back out without changing it.
  - Name defaults A→Z. Publication date and Date added default oldest→newest. Unknown dates remain
    last. Also retest Last Interacted from D04.
  - **Result:** PASS
  - **Notes / evidence:**
    - Sort hierarchy, direction defaults, Back behavior, and Last Interacted directions worked correctly.
    - Improvement: persist the last sort selection per project and never reset it unexpectedly.
    - Add a minimal current-sort indicator that stays visually clean.
    - Filter wording should exactly match statuses: Discussing, Unread, Read, All.

- [x] **D11 — Multi-select actions are compact and explicit** ([#183](https://github.com/kamilkhan52/research-companion/pull/183))
  - Select several papers, including enough that the old action row would have crowded the count.
  - “N selected” must remain horizontal/readable; Move, Copy, and Delete must be distinct compact
    actions. Only Move should imply source removal.
  - **Result:** PASS
  - **Notes / evidence:**
    - Multi-select count and compact Move, Copy, and Delete actions remained readable and explicit.

- [x] **D12 — Canonical title confirmation and paper edit menu** ([#184](https://github.com/kamilkhan52/research-companion/pull/184))
  - Add a paper using an incomplete or mistyped title and complete resolution.
  - The found canonical title should be shown and offered as a confirmation—not silently applied.
  - Verify paper Rename preserves Notes/discussion/history and Delete remains available from both
    the menu and existing swipe behavior.
  - **Result:** FAIL
  - **Notes / evidence:**
    - Canonical-title approval is not reflected immediately in the currently open discussion.
    - After the paper summary was generated and the title update approved, the paper list eventually showed the new title; reopening the paper then showed Reading Mode selection and the existing thread appeared lost/detached.
    - Manual Rename preserves the discussion/history, but mid-string editing is broken: deleting or typing in the middle moves the cursor one position left after every keypress. Editing from the end behaves normally.
    - After intentionally keeping a manually renamed title that differs from the source, every discussion open prompts to change it back. “Keep it” should persist once and suppress the same future prompt.
    - Delete availability from both menu and swipe was not explicitly re-verified during this pass.

- [x] **D13 — Durable source status, Fetch, and recovery** ([#184](https://github.com/kamilkhan52/research-companion/pull/184))
  - On an unfetched paper, verify source status and explicit Fetch. Starting a reading without
    pressing Fetch should still auto-fetch.
  - Progress should remain visible/current, failures should be explicit, and re-entering should
    reattach to the durable job.
  - Exercise a candidate confirmation plus PDF-link or native PDF-upload recovery if practical.
    If this dev client predates `expo-document-picker`, native upload is `BLOCKED` rather than a
    product failure; it should explain that a rebuild is needed and keep PDF-link recovery usable.
  - **Result:** PASS
  - **Notes / evidence:**
    - Source status, explicit Fetch, auto-fetch on reading, visible progress, and re-entry/reattachment worked well.
    - Fetch failure and recovery were not exercised because no fetch failed.
    - Native PDF upload is BLOCKED/not available in the installed dev client; PDF-link fallback remains the expected recovery path.

- [x] **D14 — Sequential migration-Notes review** ([#172](https://github.com/kamilkhan52/research-companion/pull/172))
  - Move multiple read papers with committed Notes and request Notes integration.
  - Working Notes review should open immediately, present one paper at a time, and advance only
    after Apply or Discard. Each applied proposal should be committed before the next is generated.
  - **Result:** PASS
  - **Notes / evidence:**
    - Sequential paper-by-paper migration Notes review works and advances correctly.
    - Auto-scroll to the bottom so the active “Preparing a notes revision” state is always visible.
    - Add a simple, robust diff review showing added and removed content.
    - Redesign the bottom review actions; current controls are visually awkward and wrap poorly.
    - Paper references in Working Notes should be tagged/clickable for fast in-app navigation.
    - Working Notes agents should receive the same default output/formatting instructions as other Notes agents.
    - Show words drafted rather than characters drafted.
    - Integration should receive full paper text plus relevant discussion/chat context so revisions are as context-aware as the original drafting.
    - Evidence: `/mnt/data/Screenshot_2026-07-21-14-48-56-24_c32734a745be661d33dd70aa24fcce64.jpg`.

- [x] **D15 — Move/Copy preserves the complete paper history** ([#172](https://github.com/kamilkhan52/research-companion/pull/172), [#187](https://github.com/kamilkhan52/research-companion/pull/187))
  - Move and Copy a read paper with Notes, multiple threads, a retry branch, source text, and
    completed Map-derived data. Open it in the destination.
  - Threads, transcript, branches, state, Notes, source, and relevant cached information should be
    present. Copy leaves an independent source copy; Move removes the source membership.
  - The destination Map should become stale and request a rebuild—not silently inherit the source
    graph snapshot. Rebuild it and verify the transferred per-paper caches can be reused.
  - **Result:** PASS
  - **Notes / evidence:**
    - Move/Copy preserved the tested history and destination behavior, including source membership semantics and Map staleness/rebuild behavior.

- [x] **D16 — Cross-project duplicate awareness and reuse** ([#188](https://github.com/kamilkhan52/research-companion/pull/188))
  - Attempt to add a paper already present in another project through more than one add surface.
  - Expect Cancel, safe-default Copy/reuse, and explicit Move choices with available source/Notes/
    discussion work described. Confirm the chosen action and any Notes review occur immediately.
  - **Result:** PASS
  - **Notes / evidence:**
    - Cross-project duplicate detection and Cancel, Copy/reuse, and Move choices worked well.

- [x] **D17 — First Build Graph tap has immediate project-scoped feedback** ([#173](https://github.com/kamilkhan52/research-companion/pull/173))
  - In a new project, tap Build Graph once.
  - A starting/running state must appear immediately. A second tap must not start a duplicate, and
    switching projects must not apply the prior project's late job state.
  - **Result:** FAIL
  - **Notes / evidence:**
    - OnePlus 15: the first Build Graph tap briefly opens the stages/progress view, then immediately reverts to the Build Graph button view.
    - A second tap opens the stages view and it stays. This appears to be a state/view reversion, not a duplicate-job problem.
    - Expected: the first tap transitions to the running progress view and remains there.

- [x] **D18 — Progress connectors stay behind circles everywhere** ([#173](https://github.com/kamilkhan52/research-companion/pull/173))
  - Observe completed/in-progress timelines in both Map and Discover.
  - No connector line may enter a circle or paint over a completed checkmark at any density/theme.
  - **Result:** PASS
  - **Notes / evidence:**
    - Connector lines remain behind progress circles/checkmarks; overlap issue is fixed.
    - Related Discover issue: Search appears to have the same first-tap flash/revert behavior as Build Graph.
    - Add Cancel/Stop for a running search. Show partial results when safely available; otherwise show a clear cancelled/empty state.

- [x] **D19 — Map pagination, labels, and in-plot controls** ([#173](https://github.com/kamilkhan52/research-companion/pull/173))
  - Use a Map with more than 50 matching nodes.
  - It should reveal 50 more at a time. “Total citations,” “Cited in project,” and “Significant
    citation” must be unambiguous. “Showing n of N” and ± controls belong inside the plot; the old
    redundant “N matches” strip must be absent.
  - **Result:** PASS
  - **Notes / evidence:**
    - Map pagination, labels, and in-plot controls looked good.
    - Space-saving improvement: move current paper name and active process into a collapsible details disclosure.
    - Use a collapsible horizontal filter rail: a compact chevron expands the filter controls and the reverse chevron collapses them.

- [x] **D20 — Discover placeholder and result quality** ([#173](https://github.com/kamilkhan52/research-companion/pull/173), [#186](https://github.com/kamilkhan52/research-companion/pull/186))
  - Confirm the search field uses brief generic copy rather than a narrow example.
  - Try at least two known topics and record whether foundational/important papers appear alongside
    relevant recent work. Note obvious misses, weak arXiv-only clusters, duplicates, or questionable
    institution/credibility ranking.
  - **Result:** PASS
  - **Notes / evidence:**
    - Limited quality coverage: Discover query “Reinforcement learning for system design problems” completed all stages but returned no papers; investigate that specific backend/job execution.
    - The UI exposes too little ranking evidence to assess whether results are better. Add concise signals such as author affiliations, venue, recency, citation data, and why each paper was selected.
    - The oversized “Have a specific paper? Add by name or link?” button appears at the bottom of results and elsewhere. Replace it with the same compact, uniform Add entry point used throughout the app.
    - A second independent known-topic quality sample was not completed during this pass.

- [x] **D21 — Authors and Labs are bounded and useful** ([#174](https://github.com/kamilkhan52/research-companion/pull/174), [#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Authors should start at 10; researched Labs at 5; additional ranked pages require Show More.
  - Affiliation labels and ranking should be plausible, space-bounded, and should not turn an
    institution's brand into an unsupported credibility claim.
  - **Result:** PASS
  - **Notes / evidence:**
    - Authors and Labs are bounded as expected and Show More behavior is available.
    - UI is space-heavy: replace “x in project / y significant / z external” text with compact icon-and-count metadata.
    - Remove the unexplained year from author/lab name boxes.
    - Research Labs (web pass) appears to research authors but does not visibly populate results.
    - Labs currently resembles authors sorted by affiliation; redesign it to foreground labs/institutions and their evidence rather than repeating the Authors view.
    - Rename “Generate Profile” to “Get Profile”; increase output token budget and specify desired profile length in the prompt.
    - Evidence: `/mnt/data/Screenshot_2026-07-21-18-32-33-32_c32734a745be661d33dd70aa24fcce64.jpg`.

- [x] **D22 — Developer graph rebuild and Labs empty state** ([#115](https://github.com/kamilkhan52/research-companion/pull/115))
  - **Conditional:** requires `RC_DEV=1` on the backend.
  - Force rebuild from scratch and verify the option is dev-only, the rebuild visibly restarts,
    affiliations refresh, and an empty Labs board explains the missing evidence clearly.
  - **Result:** PASS
  - **Notes / evidence:**
    - Developer graph rebuild and Labs empty-state behavior worked.

- [x] **D23 — Paper-summary Retry exposes prompt and model configuration** ([#185](https://github.com/kamilkhan52/research-companion/pull/185))
  - Retry the paper summary, change reading mode and optionally the one-shot model, and generate.
  - The compact sheet should reveal descriptions/options only when needed. Switching retry branches
    should restore each branch's prompt/mode; later-response retry must not rewrite first-turn setup.
  - **Result:** PASS
  - **Notes / evidence:**
    - Paper-summary Retry, reading-mode/model configuration, branch restoration, and later-response retry behavior worked.

- [x] **D24 — Independent threads on one paper** ([#187](https://github.com/kamilkhan52/research-companion/pull/187))
  - Start a new thread with arbitrary text, switch between it and main, and run replies/tool use.
  - Transcripts, drafts, retries, audio, and pending sentence comments must remain thread-isolated.
    Finish reading and confirm the Notes proposal can synthesize insights across threads.
  - **Result:** PASS
  - **Notes / evidence:**
    - Independent threads and their state remained isolated; cross-thread Notes synthesis looked good.

- [x] **D25 — Edit-message view matches the server rewind** ([#175](https://github.com/kamilkhan52/research-companion/pull/175))
  - Edit a user message that has later turns after it.
  - Only the preceding assistant response and the editable draft should remain visible; the original
    user bubble and later tail must stay hidden through regeneration.
  - **Result:** PASS
  - **Notes / evidence:**
    - Edit-message view matched the expected rewind and regeneration behavior.

- [x] **D26 — Sentence annotation flow** ([#178](https://github.com/kamilkhan52/research-companion/pull/178)–[#181](https://github.com/kamilkhan52/research-companion/pull/181))
  - Long-press an assistant response: the normal action menu should open. Choose “Comment on this”
    to enter sentence selection; arbitrary native character-range selection is not expected.
  - Select several sentences, add comments, edit/remove queued comments, send with or without typed
    text, and confirm annotations clear only after server acceptance. Done exits cleanly.
  - **Result:** PASS
  - **Notes / evidence:**
    - Sentence annotation flow works and the queued-comment UI is well liked.
    - UX/data-model improvement: keep comments as attachment-like structured items above the composer; do not convert them into visible pasted text in the message box.
    - Append the structured comments to the outgoing user message on the backend so the agent receives the same context without cluttering typed text.

- [x] **D27 — Figures prefetch and inline cards** ([#176](https://github.com/kamilkhan52/research-companion/pull/176))
  - Fetch a figure-rich arXiv paper and start its paper summary.
  - One or two genuinely central `Figure N` references should render the matching cached card near
    first mention, with image/caption/source. Missing or failed assets must degrade cleanly.
  - **Result:** FAIL
  - **Notes / evidence:**
    - Inline figure cards can render correctly, and after manually changing the custom prompt the paper summary did include figures.
    - Default prompt coverage appears insufficient. The observed custom prompt said: “Figures: Always note and highlight any figures referenced in the section you are discussing so I can go the paper and look at the figure for reference.” That wording likely asks the model to mention figure references rather than produce UI-renderable figure cards.
    - Ensure all summary/paper-summary prompts clearly request 1–3 central figures when available and specify the exact UI-renderable figure-reference format.
    - Figure cards currently appear after the prose that discusses the figure. Prefer placing the card immediately before, or exactly at, the first figure discussion.
    - Ask the implementation agent to verify prompt correctness and coverage across all paper-summary/summary paths.
    - Product naming: call the first paper response **Summary** everywhere: backend, docs, code, frontend, and user-facing agent responses.


- [x] **D28 — Generated citations never leave dangling numeric references** ([#150](https://github.com/kamilkhan52/research-companion/pull/150))
  - Generate several first and follow-up responses that cite the current paper, project papers, and
    external literature; include at least one response with multiple references.
  - Project/external citations should use the app's navigable citation treatment. No bare numeric
    references such as `[11]` may remain without a matching, usable destination.
  - **Result:** PASS
  - **Notes / evidence:**
    - Generated citations look good in tested first and follow-up responses. No dangling bare numeric references observed.

- [x] **D29 — Discussion scrolling and action gestures remain stable** ([#33](https://github.com/kamilkhan52/research-companion/pull/33), [#94](https://github.com/kamilkhan52/research-companion/pull/94), [#138](https://github.com/kamilkhan52/research-companion/pull/138))
  - While a long answer streams, remain near the bottom and then deliberately scroll upward.
  - Near-bottom should follow new text; reading older text must not be dragged down. Long-press menus
    should work without breaking scroll, and no second motionless scrollbar thumb should appear.
  - **Result:** PASS
  - **Notes / evidence:**
    - Long streaming-answer scroll behavior works: near-bottom follows new text, manual upward scrolling is respected, long-press menus remain usable, and no duplicate static scrollbar thumb was observed.

- [x] **D30 — Settings organization and prompt inspection/editing** ([#116](https://github.com/kamilkhan52/research-companion/pull/116))
  - Verify Settings order: Connection → Models → Audio → Map → Agent → Usage → Developer.
  - Prompt status should show source/path/validity. **Conditional (`RC_DEV=1`):** edit a valid prompt,
    reject an invalid marker/placeholder edit without losing the last valid prompt, then restore it.
  - **Result:** PASS
  - **Notes / evidence:**
    - Settings section order and prompt inspection/edit/validation behavior looked good in the tested dev configuration.

## E. Audio, player, and native behavior

- [x] **D31 — Preview cues remain varied until final audio is playable** ([#177](https://github.com/kamilkhan52/research-companion/pull/177), [#191](https://github.com/kamilkhan52/research-companion/pull/191))
  - Use a long response in stitched-full mode and, separately, segmented mode.
  - Cues should continue after written analysis completes until final/first playable audio is ready,
    use prior spoken cues to avoid repetition, mention genuine research/tool activity when useful,
    and never ask the waiting listener to read the response.
  - Final readiness must discard queued late cues and hand off once, without interrupting active
    user/final audio or repeating a generic “synthesizing” message.
  - **Result:** BLOCKED
  - **Notes / evidence:** Skipped/blocked for this pass because the current installed build does not include the needed audio/native-build support. Revisit with a native build before final audio sign-off.

- [x] **D32 — Progressive playback and direct sentence seek** ([#28](https://github.com/kamilkhan52/research-companion/pull/28), [#75](https://github.com/kamilkhan52/research-companion/pull/75))
  - In segmented mode, playback should begin before all segments finish and cross segment boundaries
    without interruption; combined-file replay should still work later.
  - Test on-screen and headset previous/next. Direct sentence seeks should begin at or just before
    the sentence—not several words late. Missing sentence metadata should fall back to ±15 seconds.
  - **Result:** PASS
  - **Notes / evidence:** Direct sentence seek works via headset controls, on-screen UI, and tapping a sentence. Segmented progressive playback / segment-boundary continuity / combined-file replay remain deferred for later audio-specific testing.

- [x] **D33 — Background, lock-screen, queue, and relaunch audio** ([#19](https://github.com/kamilkhan52/research-companion/pull/19), [#192](https://github.com/kamilkhan52/research-companion/pull/192))
  - Start listening, background the app, lock the phone, and remove the app from recents where the
    OS permits. Playback/cues should continue; lock-screen metadata and controls should remain useful.
  - Queue another response without interrupting the active track, relaunch/resume position, and turn
    Listening mode off while a track is active without corrupting the queue.
  - This requires an installed native build containing the background-audio configuration.
  - **Result:** BLOCKED
  - **Notes / evidence:** Blocked/skipped for this pass because the current installed build does not include the required background-audio native configuration. Requires a native rebuild before acceptance.

- [x] **D34 — Cancel in-flight audio synthesis** ([#83](https://github.com/kamilkhan52/research-companion/pull/83))
  - Start a long synthesis, cancel before completion, leave/reopen the screen, and retry.
  - Cancellation should settle visibly, prevent late enqueue/playback, and not poison a later retry.
  - **Result:** BLOCKED
  - **Notes / evidence:** Blocked/skipped for this pass with the rest of the audio-specific scenarios until an appropriate native build is available.

- [x] **D35 — Player presentation and controls** ([#174](https://github.com/kamilkhan52/research-companion/pull/174), [#182](https://github.com/kamilkhan52/research-companion/pull/182))
  - Open full player: the mini-player should disappear cleanly and reliably return on minimize/Back.
  - Verify the selected outboard −15/+15 pills, sentence controls, centered play glyph, and enlarged
    playback-speed control are aligned, tappable, and visually coherent in all three themes.
  - **Result:** BLOCKED
  - **Notes / evidence:** Blocked/skipped for this pass with the rest of the audio/player scenarios until an appropriate native build is available.

## F. Appearance, navigation, and remaining spot checks

- [x] **D36 — Comfortable/Tight density** ([#189](https://github.com/kamilkhan52/research-companion/pull/189))
  - Toggle density, navigate across Library, long titles, cards, chat, sheets, Map, and player, then
    restart the app.
  - Tight should restore before first paint and reduce common type/spacing without clipping titles,
    shrinking touch targets, or harming math/code/audio controls.
  - **Result:** PASS
  - **Notes / evidence:** Tight density works on OnePlus 15. No clipping, touch-target, or restart-persistence issues reported in tested areas.

- [x] **D37 — Theme/system behavior and refined palette** ([#130](https://github.com/kamilkhan52/research-companion/pull/130)–[#135](https://github.com/kamilkhan52/research-companion/pull/135), [#182](https://github.com/kamilkhan52/research-companion/pull/182))
  - Verify System follows OS changes; manually test Light, Dim, and Black across sheets, progress,
    graph, annotations, and audio controls. Black should retain a true-black canvas.
  - Check status/navigation chrome after cold launch for flashes, stale colors, or unreadable accents.
  - **Result:** PASS
  - **Notes / evidence:** Themes are behaving well across tested modes on OnePlus 15. System/Light/Dim/Black behavior looked correct; no status/navigation chrome flashes or unreadable accent issues reported.

- [x] **D38 — P-only launcher/splash/monochrome icon** ([#194](https://github.com/kamilkhan52/research-companion/pull/194))
  - **Native reinstall required; Metro cannot update these assets.**
  - Confirm the launcher icon contains only the slab-serif P, adaptive cropping is safe, themed/
    monochrome Android treatment is recognizable, and splash/small-size rendering stays crisp.
  - **Result:** BLOCKED
  - **Notes / evidence:** Current installed build does not include the required native launcher/splash/monochrome icon asset update; Metro cannot update these assets. Native reinstall/new build required before testing.

- [x] **D39 — Continue Reading freshness and project identity** ([#76](https://github.com/kamilkhan52/research-companion/pull/76), [#114](https://github.com/kamilkhan52/research-companion/pull/114))
  - Interact with a paper, leave it, and return via Continue Reading.
  - The correct project name—not noisy paper state—should display; ordering should refresh promptly,
    and opening should use the prefetched draft without a visible stale/spinner pause.
  - **Result:** FAIL
  - **Notes / evidence:** Continue Reading opens the discussion but still takes about a second and does not feel snappy. Tester could not tell whether prefetching was actually being used; expected opening should use the prefetched draft without a visible stale/spinner-style pause. No separate project-identity problem was reported in this check.

## G. Screenshot-led polish (record observations; do not block functional sign-off)

- [x] **D40 — Multi-select and density screenshot comparison**
  - Capture Library multi-select with several papers selected in Comfortable and Tight density.
  - Record any remaining crowding, vertical text, clipped titles, or disproportionate action sizes.
  - **Result:** PASS
  - **Notes / evidence / screenshot paths:** Library multi-select looked good in the checked density states; no remaining crowding, vertical/wrapped text, clipped titles, or disproportionate action sizes were reported.

- [x] **D41 — Long-title and sheet screenshot sweep**
  - Capture long paper/project titles in Library, Continue Reading, Discussion TopBar, project sheets,
    and canonical-title confirmation with the keyboard both closed and open.
  - Record only device-specific spacing/type issues; functional behavior belongs in D01/D08/D12.
  - **Result:** PASS
  - **Notes / evidence / screenshot paths:** Long-title layout was not a major problem across Library, Continue Reading, Discussion TopBar, project sheets, or canonical-title confirmation. Keyboard-open state remains poor for new project naming, but that functional/layout defect is already recorded under D08 rather than blocking this screenshot-polish sweep.

## H. Account-isolation follow-up

- [ ] **D42 — Switching accounts starts from that account's own state** (DR-037, DR-044)
  - Sign in as account A, select a project, leave a draft in a discussion, and begin audio if
    practical. Sign out normally, then sign in as account B without clearing app data.
  - B must land in its own Library with no project from A selected. It must not briefly show A's
    plan, project, draft, graph, Continue card, or narration. Navigate between tabs once to catch
    any provider state that survived the auth transition.
  - Force a session-expiry/sign-out event if practical and repeat; that path must behave exactly
    like the Settings sign-out. Finally cold-launch while still signed in as B and confirm B's own
    selected project is remembered across that ordinary restore.
  - **Result:** NOT TESTED
  - **Notes / evidence:** Automated coverage reproduces an A request completing after B signs in,
    but physical-device acceptance remains required after the implementation PR merges.

## Explicitly outside this Android pass

- iOS acceptance (background audio, native icon/splash, Apple sign-in/TestFlight) remains deferred
  until an iOS native build and Apple Developer setup are intentionally scheduled.
- Retrieval-phase spoken cues (roadmap 2.2b), wholesale Markdown parser replacement, global motion
  tuning, and bounded one-hop Map expansion are deferred product work—not failed device tests.
- Web prompt-editing parity is a web follow-up, not a physical-device acceptance item.
- Arbitrary native character-range selection inside assistant Markdown is not shipped; D26 tests the
  approved sentence-level annotation interaction instead.

## Pass summary

- **Passed:** 29 — D01, D02, D04, D05, D07, D09–D11, D13–D16, D18–D26, D28–D30, D32, D36–D37, D40–D41
- **Failed:** 7 — D03, D06, D08, D12, D17, D27, D39
- **Blocked:** 5 — D31, D33–D35, D38 (D13 native PDF-upload sub-path also blocked by installed dev client)
- **Not tested:** 1 — D42
- **Highest-priority follow-ups:**
  1. Preserve active discussion identity/state across explicit paper addition and canonical-title updates; opening an already-started analysis must show its live/existing thread.
  2. Repair Notes generation/review UX: visible progress, automatic review opening, coherent edit request action, and robust diff-based review.
  3. Fix first-tap running-state reversion for Build Graph and Discover/Search; add search cancellation and safe partial-result behavior.
- **General notes:** Android pass completed on OnePlus 15 / Android 16. Audio/player scenarios D31 and D33–D35, plus native icon/splash D38, are blocked until a suitable native build is available. Segmented-playback portions of D32 remain deferred for later audio-specific testing. D13 native PDF upload is also blocked by the installed dev client, while PDF-link recovery remains the relevant fallback.
