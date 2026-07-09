# Mobile UI revamp — plan and review protocol

This is the working plan for applying the Figma redesign (`Research Companion — UI Redesign
Proposal`, file key `O62BbV7CcCOf3O55HKAjtK`, page `02 · Mobile Screens`) to the Expo/React
Native app in `mobile/`. It is written for two agents: the **driver** implementing the phases
and the **reviewer** commenting on each PR. Both follow this document. Companion docs:
`docs/figma-workflow.md` (design file structure + design language) and
`docs/claude-code-figma-mcp-handoff.md` (Figma access).

**Scope:** full visual overhaul + navigation restructure of `mobile/` only. Zero backend
changes, zero API-contract changes, no feature removals. Where the Figma proposal is
incomplete or inconsistent (icons, missing states, text collisions), the driver fixes it with
judgment consistent with the design language below.

## Design language

Source: page `01 · Design System` plus the 16 mobile frames (renderable via the Figma REST
API — see `docs/figma-workflow.md`; never commit the token).

### Palette (`mobile/src/theme/tokens.ts`)

| Token | Value | Role |
|---|---|---|
| `bg` | `#0B0D12` | near-black canvas, subtle atmospheric shapes (`bgGlow` `#11141C`) |
| `surface` | `#151922` | cards |
| `elevated` | `#1B202B` | sheets, inputs, raised chips/buttons |
| `text` | `#F3F0E8` | warm off-white |
| `muted` | `#99A3B7` | secondary text |
| `mint` | `#65D6B4` | primary accent — action, progress, approved (`mintInk` `#0A231B` for text on mint) |
| `violet` | `#9B8AFB` | relationship, synthesis, evidence, AI proposals |
| `amber` | `#E4B85C` | bridge/warning |
| `danger` | `#E5738C` | destructive (judgment; the DS omits it) |

The old Neon token names (`panel`, `panel2`, `cyan`, `green`, …) remain as **compat aliases**
pointing at the new palette until the final PR, so screens not yet rebuilt still render
coherently. Same for font aliases `display`/`displayBold`/`mono` (→ Manrope).

### Typography

- **Manrope** — all UI, controls, dense card text. Weights 400/500/600/700.
- **Newsreader** (incl. italics) — editorial headings and long-form reading moments:
  assistant prose, synthesis documents, paper titles on hero cards, epigraphs.
- **Chakra Petch and JetBrains Mono are removed.** No mono *font dependency* remains. One
  audited exception: code blocks / inline code in rendered Markdown and the raw-markdown
  notes editor use the platform's built-in mono face (Menlo / `monospace`) — code is content
  fidelity, not UI chrome, and the design system ships no mono member.
- Text variants live in `mobile/src/ui/index.tsx`: `display`, `title`, `heading`, `body`,
  `label`, `overline`, `caption` (Manrope) and `editorial`, `serifTitle`, `serifBody`,
  `serifItalic` (Newsreader). Dense/narrow cards use Manrope — Newsreader collides in
  tight rows (per `docs/figma-workflow.md`).

### Icons, shape, principles

- Icons come from `@expo/vector-icons` **Feather** via the `Icon`/`IconButton` primitives —
  no text glyphs (`⌕ ✎ ✦ ⋯ ▶︎ ⧉ ⟳`) anywhere in the final state.
- Pill buttons (mint fill + `mintInk` text for primary; elevated + thin border for
  secondary), pill chips (mint outline + mint text when selected), cards radius 20 with
  thin low-contrast borders, circular icon buttons, bottom tab bar.
- Usage principles (from the DS page — these settle judgment calls): mint = action or
  approved progress; violet = relationship, synthesis, evidence; long-form content reads
  like a document, not chat; AI proposes — the researcher reviews and commits; dense data
  starts focused, then reveals detail.

## Frame → code map

