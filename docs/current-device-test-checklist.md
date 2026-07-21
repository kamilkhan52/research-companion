# Current device-test checklist

Canonical manual acceptance record for the current Android build. Update this file directly as
tests are performed; the older Round-9/Round-10 queue documents remain historical implementation
ledgers, not competing test lists.

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
- **Device / OS:** <!-- fill in -->
- **Installed app build/version:** <!-- fill in -->
- **Pass started:** <!-- fill in -->
- **Pass completed:** <!-- fill in -->

## A. Immediate regression checks — do these first

- [ ] **D01 — Discussion composer grows with the message** ([#198](https://github.com/kamilkhan52/research-companion/pull/198))
  - Enter a message that wraps across at least six visual lines; also try explicit line breaks.
  - The field should grow smoothly from one line to roughly four lines, keep its rounded card
    intact, then scroll internally. Sending/clearing should return it to one line.
  - The composer should remain full-width, with Send inside the rounded card and no straight
    separator or border extending beyond the card.
  - Repeat while editing an earlier message; focus, cursor, draft text, and Send must still work.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D02 — Pending-response activity is contextual** ([#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Start a first read, a later reply, and—if available—a turn that searches or reads figures.
  - Before answer text appears, expect truthful states such as “Reading the paper,” “Viewing
    figures,” “Tracing project citations,” “Searching the literature,” or “Analyzing results.”
  - The old generic “Preparing a response” should not appear, and the activity should disappear
    once response text is visible.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D03 — First response cannot draft Notes without permission** ([#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Start a new paper discussion and let the opening response finish.
  - It must remain an ordinary discussion response even if the model emits Notes-like sections.
  - Then choose Finish reading and confirm that an explicitly requested Notes proposal still opens
    the human review/commit flow.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D04 — Last Interacted sorting** ([#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Interact with discussions on two different papers, then return to Library sorting.
  - “Last interacted → Most recent first” must put the newest discussion first; the reverse option
    must invert known timestamps. Papers never discussed should remain last in both directions.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D05 — Top-two affiliations appear without blocking first read** ([#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Fetch a paper whose first page contains several institutional affiliations, then begin reading.
  - Fetch/analysis must not wait for affiliation extraction. Once ready, at most the two most common
    affiliations should appear beside title/year in Library and Discussion without crowding them.
  - Leave/reopen the screen to ensure `pending` resolves rather than polling forever.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D06 — Opening summary explains incoming project citations** ([#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Use a project with a completed Map where later project papers cite the paper being opened.
  - The first summary should explain how those later papers use it and distinguish substantive use
    from a background citation. It must not invent relationships absent from the Map evidence.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

## B. Sheets, Library, and project operations

- [ ] **D07 — Hardware Back dismisses only the active sheet** ([#171](https://github.com/kamilkhan52/research-companion/pull/171))
  - Open Projects options and at least one other bottom sheet, then press Android Back.
  - The first Back should lower only the sheet; it must not also navigate the underlying screen.
    A second Back may navigate normally.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D08 — Keyboard automatically expands and scrolls sheets** ([#171](https://github.com/kamilkhan52/research-companion/pull/171))
  - Test create/rename/split fields, including a Projects sheet with four or more projects.
  - Focusing the field should reveal the input and actions above the keyboard automatically.
    Manual drag and content scrolling must continue to work while the keyboard is open.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D09 — Empty project has two clear Add Papers paths** ([#183](https://github.com/kamilkhan52/research-companion/pull/183))
  - Open a new empty project.
  - Expect a prominent designed surface with separate “specific paper” and Discover/Explore paths,
    not a long text-only button or a flow that makes paper addition belong only to Discover.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D10 — Hierarchical sort directions remain clean** ([#183](https://github.com/kamilkhan52/research-companion/pull/183))
  - Open each sort category and its second-level directions, then Back out without changing it.
  - Name defaults A→Z. Publication date and Date added default oldest→newest. Unknown dates remain
    last. Also retest Last Interacted from D04.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D11 — Multi-select actions are compact and explicit** ([#183](https://github.com/kamilkhan52/research-companion/pull/183))
  - Select several papers, including enough that the old action row would have crowded the count.
  - “N selected” must remain horizontal/readable; Move, Copy, and Delete must be distinct compact
    actions. Only Move should imply source removal.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D12 — Canonical title confirmation and paper edit menu** ([#184](https://github.com/kamilkhan52/research-companion/pull/184))
  - Add a paper using an incomplete or mistyped title and complete resolution.
  - The found canonical title should be shown and offered as a confirmation—not silently applied.
  - Verify paper Rename preserves Notes/discussion/history and Delete remains available from both
    the menu and existing swipe behavior.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D13 — Durable source status, Fetch, and recovery** ([#184](https://github.com/kamilkhan52/research-companion/pull/184))
  - On an unfetched paper, verify source status and explicit Fetch. Starting a reading without
    pressing Fetch should still auto-fetch.
  - Progress should remain visible/current, failures should be explicit, and re-entering should
    reattach to the durable job.
  - Exercise a candidate confirmation plus PDF-link or native PDF-upload recovery if practical.
    If this dev client predates `expo-document-picker`, native upload is `BLOCKED` rather than a
    product failure; it should explain that a rebuild is needed and keep PDF-link recovery usable.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D14 — Sequential migration-Notes review** ([#172](https://github.com/kamilkhan52/research-companion/pull/172))
  - Move multiple read papers with committed Notes and request Notes integration.
  - Working Notes review should open immediately, present one paper at a time, and advance only
    after Apply or Discard. Each applied proposal should be committed before the next is generated.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D15 — Move/Copy preserves the complete paper history** ([#172](https://github.com/kamilkhan52/research-companion/pull/172), [#187](https://github.com/kamilkhan52/research-companion/pull/187))
  - Move and Copy a read paper with Notes, multiple threads, a retry branch, source text, and
    completed Map-derived data. Open it in the destination.
  - Threads, transcript, branches, state, Notes, source, and relevant cached information should be
    present. Copy leaves an independent source copy; Move removes the source membership.
  - The destination Map should become stale and request a rebuild—not silently inherit the source
    graph snapshot. Rebuild it and verify the transferred per-paper caches can be reused.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D16 — Cross-project duplicate awareness and reuse** ([#188](https://github.com/kamilkhan52/research-companion/pull/188))
  - Attempt to add a paper already present in another project through more than one add surface.
  - Expect Cancel, safe-default Copy/reuse, and explicit Move choices with available source/Notes/
    discussion work described. Confirm the chosen action and any Notes review occur immediately.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

## C. Map, Discover, Authors, and Labs

- [ ] **D17 — First Build Graph tap has immediate project-scoped feedback** ([#173](https://github.com/kamilkhan52/research-companion/pull/173))
  - In a new project, tap Build Graph once.
  - A starting/running state must appear immediately. A second tap must not start a duplicate, and
    switching projects must not apply the prior project's late job state.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D18 — Progress connectors stay behind circles everywhere** ([#173](https://github.com/kamilkhan52/research-companion/pull/173))
  - Observe completed/in-progress timelines in both Map and Discover.
  - No connector line may enter a circle or paint over a completed checkmark at any density/theme.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D19 — Map pagination, labels, and in-plot controls** ([#173](https://github.com/kamilkhan52/research-companion/pull/173))
  - Use a Map with more than 50 matching nodes.
  - It should reveal 50 more at a time. “Total citations,” “Cited in project,” and “Significant
    citation” must be unambiguous. “Showing n of N” and ± controls belong inside the plot; the old
    redundant “N matches” strip must be absent.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D20 — Discover placeholder and result quality** ([#173](https://github.com/kamilkhan52/research-companion/pull/173), [#186](https://github.com/kamilkhan52/research-companion/pull/186))
  - Confirm the search field uses brief generic copy rather than a narrow example.
  - Try at least two known topics and record whether foundational/important papers appear alongside
    relevant recent work. Note obvious misses, weak arXiv-only clusters, duplicates, or questionable
    institution/credibility ranking.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D21 — Authors and Labs are bounded and useful** ([#174](https://github.com/kamilkhan52/research-companion/pull/174), [#196](https://github.com/kamilkhan52/research-companion/pull/196))
  - Authors should start at 10; researched Labs at 5; additional ranked pages require Show More.
  - Affiliation labels and ranking should be plausible, space-bounded, and should not turn an
    institution's brand into an unsupported credibility claim.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D22 — Developer graph rebuild and Labs empty state** ([#115](https://github.com/kamilkhan52/research-companion/pull/115))
  - **Conditional:** requires `RC_DEV=1` on the backend.
  - Force rebuild from scratch and verify the option is dev-only, the rebuild visibly restarts,
    affiliations refresh, and an empty Labs board explains the missing evidence clearly.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

## D. Discussion, annotations, figures, and threads

- [ ] **D23 — First-response Retry exposes prompt and model configuration** ([#185](https://github.com/kamilkhan52/research-companion/pull/185))
  - Retry the first response, change reading mode and optionally the one-shot model, and generate.
  - The compact sheet should reveal descriptions/options only when needed. Switching retry branches
    should restore each branch's prompt/mode; later-response retry must not rewrite first-turn setup.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D24 — Independent threads on one paper** ([#187](https://github.com/kamilkhan52/research-companion/pull/187))
  - Start a new thread with arbitrary text, switch between it and main, and run replies/tool use.
  - Transcripts, drafts, retries, audio, and pending sentence comments must remain thread-isolated.
    Finish reading and confirm the Notes proposal can synthesize insights across threads.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D25 — Edit-message view matches the server rewind** ([#175](https://github.com/kamilkhan52/research-companion/pull/175))
  - Edit a user message that has later turns after it.
  - Only the preceding assistant response and the editable draft should remain visible; the original
    user bubble and later tail must stay hidden through regeneration.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D26 — Sentence annotation flow** ([#178](https://github.com/kamilkhan52/research-companion/pull/178)–[#181](https://github.com/kamilkhan52/research-companion/pull/181))
  - Long-press an assistant response: the normal action menu should open. Choose “Comment on this”
    to enter sentence selection; arbitrary native character-range selection is not expected.
  - Select several sentences, add comments, edit/remove queued comments, send with or without typed
    text, and confirm annotations clear only after server acceptance. Done exits cleanly.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D27 — Figures prefetch and inline cards** ([#176](https://github.com/kamilkhan52/research-companion/pull/176))
  - Fetch a figure-rich arXiv paper and start its first analysis.
  - One or two genuinely central `Figure N` references should render the matching cached card near
    first mention, with image/caption/source. Missing or failed assets must degrade cleanly.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D28 — Generated citations never leave dangling numeric references** ([#150](https://github.com/kamilkhan52/research-companion/pull/150))
  - Generate several first and follow-up responses that cite the current paper, project papers, and
    external literature; include at least one response with multiple references.
  - Project/external citations should use the app's navigable citation treatment. No bare numeric
    references such as `[11]` may remain without a matching, usable destination.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D29 — Discussion scrolling and action gestures remain stable** ([#33](https://github.com/kamilkhan52/research-companion/pull/33), [#94](https://github.com/kamilkhan52/research-companion/pull/94), [#138](https://github.com/kamilkhan52/research-companion/pull/138))
  - While a long answer streams, remain near the bottom and then deliberately scroll upward.
  - Near-bottom should follow new text; reading older text must not be dragged down. Long-press menus
    should work without breaking scroll, and no second motionless scrollbar thumb should appear.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D30 — Settings organization and prompt inspection/editing** ([#116](https://github.com/kamilkhan52/research-companion/pull/116))
  - Verify Settings order: Connection → Models → Audio → Map → Agent → Usage → Developer.
  - Prompt status should show source/path/validity. **Conditional (`RC_DEV=1`):** edit a valid prompt,
    reject an invalid marker/placeholder edit without losing the last valid prompt, then restore it.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

## E. Audio, player, and native behavior

- [ ] **D31 — Preview cues remain varied until final audio is playable** ([#177](https://github.com/kamilkhan52/research-companion/pull/177), [#191](https://github.com/kamilkhan52/research-companion/pull/191))
  - Use a long response in stitched-full mode and, separately, segmented mode.
  - Cues should continue after written analysis completes until final/first playable audio is ready,
    use prior spoken cues to avoid repetition, mention genuine research/tool activity when useful,
    and never ask the waiting listener to read the response.
  - Final readiness must discard queued late cues and hand off once, without interrupting active
    user/final audio or repeating a generic “synthesizing” message.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D32 — Progressive playback and direct sentence seek** ([#28](https://github.com/kamilkhan52/research-companion/pull/28), [#75](https://github.com/kamilkhan52/research-companion/pull/75))
  - In segmented mode, playback should begin before all segments finish and cross segment boundaries
    without interruption; combined-file replay should still work later.
  - Test on-screen and headset previous/next. Direct sentence seeks should begin at or just before
    the sentence—not several words late. Missing sentence metadata should fall back to ±15 seconds.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D33 — Background, lock-screen, queue, and relaunch audio** ([#19](https://github.com/kamilkhan52/research-companion/pull/19), [#192](https://github.com/kamilkhan52/research-companion/pull/192))
  - Start listening, background the app, lock the phone, and remove the app from recents where the
    OS permits. Playback/cues should continue; lock-screen metadata and controls should remain useful.
  - Queue another response without interrupting the active track, relaunch/resume position, and turn
    Listening mode off while a track is active without corrupting the queue.
  - This requires an installed native build containing the background-audio configuration.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D34 — Cancel in-flight audio synthesis** ([#83](https://github.com/kamilkhan52/research-companion/pull/83))
  - Start a long synthesis, cancel before completion, leave/reopen the screen, and retry.
  - Cancellation should settle visibly, prevent late enqueue/playback, and not poison a later retry.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D35 — Player presentation and controls** ([#174](https://github.com/kamilkhan52/research-companion/pull/174), [#182](https://github.com/kamilkhan52/research-companion/pull/182))
  - Open full player: the mini-player should disappear cleanly and reliably return on minimize/Back.
  - Verify the selected outboard −15/+15 pills, sentence controls, centered play glyph, and enlarged
    playback-speed control are aligned, tappable, and visually coherent in all three themes.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

## F. Appearance, navigation, and remaining spot checks

- [ ] **D36 — Comfortable/Tight density** ([#189](https://github.com/kamilkhan52/research-companion/pull/189))
  - Toggle density, navigate across Library, long titles, cards, chat, sheets, Map, and player, then
    restart the app.
  - Tight should restore before first paint and reduce common type/spacing without clipping titles,
    shrinking touch targets, or harming math/code/audio controls.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D37 — Theme/system behavior and refined palette** ([#130](https://github.com/kamilkhan52/research-companion/pull/130)–[#135](https://github.com/kamilkhan52/research-companion/pull/135), [#182](https://github.com/kamilkhan52/research-companion/pull/182))
  - Verify System follows OS changes; manually test Light, Dim, and Black across sheets, progress,
    graph, annotations, and audio controls. Black should retain a true-black canvas.
  - Check status/navigation chrome after cold launch for flashes, stale colors, or unreadable accents.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D38 — P-only launcher/splash/monochrome icon** ([#194](https://github.com/kamilkhan52/research-companion/pull/194))
  - **Native reinstall required; Metro cannot update these assets.**
  - Confirm the launcher icon contains only the slab-serif P, adaptive cropping is safe, themed/
    monochrome Android treatment is recognizable, and splash/small-size rendering stays crisp.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

- [ ] **D39 — Continue Reading freshness and project identity** ([#76](https://github.com/kamilkhan52/research-companion/pull/76), [#114](https://github.com/kamilkhan52/research-companion/pull/114))
  - Interact with a paper, leave it, and return via Continue Reading.
  - The correct project name—not noisy paper state—should display; ordering should refresh promptly,
    and opening should use the prefetched draft without a visible stale/spinner pause.
  - **Result:** NOT TESTED
  - **Notes / evidence:**

## G. Screenshot-led polish (record observations; do not block functional sign-off)

- [ ] **D40 — Multi-select and density screenshot comparison**
  - Capture Library multi-select with several papers selected in Comfortable and Tight density.
  - Record any remaining crowding, vertical text, clipped titles, or disproportionate action sizes.
  - **Result:** NOT TESTED
  - **Notes / evidence / screenshot paths:**

- [ ] **D41 — Long-title and sheet screenshot sweep**
  - Capture long paper/project titles in Library, Continue Reading, Discussion TopBar, project sheets,
    and canonical-title confirmation with the keyboard both closed and open.
  - Record only device-specific spacing/type issues; functional behavior belongs in D01/D08/D12.
  - **Result:** NOT TESTED
  - **Notes / evidence / screenshot paths:**

## Explicitly outside this Android pass

- iOS acceptance (background audio, native icon/splash, Apple sign-in/TestFlight) remains deferred
  until an iOS native build and Apple Developer setup are intentionally scheduled.
- Retrieval-phase spoken cues (roadmap 2.2b), wholesale Markdown parser replacement, global motion
  tuning, and bounded one-hop Map expansion are deferred product work—not failed device tests.
- Web prompt-editing parity is a web follow-up, not a physical-device acceptance item.
- Arbitrary native character-range selection inside assistant Markdown is not shipped; D26 tests the
  approved sentence-level annotation interaction instead.

## Pass summary

- **Passed:** <!-- count / IDs -->
- **Failed:** <!-- count / IDs -->
- **Blocked:** <!-- count / IDs -->
- **Not tested:** <!-- count / IDs -->
- **Highest-priority follow-ups:**
  1. <!-- fill in -->
  2. <!-- fill in -->
  3. <!-- fill in -->
- **General notes:**
