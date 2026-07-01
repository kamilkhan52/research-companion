// Drives a streaming assistant turn: runs an SSE endpoint, accumulates delta text into
// `liveText`, and on completion refetches the authoritative session (the server records every
// turn) so the UI converges on the canonical transcript rather than the optimistic stream.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { keys } from '@/api/queries';
import { streamPost } from '@/api/stream';
import type { StreamEvent, ToolActivity, Turn } from '@/api/types';

export interface StreamingTurn {
  liveText: string;
  streaming: boolean;
  error: string | null;
  /** Optional optimistic user text shown while the turn streams (cleared on settle). */
  pendingUser: string | null;
  /** Research tools the agent has invoked during the current turn (agentic path only). */
  tools: ToolActivity[];
  run: (path: string, body: unknown, optimisticUser?: string) => Promise<void>;
  cancel: () => void;
  clearError: () => void;
}

export function useStreamingTurn(pid: string | null, slug: string | null): StreamingTurn {
  const qc = useQueryClient();
  const [liveText, setLiveText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // A ref guard (not the `streaming` state) so back-to-back calls in the same tick — e.g. a
  // fast double-tap before React re-renders with the disabled button — can't both slip past
  // the check; state only updates on the next render, a ref updates immediately.
  const streamingRef = useRef(false);

  const settle = useCallback(async () => {
    if (pid && slug) {
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug) });
      await qc.invalidateQueries({ queryKey: keys.projectState(pid) });
    }
    setLiveText('');
    setPendingUser(null);
    setStreaming(false);
    setTools([]);
  }, [pid, slug, qc]);

  const run = useCallback(
    async (path: string, body: unknown, optimisticUser?: string) => {
      if (streamingRef.current) return;
      streamingRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setLiveText('');
      setPendingUser(optimisticUser ?? null);
      setStreaming(true);
      setTools([]);

      let acc = '';
      try {
        await streamPost<StreamEvent>(path, body, {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'delta') {
              acc += event.text;
              setLiveText(acc);
            } else if (event.type === 'tool') {
              setTools((prev) => [...prev, { name: event.name, detail: event.detail }]);
            } else if (event.type === 'error') {
              setError(event.detail);
            } else if (event.type === 'done') {
              // turn is recorded server-side; settle() will pull the canonical version.
              void (event.turn as Turn);
            }
          },
        });
        await settle();
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          setStreaming(false);
          setPendingUser(null);
          return;
        }
        setError((e as Error).message ?? 'Stream failed.');
        setStreaming(false);
      } finally {
        streamingRef.current = false;
        abortRef.current = null;
      }
    },
    [settle],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { liveText, streaming, error, pendingUser, tools, run, cancel, clearError };
}
