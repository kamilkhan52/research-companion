// Turning a thrown error into something worth showing a reader.
//
// The platform's own network errors are the problem this exists for. Android throws
// `java.net.UnknownHostException: Unable to resolve host "…": No address associated with hostname`
// and iOS/Hermes throws `Network request failed`; both used to be rendered verbatim, so a phone
// that lost DNS for one second told the reader about hostname resolution — while the thing they
// were looking at had actually succeeded.
//
// Deliberately NOT a general-purpose sanitizer. Server errors arrive as `HTTPException(detail=…)`
// written for a person, and passing those through unchanged is the whole point: they are usually
// the most useful sentence available.

/** Substrings that mark an error as "the device could not reach the server", per platform. */
const OFFLINE_MARKERS = [
  'UnknownHostException',        // Android: DNS failed
  'Unable to resolve host',      // Android, same failure phrased differently
  'Network request failed',      // iOS / Hermes fetch
  'Failed to fetch',             // web
  'ECONNREFUSED',
  'ETIMEDOUT',
  'SocketTimeoutException',
  'ConnectException',
  'NetworkError',
  'Load failed',                 // Safari
];

export const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

/** True when this error is a transport failure rather than something the server said. */
export function isOfflineError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '');
  return OFFLINE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * A message worth showing. Transport failures collapse to one plain sentence; anything else keeps
 * the server's own wording, which is written for a reader and is usually more specific than
 * whatever a generic fallback could say.
 */
export function readableError(error: unknown, fallback = 'Something went wrong.'): string {
  if (isOfflineError(error)) return OFFLINE_MESSAGE;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() || fallback;
}
