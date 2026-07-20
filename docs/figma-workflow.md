# Figma workflow for Research Companion

This project uses Figma as the working design surface for mobile UI redesigns. The current design file is:

- **File:** `Research Companion — UI Redesign Proposal`
- **File key:** `O62BbV7CcCOf3O55HKAjtK`
- **Primary page:** `02 · Mobile Screens`
- **Design-system page:** `01 · Design System`
- **Icon page:** `03 · App Icon — Paradigm`

Do not commit Figma access tokens or paste them into docs. Store the token in the local shell, MCP config, or a password manager.

## Required tooling

Use `figma-console-mcp` for this project:

```text
https://github.com/southleft/figma-console-mcp
```

The working setup is:

1. Figma Desktop is open to the Research Companion design file.
2. The Figma Desktop Bridge plugin is running in that file.
3. `figma-console-mcp` is configured with a Figma token in the environment, usually:

   ```sh
   export FIGMA_ACCESS_TOKEN="<redacted>"
   ```

4. Codex can see the `mcp__figma_console` tools.

To verify the connection, run the Figma diagnostic tool and confirm:

- Desktop Bridge plugin is connected.
- Active file is `Research Companion — UI Redesign Proposal`.
- Current page is usually `02 · Mobile Screens`.
- REST token is detected.

## Start-of-session checklist

At the start of every Figma work session:

1. Run `figma_diagnose`.
2. Run `figma_search_components`.
   - The file may not have local components yet, but this call is still required by the Figma Console workflow.
3. Inspect the page structure before writing anything.
   - Node IDs are session-specific enough that they should be rediscovered rather than copied from old notes.
4. Confirm the destination page or section already exists before creating a new one.
   - Do not duplicate pages named `02 · Mobile Screens`.

## Current Figma structure

The mobile proposal page currently contains these editable frames:

- `01 · Library`
- `02 · Discover`
- `03 · Discussion`
- `04 · Reference Map`
- `05 · Working Notes`
- `06 · Related Works`
- `07 · External Reference`
- `08a · Chat main`
- `08b · Model + thinking picker`
- `08c · Actions menu`

It also contains section:

- `09 · Additional App States`

with frames:

- `08 · Settings / Connect`
- `09 · Start Reading`
- `10 · Discover Setup`
- `11 · Notes AI Revision`
- `12 · Audio Player`
- `13 · Graph Recommendations`

and the later implementation sections:

- `14 · Player Jump Controls · Selected Design` — selected K1 transport layout, including
  the 64×52 outboard ±15-second controls and 52×52 sentence controls
- `15 · Paper Cover`
- `16 · Prompts, Activity & General Actions`
- `U.23 · Audio loading`

The design-system page also contains the implemented comparison sections:

- `Palette refinement · Dim / Black / Light`
- `Density · Comfortable / Tight`

The icon page contains:

- `Icon comps — top 3 (R7.10)` — superseded exploration retained for history
- `Paradigm P · Final (R7.10)` — the current P-only launcher, compact-size, adaptive-safe-zone,
  and monochrome proofs

Keep future work organized in named sections. Do not place loose components or frames directly on blank canvas unless they are labels for an existing frame group.

## Implemented-design audit (2026-07-19)

The current authorized Figma work has matching production implementation:

