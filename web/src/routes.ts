/** Hash-route helpers shared by the screens that build links and the router that reads them.
 *  They live outside `App` so a screen can construct a route without importing the router. */

/** The route for one paper. `source` is the concrete thing to retrieve — an arXiv id or a
 *  direct PDF link — carried from an add so the reading screen does not make the reader paste
 *  what they just typed. Absent for an ordinary open. */
export function paperHash(slug: string, source?: string | null): string {
  const base = `paper/${encodeURIComponent(slug)}`;
  return source ? `${base}?source=${encodeURIComponent(source)}` : base;
}

/** Split a hash route's path from its query. Returns the raw (still-encoded) halves. */
export function splitRouteQuery(raw: string): { path: string; query: URLSearchParams } {
  const index = raw.indexOf('?');
  if (index < 0) return { path: raw, query: new URLSearchParams() };
  return { path: raw.slice(0, index), query: new URLSearchParams(raw.slice(index + 1)) };
}
