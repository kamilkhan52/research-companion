// Design tokens — the "Scholar dark" theme from the Figma redesign proposal
// (file `Research Companion — UI Redesign Proposal`, page `01 · Design System`).
// A quiet research instrument: warm off-white text on near-black ink, mint for
// action/approved progress, violet for relationship/synthesis/evidence, amber for
// bridge/warning. Manrope carries all UI; Newsreader carries editorial/long-form moments.

export const colors = {
  bg: '#0B0D12',
  /** Large soft background shapes that give the canvas its subtle atmosphere. */
  bgGlow: '#11141C',
  surface: '#151922',
  elevated: '#1B202B',
  line: 'rgba(153, 163, 183, 0.14)',
  line2: 'rgba(153, 163, 183, 0.28)',

  text: '#F3F0E8',
  muted: '#99A3B7',

  mint: '#65D6B4',
  /** Dark ink for text/icons sitting on a mint fill. */
  mintInk: '#0A231B',
  violet: '#9B8AFB',
  amber: '#E4B85C',
  danger: '#E5738C',
  scrim: 'rgba(0,0,0,0.55)',
} as const;

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
export const stateMeta: Record<string, { label: string; color: string }> = {
  unread: { label: 'Unread', color: colors.muted },
  retrieving: { label: 'Retrieving', color: colors.amber },
  in_discussion: { label: 'Discussing', color: colors.mint },
  notes_drafted: { label: 'Notes drafted', color: colors.violet },
  committed: { label: 'Read', color: colors.mint },
  read: { label: 'Read', color: colors.mint },
};
