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
// Components read the ACTIVE palette via useTheme()/useThemedStyles()
// (theme/ThemeProvider.tsx). The migration is complete: there is no flat `colors` export any
// more, and test/theme-guards.test.ts enforces both that and the no-inline-color-literals
// rule so a dark-baked leak can't silently return.

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
  // Washes/tints that used to live as inline rgba literals (T.5 promotion — the literal
  // guard keeps them here). Wash = a soft fill behind selected/accented content.
  mintWash: string;
  mintWashStrong: string;
  amberWash: string;
  amberLine: string;
  dangerWash: string;
  /** Translucent elevated surface (e.g. a floating control over content). */
  elevatedGlass: string;
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
  mintWash: 'rgba(101, 214, 180, 0.10)',
  mintWashStrong: 'rgba(101, 214, 180, 0.14)',
  amberWash: 'rgba(228, 184, 92, 0.08)',
  amberLine: 'rgba(228, 184, 92, 0.4)',
  dangerWash: 'rgba(229, 115, 140, 0.12)',
  elevatedGlass: 'rgba(27, 32, 43, 0.72)',
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
  mintWash: 'rgba(101, 214, 180, 0.10)',
  mintWashStrong: 'rgba(101, 214, 180, 0.14)',
  amberWash: 'rgba(228, 184, 92, 0.08)',
  amberLine: 'rgba(228, 184, 92, 0.4)',
  dangerWash: 'rgba(229, 115, 140, 0.12)',
  elevatedGlass: 'rgba(21, 25, 35, 0.72)',
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
  mintWash: 'rgba(23, 126, 99, 0.10)',
  mintWashStrong: 'rgba(23, 126, 99, 0.16)',
  amberWash: 'rgba(168, 122, 23, 0.10)',
  amberLine: 'rgba(168, 122, 23, 0.45)',
  dangerWash: 'rgba(194, 56, 90, 0.10)',
  elevatedGlass: 'rgba(255, 255, 255, 0.80)',
};

export const themes = { dim, black, light } as const;
export type ThemeName = keyof typeof themes;
/** The persisted Settings choice; `system` follows the OS (dark→dim, light→light — Black is
 *  opt-in only, per the design decision). */
export type ThemeMode = 'system' | ThemeName;


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
 * The holistic rule (R7.4): mint = completed, amber = ongoing/in-flight, violet = the
 * distinct notes-drafted stage, muted = not started — so a reading list separates finished
 * from in-progress papers at a glance instead of showing one mint wash. */
export function stateMetaFor(t: ThemePalette): Record<string, { label: string; color: string }> {
  return {
    unread: { label: 'Unread', color: t.muted },
    retrieving: { label: 'Retrieving', color: t.amber },
    in_discussion: { label: 'Discussing', color: t.amber },
    notes_drafted: { label: 'Notes drafted', color: t.violet },
    committed: { label: 'Read', color: t.mint },
    read: { label: 'Read', color: t.mint },
  };
}

