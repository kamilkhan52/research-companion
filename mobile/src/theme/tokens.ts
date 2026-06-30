// Design tokens — the "Neon lab" theme, ported from web/styles.css so the mobile app reads as
// the same product: deep ink surfaces, restrained electric-cyan + violet accents, calm body text.

export const colors = {
  bg: '#07080e',
  bg2: '#0b0d16',
  panel: '#11141f',
  panel2: '#161a28',
  panelActive: '#1c2233',
  line: 'rgba(125, 145, 200, 0.14)',
  line2: 'rgba(125, 145, 200, 0.26)',

  text: '#e9edf7',
  muted: '#909bb6',

  cyan: '#34e7e0',
  cyanInk: '#062b2a',
  violet: '#9b7bff',
  green: '#4ee6a0',
  amber: '#ffce6b',
  danger: '#ff6f8c',
} as const;

export const fonts = {
  display: 'ChakraPetch_600SemiBold',
  displayBold: 'ChakraPetch_700Bold',
  body: 'Manrope_400Regular',
  bodyMedium: 'Manrope_500Medium',
  bodySemiBold: 'Manrope_600SemiBold',
  bodyBold: 'Manrope_700Bold',
  mono: 'JetBrainsMono_400Regular',
} as const;

export const radius = {
  sm: 11,
  md: 16,
  lg: 22,
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

/** Map a paper/session state to an accent color + short label for chips. */
export const stateMeta: Record<string, { label: string; color: string }> = {
  unread: { label: 'Unread', color: colors.muted },
  retrieving: { label: 'Retrieving', color: colors.amber },
  in_discussion: { label: 'Discussing', color: colors.cyan },
  notes_drafted: { label: 'Notes drafted', color: colors.violet },
  committed: { label: 'Read', color: colors.green },
  read: { label: 'Read', color: colors.green },
};
