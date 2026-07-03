// Audio controller: turns an assistant message into spoken audio and plays it through
// TrackPlayer (background + lock screen). Preparation (narrate -> synthesize) runs as a
// SERVER-SIDE background job that we poll — never a single long-lived request. A blocking
// request dies at the tunnel/proxy timeout (Cloudflare 524 at ~100s) even while the server
// finishes and caches the audio; polling survives timeouts, network blips, and the app being
// backgrounded, and gives real progress (stage + synthesized segments) instead of a spinner.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import TrackPlayer, { State } from 'react-native-track-player';

import { apiUrl, authHeaders } from '@/api/client';
import * as api from '@/api/endpoints';
import type { AudioJob } from '@/api/types';
import { setupPlayer } from '@/audio/setup';

interface PlayRequest {
  id: string; // stable key for the message (e.g. `${slug}:${index}`)
  title: string;
  text: string; // canonical assistant text
}

/** Live snapshot of an in-flight preparation, for the message row and the mini player. */
export interface PrepState {
  id: string;
  title: string;
  stage: 'starting' | 'narrating' | 'synthesizing';
  /** synthesized segments so far / total (0/0 until the synthesizing stage sizes the work). */
  done: number;
  total: number;
}

interface AudioContextValue {
  /** Prepare + play a message. Tapping the message already loaded in the player toggles
   *  pause/resume; tapping a different message switches to it (abandoning any other prep —
   *  the server job keeps running and lands in the cache for next time). */
  playText: (req: PlayRequest) => Promise<void>;
  /** The in-flight preparation, or null. Global, so the mini player can show it anywhere. */
  prep: PrepState | null;
  /** Stop watching the in-flight preparation (the server job continues and caches). */
  cancelPrep: () => void;
  /** id + title of the track currently loaded in the player, or null. */
  currentId: string | null;
  currentTitle: string | null;
  /** Unload the player entirely (mini player disappears). */
  dismiss: () => Promise<void>;
  /** Listening transcript (the narrated adaptation) per message id, once generated. */
  narrationById: Record<string, string>;
  /** Last preparation failure per message id; cleared when that message is retried. */
  errorById: Record<string, string>;
}

const POLL_MS = 1000;
// Polls that may fail in a row (network blips, brief tunnel drops) before we give up.
const MAX_POLL_FAILURES = 8;
// A server restart loses the in-memory job (poll 404s); re-POST resumes from the server
// caches. Capped so a persistently broken server can't loop forever.
const MAX_RESTARTS = 2;

const AudioContext = createContext<AudioContextValue | undefined>(undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function AudioProvider({ children }: { children: ReactNode }) {
  const [prep, setPrep] = useState<PrepState | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  const [narrationById, setNarrationById] = useState<Record<string, string>>({});
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  // Bumped whenever a new prep starts (or is cancelled); stale loops see it and exit quietly.
  const generation = useRef(0);

  useEffect(() => {
    setupPlayer().catch(() => {});
  }, []);

  const cancelPrep = useCallback(() => {
    generation.current += 1;
    setPrep(null);
  }, []);

  const applyJob = useCallback((id: string, title: string, job: AudioJob) => {
    if (job.narration) {
      setNarrationById((m) => (m[id] === job.narration ? m : { ...m, [id]: job.narration! }));
    }
    setPrep({
      id,
      title,
      stage: job.stage,
      done: job.segments_done,
      total: job.segments_total,
    });
  }, []);

  const playText = useCallback(
    async ({ id, title, text }: PlayRequest) => {
      // Same message as the loaded track -> pause/resume toggle (or restart after it ended),
      // like any player.
      if (id === currentId) {
        const { state } = await TrackPlayer.getPlaybackState();
        if (state === State.Playing) {
          await TrackPlayer.pause();
        } else {
          if (state === State.Ended) await TrackPlayer.seekTo(0);
          await TrackPlayer.play();
        }
        return;
      }
      const gen = ++generation.current;
      const live = () => generation.current === gen;
      setErrorById((m) => {
        if (!(id in m)) return m;
        const { [id]: _drop, ...rest } = m;
        return rest;
      });
      setPrep({ id, title, stage: 'starting', done: 0, total: 0 });

      const fail = (message: string) => {
        if (!live()) return;
        setErrorById((m) => ({ ...m, [id]: message }));
        setPrep(null);
      };

      try {
        await setupPlayer();
        let { job } = await api.startAudioJob(text);
        if (!live()) return;
        applyJob(id, title, job);

        let pollFailures = 0;
        let restarts = 0;
        while (job.status === 'running') {
          await sleep(POLL_MS);
          if (!live()) return;
          try {
            job = (await api.getAudioJob(job.id)).job;
            pollFailures = 0;
          } catch (e) {
            const status = (e as { status?: number }).status;
            if (status === 404 && restarts < MAX_RESTARTS) {
              // Server restarted and lost the in-memory job; re-POST picks up from its caches.
              restarts += 1;
              job = (await api.startAudioJob(text)).job;
            } else if (status === undefined && ++pollFailures < MAX_POLL_FAILURES) {
              continue; // network blip — the job is still running server-side; keep polling
            } else {
              throw e;
            }
          }
          if (!live()) return;
          applyJob(id, title, job);
        }

        if (job.status === 'error' || !job.url) {
          fail(job.error ?? 'Could not prepare audio.');
          return;
        }

        await TrackPlayer.reset();
        await TrackPlayer.add({
          id,
          url: apiUrl(job.url),
          title,
          artist: 'Reading Companion',
          headers: authHeaders(),
        });
        if (!live()) {
          await TrackPlayer.reset();
          return;
        }
        setCurrentId(id);
        setCurrentTitle(title);
        setPrep(null);
        await TrackPlayer.play();
      } catch (e) {
        fail((e as Error).message ?? 'Could not prepare audio.');
      }
    },
    [currentId, applyJob],
  );

  const dismiss = useCallback(async () => {
    setCurrentId(null);
    setCurrentTitle(null);
    await TrackPlayer.reset().catch(() => {});
  }, []);

  return (
    <AudioContext.Provider
      value={{ playText, prep, cancelPrep, currentId, currentTitle, dismiss, narrationById, errorById }}>
      {children}
    </AudioContext.Provider>
  );
}

export function useAudio(): AudioContextValue {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used within AudioProvider');
  return ctx;
}
