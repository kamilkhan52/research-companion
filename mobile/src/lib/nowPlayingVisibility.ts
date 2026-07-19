const TAB_PATHS = new Set(['/', '/discover', '/notes', '/graph']);

/** Stack screens own the root mini-player, except the full player whose controls are complete. */
export function shouldShowStackNowPlaying(pathname: string): boolean {
  return pathname !== '/player' && !TAB_PATHS.has(pathname);
}
