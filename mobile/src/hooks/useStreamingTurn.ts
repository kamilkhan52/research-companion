// Drives a streaming assistant turn: runs an SSE endpoint, accumulates delta text into
// `liveText`, and on completion refetches the authoritative session (the server records every
// turn) so the UI converges on the canonical transcript rather than the optimistic stream.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { keys } from '@/api/queries';
import { streamPost } from '@/api/stream';
import type { StreamEvent, Turn } from '@/api/types';

export interface StreamingTurn {
  liveText: string;
  streaming: boolean;
  error: string | null;
  /** Optional optimistic user text shown while the turn streams (cleared on settle). */
  pendingUser: string | null;
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
  const abortRef = useRef<AbortController | null>(null);

  const settle = useCallback(async () => {
    if (pid && slug) {
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug) });
      await qc.invalidateQueries({ queryKey: keys.projectState(pid) });
    }
    setLiveText('');
    setPendingUser(null);
    setStreaming(false);
  }, [pid, slug, qc]);

  const run = useCallback(
    async (path: string, body: unknown, optimisticUser?: string) => {
      if (streaming) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setLiveText('');
      setPendingUser(optimisticUser ?? null);
      setStreaming(true);

      let acc = '';
      try {
        await streamPost(path, body, {
          signal: controller.signal,
          onEvent: (event: StreamEvent) => {
            if (event.type === 'delta') {
              acc += event.text;
              setLiveText(acc);
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
        abortRef.current = null;
      }
    },
    [streaming, settle],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { liveText, streaming, error, pendingUser, run, cancel, clearError };
}
