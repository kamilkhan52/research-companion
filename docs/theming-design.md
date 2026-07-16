# Light / Dark / Dim theming — design (R.2)

Kamil's framing (2026-07-15): the app is dark-only today; he wants a **super-dark ("black")**
option, wants the **current dark to stay the default**, and wants a **light** mode — with the
app able to **follow the system** and a manual override. His process note: the palettes are
designed **codex → Figma → Claude implements** (concept imagery in Figma first, then this repo
consumes the tokens).

This is the reviewable plan for the *engineering* side — the token architecture, the theme
runtime, and the migration — so the codex→Figma palette work and the code refactor can proceed
in parallel against a shared contract. **No final palette hex values are fixed here**; they are
the Figma deliverable. This doc pins the *structure* those values must fill.

## Decision recap

- **Three palettes**: **Dim** (today's "Scholar dark", the default), **Black** (super-dark,
  near-#000 surfaces for OLED), **Light**.
- **Mode**: `system | dim | black | light`. `system` maps **OS dark → Dim**, **OS light →
  Light** (Black is opt-in only; following-system never picks it). Manual override wins.
- Design via the codex→Figma path (`docs/figma-workflow.md`).

## Current state (what makes this non-trivial)

- One **flat `colors` const** in `mobile/src/theme/tokens.ts`, imported directly by **~32
  files**, including **27 module-level `StyleSheet.create({...})`** blocks. A module-level
  StyleSheet snapshots `colors.*` **once at import** — it cannot react to a theme change.
- `mobile/app.json` hardcodes `"userInterfaceStyle": "dark"`; the discussion `<Chat>` passes
  `colorScheme="dark"`. No `ThemeProvider`, no `useColorScheme()` usage anywhere.

So the work is two things: a **theme runtime**, and a **mechanical migration** of every
`colors.*` consumer to read the *active* theme. This will be **2+ PRs**.

## Token contract (what every palette must define)

Keep the existing semantic keys — a theme is a full mapping of them, so consumers change *how*
they read the token, not *which* token. The set (from today's `colors`):

```
bg, bgGlow, surface, elevated, line, line2,
text, muted,
mint, mintInk, violet, amber, danger, scrim
```

- **Surfaces/structure** (`bg, bgGlow, surface, elevated, line, line2`) and **content**
  (`text, muted`) differ per theme — this is most of the visual change.
- **Brand accents** (`mint, violet, amber, danger`) likely stay close across Dim/Black and are
  re-tuned for contrast on Light. `mintInk` (ink on a mint fill) must stay legible per theme.
- Figma delivers the hex for all three; the key list above is the frozen interface. If a new
  semantic token is needed (e.g. an `overlay` distinct from `scrim`), add it to **all three**
  palettes in the same change.

`fonts`, `radius`, `space` are **not** themed — they stay the single shared constants.

## Theme runtime (infra PR)

1. Replace the flat `colors` with `themes = { dim, black, light }` (each a full token map) in
   `mobile/src/theme/`, keeping **`dim` byte-for-byte the current values** so the default is a
   pure no-op visually.
2. A **`ThemeProvider`** (like the existing `GraphSettingsProvider`) holding the resolved theme
   + the persisted mode, and a **`useTheme()`** hook returning the active token map. Persist the
   mode with the same store idiom as `graphSettings` (AsyncStorage). `system` resolves via RN
   `useColorScheme()` (OS dark→dim, OS light→light) and re-resolves reactively.
3. Relax `app.json` `userInterfaceStyle` → `"automatic"`; drop the composer's hardcoded
   `colorScheme="dark"` (derive from the active theme instead).
4. Add the **Settings override** (Appearance section: System / Dim / Black / Light) — fires the
   R.8 toast on change; the control itself must be theme-aware from the start.

Because module-level StyleSheets can't react, the migration (below) is what actually makes
screens change. The infra PR lands the runtime + Settings control and migrates a first screen
as the reference implementation.

## Migration strategy (one or more PRs, by screen group)

Convert each `colors.*` consumer to the active theme. Two supported shapes:
- **Hook + inline styles / `useMemo` styles**: `const t = useTheme();` then style objects read
  `t.bg` etc. Best for components already using dynamic styles.
- **`makeStyles(theme)` factory**: replace `const styles = StyleSheet.create({...})` (module
  level) with `const styles = useMemo(() => makeStyles(t), [t])`, where `makeStyles(t)` returns
  the StyleSheet. Best for the 27 module-level blocks. A small `makeStyles` helper standardizes
  this.

Sequence to bound risk and review size:
1. **UI primitives** (`mobile/src/ui/index.tsx` — `Text`, `Button`, `Card`, `Chip`, `Screen`,
   etc.) and shared chrome (`TopBar`, `Toast`, `BottomSheet`, `Markdown`). These cover most
   screens implicitly.
2. **Tab screens** group (Library, Discover, Notes, Map) — largest surfaces.
3. **Paper/discussion** + sheets (composer, options sheets, `NotesReviewSheet`, authors board).
4. **Settings / player / remaining** — sweep for stragglers.

Guardrail: after migration, a lint/grep check that **no runtime file imports the flat `colors`
directly** (only `themes`/`useTheme`), so a hardcoded-dark leak can't silently return. Anything
new written before migration (e.g. the R.8 Toast, R.10 FigureCard, R.11 NotesReviewSheet)
currently reads `colors` from tokens and must be migrated in its group.

## Verification

- Toggle each mode (System / Dim / Black / Light) on device; flip OS light/dark with mode
  `system` and confirm Dim↔Light swap. No hardcoded-dark leaks (the grep guard), no unreadable
  `mintInk`/accent-on-surface contrast, status bar style follows the theme.
- Mobile `tsc` + Jest per PR; a small unit test that `useTheme()` returns the light map under
  mode `light` and follows `useColorScheme()` under `system`.
- Because the infra PR keeps `dim` identical to today, the default experience is unchanged until
  a user opts into another mode — de-risks the big migration.

## Phasing summary

1. **Design (codex→Figma)**: the Dim/Black/Light hex for the token contract above.
2. **Infra PR**: `themes` map + `ThemeProvider`/`useTheme` + persisted mode + `app.json`
   automatic + Settings Appearance control + one reference-migrated screen.
3. **Migration PRs**: primitives/chrome → tab screens → paper/sheets → settings/player, each
   with the grep guard.