| Figma frame | File(s) | Key changes |
|---|---|---|
| 01 · Library | `src/app/index.tsx`, `components/TopBar.tsx`, `components/ProjectSwitcher.tsx` | Display header + search/gear; project pill card; continue-reading hero (serif title, mint Resume); project-progress bar card; status filter chips; grouped paper rows (topic overline, title, meta, `Read ›`) |
| 08 · Settings / Connect | `src/app/settings.tsx` | Centered title, back pill; Server card with mint "Save & connect"; "Locked until connected" rows when disconnected |
| 03 · Discussion + 08a/b/c | `src/app/paper/[slug].tsx`, `components/chat/*`, `components/Markdown.tsx` | Header: back pill, truncated title + status, model chip, kebab. Assistant prose in Newsreader, document-style (section headings, mint callout cards, reference chips). Per-answer action row (Helpful / Not helpful / Copy / Related works / Listen) + disclaimer. Audio-synthesis banner. Composer: violet `+`, "Ask about this paper…", mint circular send. 08b model + thinking-depth picker sheet; 08c actions menu |
| 09 · Start Reading | `src/app/paper/[slug].tsx` (compose-first state) | Unread-paper hero card, "How should we start?" radio option cards (mint selected), source-candidates card, sticky "Start reading" + "Customize prompt" |
| 02 · Discover + 10 · Discover Setup | `src/app/discover.tsx` | Goals card w/ Edit; search-plan chips; specific-paper card; mint "Find readings"; "Search complete" serif card with mint check timeline; "Recommended foundations" numbered violet cards with why-it-fits + mint Add |
| 04 · Reference Map + 13 · Graph Recs | `src/app/graph.tsx`, `components/graph/*` | Header + stats; rebuild banner; search; filter pills; "Focused: N key papers" pill; mint/violet/amber nodes; Reset-view pill; recommended-additions bottom sheet |
| 06 · Related Works | `components/RelatedWorksSheet.tsx` | Serif titles, violet role overlines, "Why it matters here", evidence chip, mint "Add to project" + "Open source", count filter chips |
| 07 · External Reference | graph node detail sheet | External-reference chip, serif title, violet stat numbers, "Why it matters to this project", mint Add, cited-by list |
| 05 · Working Notes + 11 · Notes AI Revision | `src/app/notes/[target].tsx` | Synthesis status card; section chips; serif document body with violet-bar italic epigraph; violet subheadings; sticky "Edit directly / Propose revision"; AI-revision proposal card (Discard / Edit first / Apply) |
| 12 · Audio Player | `src/app/player.tsx`, `components/NowPlaying.tsx` | Listening-mode screen: serif title card, mint/violet waveform, 15s skips + big mint play; "Now explaining" card; Transcript/Related/Notes chips; Voice/Speed pills. NowPlaying mini-bar restyled, sits above the tab bar |
| DS `Bottom Navigation` | `src/app/(tabs)/_layout.tsx` (new) | 4 tabs: Library · Discover · Notes · Map (Feather icon + label, mint active) — replaces the Library screen's glyph shortcut buttons |

**Navigation restructure:** expo-router tab group `(tabs)/` holds Library (index), Discover,
Notes, Map (graph). `paper/[slug]`, `player`, `settings`, and notes editing remain stack/modal
screens above the tabs. The Notes tab lands on the project-level synthesis target. Settings is
reached from the header gear.

## PR sequence

Each PR must leave the app fully working (`npx tsc --noEmit` clean; app boots and every
screen remains functional). PRs land directly on `main`.

1. **Foundation** — this doc; `tokens.ts` rewrite with compat aliases; font-package swap
   (+`@expo-google-fonts/newsreader`, +`@expo/vector-icons`, −chakra-petch, −jetbrains-mono);
   `_layout.tsx` font loading; rebuilt `src/ui/index.tsx` primitives (new Text variants,
   pill Button, Chip, Card, ProgressBar, Icon/IconButton).
2. **Navigation shell + Library + Settings** — tab layout, TopBar/ProjectSwitcher, frames 01 + 08.
3. **Discussion** — frames 03, 08a/b/c, 09.
4. **Discover + Notes + Player** — frames 02, 10, 05, 11, 12.
5. **Graph + sheets + final audit** — frames 04, 13, 06, 07; remove all compat aliases;
   repo-wide audit (fonts = Manrope + Newsreader only, no text glyphs, spacing/radius
   consistency, no dead styles).

## Constraints (binding for driver and reviewer)

- No diffs under `app/` (backend), `web/`, or to API request/response shapes.
- All existing behavior preserved — this is a reskin + navigation restructure. The
  CLAUDE.md invariants hold; in particular "agent proposes, human commits" flows keep
  explicit review/approve affordances, and background-job + polling patterns are untouched.
- New dependencies limited to `@expo-google-fonts/newsreader` and `@expo/vector-icons`
  (both pure JS/asset packages — no dev-client rebuild required).
- `npx tsc --noEmit` passes in `mobile/` on every PR.
- Never commit `.env` or any token.

## Review protocol

The driver opens each PR, then launches the reviewer (codex) non-interactively. The reviewer:

1. Reads this doc, `CLAUDE.md`, and `docs/figma-workflow.md`.
2. Reviews the PR with `gh pr view <N>` / `gh pr diff <N>` — checking the constraints above,
   fidelity to the frame → code map, TypeScript soundness, RN correctness (StyleSheet usage,
   safe-area handling, list virtualization, press states), and that untouched screens still
   compile against changed shared primitives.
3. Posts findings as a single PR review (`gh pr review <N> --comment --body …`) with
   numbered, actionable comments (file:line, what, why, suggested fix).
4. Ends its final message with a verdict line: `VERDICT: APPROVE` or
   `VERDICT: REQUEST_CHANGES`.

The driver answers every comment on the PR (fix + note, or reasoned rebuttal), pushes, and
re-invokes the reviewer with a summary of dispositions. Loop until `APPROVE`, then
squash-merge.

## Verification

- Per PR: `npx tsc --noEmit` in `mobile/`; `npx expo export --platform android` once per PR
  to catch import/asset errors.
- Visual fidelity: driver re-renders Figma frames via the REST API and compares against the
  implemented screens; device smoke-test via the usual `run.sh` + tunnels + dev-build flow
  (see CLAUDE.md) after merges.
- End of project: `git diff <start>..main -- app/ web/` is empty.
