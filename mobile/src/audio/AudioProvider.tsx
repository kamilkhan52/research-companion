// Audio controller: turns an assistant message into spoken audio and plays it through
// TrackPlayer (background + lock screen). Preparation (narrate -> synthesize) runs as a
// SERVER-SIDE background job that we poll — never a single long-lived request. A blocking
// request dies at the tunnel/proxy timeout (Cloudflare 524 at ~100s) even while the server
// finishes and caches the audio; polling survives timeouts, network blips, and the app being
// backgrounded, and gives real progress (stage + synthesized segments) instead of a spinner.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TrackPlayer, { Event, State, useTrackPlayerEvents } from 'react-native-track-player';

import { apiUrl, authHeaders } from '@/api/client';
import * as api from '@/api/endpoints';
import type { AudioJob } from '@/api/types';
import { setupPlayer } from '@/audio/setup';
import { useActiveProject } from '@/store/project';

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
  /** Queue audio already started by a listening-mode chat job. Preparation may overlap current
   * playback; the resulting track is appended and never interrupts what is playing. */
  enqueueJob: (req: PlayRequest, audioJobId: string, billingProject: string | null) => void;
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
const HANDLED_HANDOFFS_KEY = 'rc.handledAudioHandoffs';
const MAX_HANDLED_HANDOFFS = 200;

const AudioContext = createContext<AudioContextValue | undefined>(undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handledHandoffs(): Promise<string[]> {
  try {
    const value = JSON.parse(await AsyncStorage.getItem(HANDLED_HANDOFFS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function markHandoffHandled(id: string): Promise<void> {
  try {
    const ids = (await handledHandoffs()).filter((item) => item !== id);
    ids.push(id);
    await AsyncStorage.setItem(
      HANDLED_HANDOFFS_KEY,
      JSON.stringify(ids.slice(-MAX_HANDLED_HANDOFFS)),
    );
  } catch {
    // Playback is more important than dedup persistence; keep the in-memory id regardless.
  }
}

export function AudioProvider({ children }: { children: ReactNode }) {
  const [prep, setPrep] = useState<PrepState | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  const [narrationById, setNarrationById] = useState<Record<string, string>>({});
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  // Bumped whenever a new prep starts (or is cancelled); stale loops see it and exit quietly.
  const generation = useRef(0);
  const queueGeneration = useRef(0);
  const queueTail = useRef<Promise<void>>(Promise.resolve());
  const queuedIds = useRef(new Set<string>());
  // The initiating project, for billing the narration LLM spend (audio itself is app-global).
  // Held in a ref so playText keeps a stable identity as the active project changes.
  const { activePid } = useActiveProject();
  const activePidRef = useRef(activePid);
  activePidRef.current = activePid;

  useEffect(() => {
    setupPlayer().catch(() => {});
  }, []);

  useTrackPlayerEvents([Event.PlaybackActiveTrackChanged], (event) => {
    const track = event.track;
    setCurrentId(track?.id != null ? String(track.id) : null);
    setCurrentTitle(track?.title != null ? String(track.title) : null);
  });

  const cancelPrep = useCallback(() => {
    generation.current += 1;
    queueGeneration.current += 1;
    queuedIds.current.clear();
    setPrep(null);
    const removeUpcoming = () => TrackPlayer.removeUpcomingTracks().catch(() => {});
    void removeUpcoming();
    // Serialize a second cleanup after any in-flight add. If cancellation wins while native
    // TrackPlayer.add() is pending, that stale add completes before this removal runs.
    queueTail.current = queueTail.current.then(removeUpcoming, removeUpcoming);
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
      // Capture the initiating project ONCE, up front: this preparation bills whichever project
      // started it, even if the user switches projects before the POST (or a restart re-POST)
      // fires. Reading the ref again later would misattribute the spend to the new project.
      const billingProject = activePidRef.current;
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
        let { job } = await api.startAudioJob(text, billingProject);
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
              job = (await api.startAudioJob(text, billingProject)).job;
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

  const enqueueJob = useCallback((request: PlayRequest, audioJobId: string,
                                  billingProject: string | null) => {
    if (queuedIds.current.has(request.id)) return;
    queuedIds.current.add(request.id);
    const queueGen = queueGeneration.current;

    queueTail.current = queueTail.current.then(async () => {
      if (queueGeneration.current !== queueGen) return;
      if ((await handledHandoffs()).includes(request.id)) return;
      const live = () => queueGeneration.current === queueGen;
      setErrorById((errors) => {
        if (!(request.id in errors)) return errors;
        const { [request.id]: _drop, ...rest } = errors;
        return rest;
      });
      setPrep({ id: request.id, title: request.title, stage: 'starting', done: 0, total: 0 });

      try {
        await setupPlayer();
        let job: AudioJob;
        try {
          job = (await api.getAudioJob(audioJobId)).job;
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          job = (await api.startAudioJob(request.text, billingProject)).job;
        }
        if (!live()) return;
        applyJob(request.id, request.title, job);

        let pollFailures = 0;
        while (job.status === 'running') {
          await sleep(POLL_MS);
          if (!live()) return;
          try {
            job = (await api.getAudioJob(job.id)).job;
            pollFailures = 0;
          } catch (e) {
            if ((e as { status?: number }).status === undefined
                && ++pollFailures < MAX_POLL_FAILURES) continue;
            throw e;
          }
          if (!live()) return;
          applyJob(request.id, request.title, job);
        }
        if (job.status === 'error' || !job.url) {
          throw new Error(job.error ?? 'Could not prepare queued audio.');
        }

        const existingTrack = await TrackPlayer.getActiveTrack();
        await TrackPlayer.add({
          id: request.id,
          url: apiUrl(job.url),
          title: request.title,
          artist: 'Reading Companion',
          headers: authHeaders(),
        });
        if (!live()) return;
        await markHandoffHandled(request.id);
        setPrep(null);
        const { state } = await TrackPlayer.getPlaybackState();
        if (!existingTrack || state === State.None || state === State.Stopped || state === State.Ended) {
          setCurrentId(request.id);
          setCurrentTitle(request.title);
          await TrackPlayer.play();
        }
      } catch (e) {
        if (!live()) return;
        queuedIds.current.delete(request.id);
        setErrorById((errors) => ({
          ...errors,
          [request.id]: (e as Error).message ?? 'Could not prepare queued audio.',
        }));
        setPrep(null);
      }
    });
  }, [applyJob]);

  const dismiss = useCallback(async () => {
    cancelPrep();
    setCurrentId(null);
    setCurrentTitle(null);
    await TrackPlayer.reset().catch(() => {});
  }, [cancelPrep]);

  return (
    <AudioContext.Provider
      value={{
        playText,
        enqueueJob,
        prep,
        cancelPrep,
        currentId,
        currentTitle,
        dismiss,
        narrationById,
        errorById,
      }}>
      {children}
    </AudioContext.Provider>
  );
}

export function useAudio(): AudioContextValue {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used within AudioProvider');
  return ctx;
}
