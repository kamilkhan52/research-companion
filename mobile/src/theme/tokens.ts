// Design tokens (R.2 theming, per docs/theming-design.md).
//
// Three palettes share one semantic token contract:
//   Dim   — the original "Scholar dark" from the Figma redesign proposal (file `Research
//           Companion — UI Redesign Proposal`, page `01 · Design System`), byte-identical,
//           still the default. Warm off-white text on near-black ink; mint = action/approved
//           progress, violet = relationship/synthesis/evidence, amber = bridge/warning.
//   Black — super-dark for OLED. True #000 base (a near-black reads grey on OLED panels and
//           forfeits the battery win); same content/accent inks as Dim.
//   Light — warm paper. Accents re-tuned darker for contrast on light surfaces.
//
// Black/Light hex here are PROVISIONAL engineering derivations — the codex→Figma palette
// pass may retune them; this file is the only place they live.
//
// Migrated components read the ACTIVE palette via useTheme()/useThemedStyles()
// (theme/ThemeProvider.tsx). The flat `colors` export below stays as the Dim alias so
// not-yet-migrated modules keep compiling and rendering exactly as before; the migration's
// guard removes it at the end.

export interface ThemePalette {
  bg: string;
  /** Large soft background shapes that give the canvas its subtle atmosphere. */
  bgGlow: string;
  surface: string;
  elevated: string;
  line: string;
  line2: string;
  text: string;
  muted: string;
  mint: string;
  /** Ink for text/icons sitting on a mint fill. */
  mintInk: string;
  violet: string;
  amber: string;
  danger: string;
  scrim: string;
}

const dim: ThemePalette = {
  bg: '#0B0D12',
  bgGlow: '#11141C',
  surface: '#151922',
  elevated: '#1B202B',
  line: 'rgba(153, 163, 183, 0.14)',
  line2: 'rgba(153, 163, 183, 0.28)',

  text: '#F3F0E8',
  muted: '#99A3B7',

  mint: '#65D6B4',
  mintInk: '#0A231B',
  violet: '#9B8AFB',
  amber: '#E4B85C',
  danger: '#E5738C',
  scrim: 'rgba(0,0,0,0.55)',
};

const black: ThemePalette = {
  bg: '#000000',
  bgGlow: '#07080C',
  surface: '#0D1016',
  elevated: '#151923',
  line: 'rgba(153, 163, 183, 0.12)',
  line2: 'rgba(153, 163, 183, 0.26)',

  text: '#F3F0E8',
  muted: '#99A3B7',

  mint: '#65D6B4',
  mintInk: '#0A231B',
  violet: '#9B8AFB',
  amber: '#E4B85C',
  danger: '#E5738C',
  scrim: 'rgba(0,0,0,0.65)',
};

const light: ThemePalette = {
  bg: '#F3F1EA',
  bgGlow: '#ECE9DF',
  surface: '#FBFAF6',
  elevated: '#FFFFFF',
  line: 'rgba(64, 74, 94, 0.14)',
  line2: 'rgba(64, 74, 94, 0.28)',

  text: '#1C2129',
  muted: '#5D6879',

  mint: '#177E63',
  mintInk: '#F5FBF8',
  violet: '#6A55E0',
  amber: '#A87A17',
  danger: '#C2385A',
  scrim: 'rgba(20, 24, 32, 0.45)',
};

export const themes = { dim, black, light } as const;
export type ThemeName = keyof typeof themes;
/** The persisted Settings choice; `system` follows the OS (dark→dim, light→light — Black is
 *  opt-in only, per the design decision). */
export type ThemeMode = 'system' | ThemeName;

/** Dim alias for not-yet-migrated modules (see header note). Do not use in new code —
 *  read useTheme() instead. */
export const colors = dim;

export const fonts = {
  // Manrope — UI, controls, dense card text.
  body: 'Manrope_400Regular',
  bodyMedium: 'Manrope_500Medium',
  bodySemiBold: 'Manrope_600SemiBold',
  bodyBold: 'Manrope_700Bold',
  // Newsreader — editorial headings and long-form reading moments.
  serif: 'Newsreader_400Regular',
  serifItalic: 'Newsreader_400Regular_Italic',
  serifMedium: 'Newsreader_500Medium',
  serifSemiBold: 'Newsreader_600SemiBold',
} as const;

export const radius = {
  sm: 12,
  md: 16,
  lg: 20,
  xl: 26,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** Map a paper/session state to an accent color + short label for chips.
 * Mint = active/approved progress, violet = synthesis, amber = in-flight retrieval. */
export function stateMetaFor(t: ThemePalette): Record<string, { label: string; color: string }> {
  return {
    unread: { label: 'Unread', color: t.muted },
    retrieving: { label: 'Retrieving', color: t.amber },
    in_discussion: { label: 'Discussing', color: t.mint },
    notes_drafted: { label: 'Notes drafted', color: t.violet },
    committed: { label: 'Read', color: t.mint },
    read: { label: 'Read', color: t.mint },
  };
}

/** Dim alias for not-yet-migrated modules — same caveat as `colors`. */
export const stateMeta = stateMetaFor(dim);
