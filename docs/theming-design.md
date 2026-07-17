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

- **Three palettes**: **Dim** (today's "Scholar dark", the default), **Black** (super-dark
  surfaces for OLED — the base `bg` should be **true `#000`**, not a near-black like
  `#0a0a0a`, which reads grey on OLED panels and forfeits the battery win), **Light**.
- **Mode**: `system | dim | black | light`. `system` maps **OS dark → Dim**, **OS light →
  Light** (Black is opt-in only; following-system never picks it). Manual override wins.
- Design via the codex→Figma path (`docs/figma-workflow.md`).

## Current state (what makes this non-trivial)

- One **flat `colors` const** in `mobile/src/theme/tokens.ts`, imported directly by **32
  files** (as of 2026-07-16), including **28 module-level `StyleSheet.create({...})`** blocks.
  A module-level StyleSheet snapshots `colors.*` **once at import** — it cannot react to a
  theme change.
- **14 files additionally inline `rgba(...)`/hex literals derived from the palette** (e.g. the
  graph screen's `rgba(228, 184, 92, 0.08)` amber wash, gradient stops in `PaperCover`,
  overlay tints in `BottomSheet`/`NowPlaying`). These never read `colors.*` at all, so a
  guard that only checks token imports would pass while they stay dark-baked. They must be
  inventoried and either promoted to semantic tokens (e.g. `amberWash`, `overlay`) or derived
  from tokens at the use site.
- `mobile/app.json` hardcodes `"userInterfaceStyle": "dark"`; the discussion composer passes
  `colorScheme="dark"` (`mobile/src/app/paper/[slug].tsx`); the root layout hardcodes
  `<StatusBar style="light" />` (`mobile/src/app/_layout.tsx`). No `ThemeProvider`, no
  `useColorScheme()` usage anywhere.

So the work is two things: a **theme runtime**, and a **mechanical migration** of every
`colors.*` consumer *and palette-derived literal* to read the *active* theme. This will be
**2+ PRs**.

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
- **Expect the inline-literal inventory (above) to grow this list.** The washes/tints that
  today live as `rgba(...)` literals (amber wash, sheet overlay, gradient stops) need named
  homes — the Figma pass should deliver them as tokens too, not leave them for the migration
  to improvise per theme.

`fonts`, `radius`, `space` are **not** themed — they stay the single shared constants.

The token contract is also the shape the **web SPA** will eventually consume (as CSS
variables) — Figma should treat it as the app-wide palette source, not a mobile-only artifact.
Web work itself stays out of scope here.

## Theme runtime (infra PR)

1. Replace the flat `colors` with `themes = { dim, black, light }` (each a full token map) in
   `mobile/src/theme/`, keeping **`dim` byte-for-byte the current values** so the default is a
   pure no-op visually.
2. A **`ThemeProvider`** (like the existing `GraphSettingsProvider`) holding the resolved theme
   + the persisted mode, and a **`useTheme()`** hook returning the active token map. Persist the
   mode with the same store idiom as `graphSettings` (AsyncStorage), **read before first
   paint** — the `ListeningProvider` `ready`-gate idiom (render nothing until the stored mode
   loads, the splash covers it) so boot never flashes the wrong theme. (If that gate ever
   visibly delays boot, a synchronous store like MMKV is the standard upgrade path; not
   needed to start.) `system` resolves via RN `useColorScheme()` (OS dark→dim, OS
   light→light) and re-resolves reactively. The hook must return the **same object identity
   per mode** (the static palette map, never rebuilt per render) — every
   `useMemo(() => makeStyles(t), [t])` in the migration depends on that for its caching.
3. Relax `app.json` `userInterfaceStyle` → `"automatic"`; drop the composer's hardcoded
   `colorScheme="dark"` (derive from the active theme instead). **Add `expo-system-ui`** —
   on Android it is required for runtime `userInterfaceStyle` switching to work at all in
   dev/EAS builds (per Expo's color-themes guide), and its
   `SystemUI.setBackgroundColorAsync(bg)` (called on provider mount and on every theme
   change) paints the **root native view**, killing the last flash surface behind modals,
   keyboard dismissals, and over-scroll.
4. **System chrome follows the theme**: replace the hardcoded `<StatusBar style="light" />` in
   `_layout.tsx` with a theme-derived style (explicit `'light'`/`'dark'`, not `auto`); wrap
   the navigator in React Navigation's `ThemeProvider` with a theme object built from the
   active tokens so screen/transition backgrounds match (the default dark `contentStyle`
   otherwise flashes during pushes on Light). Android navigation bar: on SDK 54's
   edge-to-edge the bar is transparent and rides the root-view background painted by
   `expo-system-ui` — the old `expo-navigation-bar` color APIs no longer exist, so no
   separate call is needed. **Splash**: add the `splash.dark` variant in `app.json` so
   system-followers boot through a matching splash for free; the residual caveat is only a
   *manual* override that disagrees with the OS scheme (e.g. Light user on an OS-dark
   phone) — acceptable v1.
5. Add the **Settings override** (Appearance section: System / Dim / Black / Light) — fires the
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

Guardrails: after migration, a lint/grep check that **no runtime file imports the flat `colors`
directly** (only `themes`/`useTheme`) — **plus** a literal check that no `rgba(`/hex color
literal appears outside the theme files (with a small explicit allowlist for true one-offs,
e.g. `#000`-shadow), since the 14 inline-literal files never touch `colors.*` and would pass
the import check while staying dark-baked. Components written between this doc and the
migration (the R.8 Toast, R.11 NotesReviewSheet, R6.8 AgentTrail, the R6.6 rate pill — the
list will keep growing) all read `colors` from tokens today and get migrated with their
group; the guards, not this list, are the enforcement.

Out of scope for v1: **server-rendered paper covers** bake their own palette into the image
(`app/cover_jobs`); they are content, not chrome, and stay as-is on all three themes.

## Verification

- Toggle each mode (System / Dim / Black / Light) on device; flip OS light/dark with mode
  `system` and confirm Dim↔Light swap **live** (no restart — this is what `expo-system-ui`
  gates on Android). No hardcoded-dark leaks (both guards: token import + color literal), no
  unreadable `mintInk`/accent-on-surface contrast, status bar + Android nav bar follow the
  theme, cold boot shows no wrong-theme flash, and screen pushes on Light show no dark
  transition flash. Android 13+ note: per-app appearance can differ from the global OS
  setting — verify `system` follows what *this app* is told.
- References: Expo's color-themes guide (config + `expo-system-ui` requirement) and current
  community practice (three-layer mode/system/effective split, pre-paint persistence read,
  root-view painting, true-black OLED) — audited 2026-07-16.
- Mobile `tsc` + Jest per PR; a small unit test that `useTheme()` returns the light map under
  mode `light` and follows `useColorScheme()` under `system`.
- Because the infra PR keeps `dim` identical to today, the default experience is unchanged until
  a user opts into another mode — de-risks the big migration.

## Phasing summary

1. **Design (codex→Figma)**: the Dim/Black/Light hex for the token contract above, including
   named tokens for today's inline washes/tints.
2. **Infra PR**: `themes` map + `ThemeProvider`/`useTheme` + persisted mode + `app.json`
   automatic + system chrome (status bar / nav background / Android nav bar) + Settings
   Appearance control + one reference-migrated screen.
3. **Migration PRs**: primitives/chrome → tab screens → paper/sheets → settings/player, each
   converting its group's inline color literals too, finishing with both guards enabled.
