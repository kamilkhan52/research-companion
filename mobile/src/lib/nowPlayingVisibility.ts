// `/discover` is a hidden tab-owned compatibility route while old links redirect to Map. Keeping
// it here prevents the root mini-player from flashing a duplicate during that redirect frame.
const TAB_PATHS = new Set(['/', '/discover', '/notes', '/graph']);

/** Stack screens own the root mini-player, except the full player whose controls are complete. */
export function shouldShowStackNowPlaying(pathname: string): boolean {
  return pathname !== '/player' && !TAB_PATHS.has(pathname);
}
