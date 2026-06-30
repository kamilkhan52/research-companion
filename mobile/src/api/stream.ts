// SSE streaming for the *_stream endpoints (POST with a JSON body). EventSource can't do
// POST, so we use expo/fetch — the only fetch in RN with real ReadableStream support — and
// parse the `data: {json}\n\n` frames ourselves into typed StreamEvents.

import { fetch as expoFetch } from 'expo/fetch';

import { ApiError, apiUrl, authHeaders } from './client';
import type { StreamEvent } from './types';

export interface StreamHandlers {
  onEvent: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

/**
 * POST to an SSE endpoint and invoke onEvent for each frame. Resolves when the stream ends.
 * Rejects on transport/HTTP failure; backend-level errors arrive as {type:'error'} events.
 */
export async function streamPost(
  path: string,
  body: unknown,
  { onEvent, signal }: StreamHandlers,
): Promise<void> {
  const res = await expoFetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let detail = `Stream failed (${res.status})`;
    try {
      const j = await res.json();
      if (j?.detail) detail = String(j.detail);
    } catch {
      // keep generic
    }
    throw new ApiError(res.status, detail);
  }
  if (!res.body) throw new ApiError(0, 'No response stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = parseFrame(frame);
        if (event) onEvent(event);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

/** Extract the JSON payload from the `data:` line(s) of one SSE frame. */
function parseFrame(frame: string): StreamEvent | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null;
  }
}
