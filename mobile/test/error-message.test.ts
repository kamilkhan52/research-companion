import { OFFLINE_MESSAGE, isOfflineError, readableError } from '@/api/errorMessage';

describe('readableError', () => {
  it('collapses the platform network errors a reader should never see', () => {
    // The exact Android string from the 2026-07-30 device pass, rendered verbatim on the Map tab
    // after a build that had actually SUCCEEDED.
    const android = new Error(
      'fetch failed: java.net.UnknownHostException: Unable to resolve host '
      + '"research-companion.fly.dev": No address associated with hostname',
    );
    expect(readableError(android)).toBe(OFFLINE_MESSAGE);
    expect(readableError(new Error('Network request failed'))).toBe(OFFLINE_MESSAGE);
    expect(readableError(new Error('Failed to fetch'))).toBe(OFFLINE_MESSAGE);
  });

  it("keeps the server's own wording, which is written for a person", () => {
    // Backend errors arrive as HTTPException(detail=…). Replacing those with a generic sentence
    // would throw away the most useful thing on screen.
    const detail = 'That bundle\'s reading list is not readable text.';
    expect(readableError(new Error(detail))).toBe(detail);
  });

  it('falls back only when there is genuinely nothing to say', () => {
    expect(readableError(new Error('  '), 'Could not load the graph.')).toBe('Could not load the graph.');
    expect(readableError(undefined, 'Could not load the graph.')).toBe('Could not load the graph.');
  });

  it('classifies transport failures without needing an Error instance', () => {
    expect(isOfflineError('java.net.UnknownHostException')).toBe(true);
    expect(isOfflineError(new Error('Paper not found'))).toBe(false);
  });
});