| Figma section | Production status |
|---|---|
| `14 · Player Jump Controls · Selected Design` | Implemented and merged in [#182](https://github.com/kamilkhan52/research-companion/pull/182): selected K1 layout with 64×52 outer ±15-second controls, 52×52 sentence controls, and a 72×72 play control |
| `Palette refinement · Dim / Black / Light` | Implemented and merged in [#182](https://github.com/kamilkhan52/research-companion/pull/182) |
| `Density · Comfortable / Tight` | Implemented and merged in [#189](https://github.com/kamilkhan52/research-companion/pull/189) |
| `Paradigm P · Final (R7.10)` | Initial mark implemented in [#182](https://github.com/kamilkhan52/research-companion/pull/182); every proof and platform asset simplified to the P alone in [#194](https://github.com/kamilkhan52/research-companion/pull/194) |

No authorized recent Figma graphic was left unimplemented at this audit. The launcher icon is
a native resource, so its on-device verification requires a rebuild/reinstall rather than a
Metro reload.

## Design language

The redesign direction is a dark, scholarly AI reading companion:

- **Canvas size:** Android/mobile portrait, `393 × 852`.
- **Background:** near-black, subtly atmospheric.
- **Cards:** dark ink surfaces, rounded corners, thin low-contrast borders.
- **Primary accent:** cyan/teal.
- **Secondary accent:** violet.
- **Typography:**
  - `Manrope` for UI, body copy, controls, dense card text.
  - `Newsreader` for editorial headings and selected long-form reading moments.
  - Avoid `Inter` unless explicitly using it as a fallback.

Dense mobile cards should favor Manrope over Newsreader. Newsreader looks good for page-level or article-level hierarchy, but it collides easily in narrow cards.

## Validation workflow

For every visual change:

1. Modify the design using `figma_execute`.
2. Capture the changed node with `figma_capture_screenshot`.
3. Check for:
   - clipped text
   - text collisions
   - controls extending past the 393px viewport
   - cards with inconsistent padding
   - overuse of serif type in dense rows
   - floating nodes outside sections
4. Patch only the visible issue.
5. Re-capture the affected frame.

After a larger pass, run a structural audit with the Figma API:

- count expected frames
- list font families
- report visible text outside frame bounds

The expected font-family result for the current mobile proposal is only:

```text
Manrope
Newsreader
```

## Working from generated screenshots

Generated PNGs are temporary proposal references, not the source of truth. The editable Figma
frame is the durable design record.

Keep candidate images outside the repository while exploring (for example under
`/private/tmp/research-companion-figma-candidates/`). After choosing a direction:

- recreate and validate the selected design as editable Figma layers;
- delete rejected candidates and duplicate exports;
- delete the selected PNG too unless it is still needed for a specific review or handoff;
- if a PNG must remain in `docs/`, keep only the selected final reference and document why it is
  retained.

There are currently no generated proposal-image folders tracked or retained locally for this
project. The frames listed above are the source of truth.

When a missing app state has not been designed yet:

1. Generate the screenshot proposal first.
2. Keep candidate variants in a temporary directory outside the repository.
3. Recreate the state as an editable Figma frame.
4. Validate the Figma frame visually.
5. Delete the temporary candidates once the frame is accepted.

## Live app review

When possible, review the actual app before designing. The mobile app lives under `mobile/`.

Useful source files for UI state mapping:

- `mobile/src/app/index.tsx` — Library and disconnected state
- `mobile/src/app/settings.tsx` — Settings/connect flow
- `mobile/src/app/discover.tsx` — Discover setup, progress, recommendations
- `mobile/src/app/paper/[slug].tsx` — Discussion and start-reading states
- `mobile/src/app/graph.tsx` — Reference graph
- `mobile/src/app/notes/[target].tsx` — Working notes and revisions
- `mobile/src/app/player.tsx` — Full listening mode

If the app opens in the disconnected state, use Settings/connect as live reference and use source files plus existing screenshots for data-backed states.

## Safe editing rules

- Never commit Figma tokens.
- Never rely on old node IDs without rediscovering them.
- Do not create duplicate pages.
- Do not leave helper layers, blank frames, or failed-attempt artifacts.
- Prefer small targeted patches over full rebuilds after a frame is mostly correct.
- Keep chat redesign frames intact unless the task is explicitly about chat.
- If Figma screenshot usage limits are hit, stop retrying screenshots and continue only with low-risk structural/text audits.

## Commit guidance

For design-only Figma work, there may be no repo changes unless generated proposal PNGs or docs were added.

When committing this guide or proposal assets:

1. Check status:

   ```sh
   git status --short --branch
   ```

2. Stage only the intended files.
3. Avoid accidentally committing local generated folders unless they are part of the requested handoff.
4. Use a specific commit message, for example:

   ```sh
   git commit -m "docs: add figma workflow guide"
   ```
