// Audio controller: turns an assistant message into spoken audio and plays it through
// TrackPlayer (background + lock screen). Preparation (narrate -> synthesize) runs as a
// SERVER-SIDE background job that we poll — never a single long-lived request. A blocking
// request dies at the tunnel/proxy timeout (Cloudflare 524 at ~100s) even while the server
// finishes and caches the audio; polling survives timeouts, network blips, and the app being
// backgrounded, and gives real progress (stage + synthesized segments) instead of a spinner.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import TrackPlayer, { Event, State, useTrackPlayerEvents } from 'react-native-track-player';

import { apiUrl, authHeaders } from '@/api/client';
import * as api from '@/api/endpoints';
import type { AudioJob } from '@/api/types';
import { setupPlayer } from '@/audio/setup';
import { consumeEligibleHandoff, dismissEligibleHandoffs } from '@/audio/handoffState';
import { useActiveProject } from '@/store/project';
import { useListeningMode } from '@/store/listening';
import {
  checkpointPlayback,
  clearPlaybackSnapshot,
  readPlaybackSnapshot,
} from '../../playback-persistence';

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
  enqueueJob: (
    req: PlayRequest,
    audioJobId: string,
    billingProject: string | null,
    chatJobId?: string | null,
  ) => void;
  /** Play one already-generated progress cue only if playback/preparation is otherwise idle. */
  playPreview: (id: string, title: string, url: string) => Promise<boolean>;
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
  playbackStartedAtById: Record<string, string>;
}

const POLL_MS = 1000;
// Polls that may fail in a row (network blips, brief tunnel drops) before we give up.
const MAX_POLL_FAILURES = 8;
// Most grounded cues to keep queued behind the currently-playing cue (opportunistic; extra
// cues are dropped so a long narration prep never builds a backlog that delays the response).
const MAX_QUEUED_CUES = 2;
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
  const [playbackStartedAtById, setPlaybackStartedAtById] = useState<Record<string, string>>({});
  const prepRef = useRef<PrepState | null>(null);
  prepRef.current = prep;
  // Bumped whenever a new prep starts (or is cancelled); stale loops see it and exit quietly.
  const generation = useRef(0);
  const queueGeneration = useRef(0);
  // Server polling for queued final narrations remains ordered independently from native-player
  // mutations. Preview cues may use the player while that slow polling is in progress.
  const queueTail = useRef<Promise<void>>(Promise.resolve());
  const playerTail = useRef<Promise<void>>(Promise.resolve());
  const automaticPrepIdRef = useRef<string | null>(null);
  const queuedHandoffs = useRef(new Set<string>());
  // The initiating project, for billing the narration LLM spend (audio itself is app-global).
  // Held in a ref so playText keeps a stable identity as the active project changes.
  const { activePid } = useActiveProject();
  const activePidRef = useRef(activePid);
  activePidRef.current = activePid;
  // Playback style (polish plan I.1, Settings → Audio): 'full' waits for the complete
  // stitched track (duration visible, lock/background-proof, whole-response rewind);
  // 'progressive' plays segments as they land (starts sooner). Captured per preparation
  // via this ref so flipping the setting mid-prep can't mix the two paths.
  const { playbackMode } = useListeningMode();
  const playbackModeRef = useRef(playbackMode);
  playbackModeRef.current = playbackMode;

  useEffect(() => {
    let active = true;
    const restore = async () => {
      await setupPlayer();
      const snapshot = await readPlaybackSnapshot();
      if (!snapshot) return;
      const existing = await TrackPlayer.getActiveTrack();
      if (existing && !String(existing.id ?? '').startsWith('preview:')) {
        await TrackPlayer.pause().catch(() => {});
        if (!active) return;
        const slotId = String(existing.slotId ?? existing.id);
        setCurrentId(slotId);
        setCurrentTitle(existing.title != null ? String(existing.title) : null);
        if (typeof existing.narration === 'string') {
          setNarrationById((value) => ({ ...value, [slotId]: existing.narration }));
        }
        return;
      }

      if (snapshot.duration > 0
          && snapshot.position >= Math.max(0, snapshot.duration - 1)) {
        await clearPlaybackSnapshot();
        return;
      }
      const queue = await TrackPlayer.getQueue();
      if (!active || queue.length) return;
      await TrackPlayer.add(snapshot.tracks.map((track) => ({
        ...track,
        url: track.sourceUrl ? apiUrl(track.sourceUrl) : track.url,
        headers: authHeaders(),
      })));
      if (!active) return;
      await TrackPlayer.seekTo(snapshot.position);
      setCurrentId(snapshot.slotId);
      setCurrentTitle(snapshot.title || null);
      const narration = snapshot.tracks.find((track) => track.narration)?.narration;
      if (narration) setNarrationById((value) => ({ ...value, [snapshot.slotId]: narration }));
    };
    void restore().catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void checkpointPlayback(TrackPlayer).catch(() => {});
    });
    return () => subscription.remove();
  }, []);

  useTrackPlayerEvents([Event.PlaybackActiveTrackChanged], (event) => {
    const track = event.track;
    const slotId = track?.slotId ?? track?.id;
    setCurrentId(slotId != null ? String(slotId) : null);
    setCurrentTitle(track?.title != null ? String(track.title) : null);
    if (slotId != null) {
      const id = String(slotId);
      setPlaybackStartedAtById((value) => value[id]
        ? value : { ...value, [id]: new Date().toISOString() });
    }
  });

  const cancelPrep = useCallback(() => {
    generation.current += 1;
    queueGeneration.current += 1;
    automaticPrepIdRef.current = null;
    queuedHandoffs.current.clear();
    setPrep(null);
    void dismissEligibleHandoffs();
    const removeUpcoming = () => TrackPlayer.removeUpcomingTracks().catch(() => {});
    // Serialize cleanup after any in-flight native add. If cancellation wins while an add is
    // pending, that stale add completes before this removal runs.
    playerTail.current = playerTail.current.then(removeUpcoming, removeUpcoming);
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
          await checkpointPlayback(TrackPlayer).catch(() => {});
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
        // In 'full' mode addedSegments stays 0 and the final stitched-track path below is
        // the only one that plays; the server still synthesizes segment-by-segment and the
        // prep card shows that progress either way.
        const incremental = playbackModeRef.current === 'progressive';
        let addedSegments = 0;
        const appendSegments = async (nextJob: AudioJob) => {
          if (!incremental) return;
          const fresh = nextJob.segments.slice(addedSegments);
          if (!fresh.length) return;
          if (addedSegments === 0) await TrackPlayer.reset();
          for (const segment of fresh) {
            await TrackPlayer.add({
              id: `${id}|${nextJob.id}|segment:${segment.index}`,
              slotId: id,
              sourceUrl: segment.url,
              segmentIndex: segment.index,
              sentenceText: segment.text,
              narration: nextJob.narration ?? undefined,
              url: apiUrl(segment.url),
              title,
              artist: 'Reading Companion',
              headers: authHeaders(),
            });
            addedSegments += 1;
          }
          if (addedSegments === fresh.length && live()) {
            setCurrentId(id);
            setCurrentTitle(title);
            setPlaybackStartedAtById((value) => value[id]
              ? value : { ...value, [id]: new Date().toISOString() });
            await TrackPlayer.play();
          }
        };
        let { job } = await api.startAudioJob(text, billingProject);
        if (!live()) return;
        applyJob(id, title, job);
        await appendSegments(job);

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
          await appendSegments(job);
        }

        if (job.status === 'error' || !job.url) {
          fail(job.error ?? 'Could not prepare audio.');
          return;
        }

        if (addedSegments > 0) {
          setPrep(null);
          return;
        }

        await TrackPlayer.reset();
        await TrackPlayer.add({
          id,
          slotId: id,
          sourceUrl: job.url,
          url: apiUrl(job.url),
          title,
          // The full narration rides on the track so sentence-jump and the transcript
          // work across the WHOLE response (sentence-seek reads track.narration).
          narration: job.narration ?? undefined,
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
        setPlaybackStartedAtById((value) => value[id]
          ? value : { ...value, [id]: new Date().toISOString() });
        await TrackPlayer.play();
      } catch (e) {
        fail((e as Error).message ?? 'Could not prepare audio.');
      }
    },
    [currentId, applyJob],
  );

  const playPreview = useCallback(async (id: string, title: string, url: string) => {
    const queueGen = queueGeneration.current;
    let played = false;
    const run = async () => {
      const live = () => queueGeneration.current === queueGen;
      // Manual playback preparation owns the player. Automatic listening-mode preparation is
      // different: it runs remotely for minutes, and preview cues are specifically meant to fill
      // that wait until the final track is ready.
      if (!live() || (prepRef.current && prepRef.current.id !== automaticPrepIdRef.current)) return;
      try {
        await setupPlayer();
        const [{ state }, activeIndex, queue] = await Promise.all([
          TrackPlayer.getPlaybackState(),
          TrackPlayer.getActiveTrackIndex(),
          TrackPlayer.getQueue(),
        ]);
        if (!live() || (prepRef.current && prepRef.current.id !== automaticPrepIdRef.current)) return;
        const activeBusy = activeIndex != null
          && state !== State.None && state !== State.Stopped && state !== State.Ended;
        const activeTrack = activeIndex == null ? null : queue[activeIndex];
        const activeIsPreview = String(activeTrack?.id ?? '').startsWith('preview:');
        const upcoming = activeIndex == null ? queue : queue.slice(activeIndex + 1);
        const upcomingOnlyPreviews = upcoming.every((track) =>
          String(track.id).startsWith('preview:'));

        // Never interrupt or queue ahead of user-selected/final audio. When a cue is already
        // speaking, append the next cue so TrackPlayer advances naturally without a reset gap.
        if ((activeBusy && !activeIsPreview) || !upcomingOnlyPreviews) return;
        if (activeBusy && activeIsPreview) {
          // Cap the play-ahead backlog: keep at most MAX_QUEUED_CUES waiting behind the active
          // cue so a slow narration prep doesn't build a queue of stale cues that all have to
          // play out before the response does. Extra cues are simply dropped (opportunistic).
          if (upcoming.length >= MAX_QUEUED_CUES) return;
          await TrackPlayer.add({
            id,
            url: apiUrl(url),
            title,
            artist: 'Reading Companion',
            headers: authHeaders(),
          });
          played = true;
          return;
        }

        if (queue.length) await TrackPlayer.reset();
        if (!live()) return;
        await TrackPlayer.add({
          id,
          url: apiUrl(url),
          title,
          artist: 'Reading Companion',
          headers: authHeaders(),
        });
        if (!live()) return;
        setCurrentId(id);
        setCurrentTitle(title);
        setPlaybackStartedAtById((value) => value[id]
          ? value : { ...value, [id]: new Date().toISOString() });
        await TrackPlayer.play();
        played = true;
      } catch {
        // Preview cues are opportunistic. Final narration and manual playback remain primary.
      }
    };
    const task = playerTail.current.then(run, run);
    playerTail.current = task;
    await task;
    return played;
  }, []);

  const enqueueJob = useCallback((request: PlayRequest, audioJobId: string,
                                  billingProject: string | null,
                                  chatJobId?: string | null) => {
    const handoffKey = `${request.id}|${chatJobId ?? audioJobId}|${audioJobId}`;
    if (queuedHandoffs.current.has(handoffKey)) return;
    queuedHandoffs.current.add(handoffKey);
    const queueGen = queueGeneration.current;

    queueTail.current = queueTail.current.then(async () => {
      if (queueGeneration.current !== queueGen) return;
      if ((await handledHandoffs()).includes(handoffKey)) {
        if (chatJobId) await consumeEligibleHandoff(chatJobId);
        return;
      }
      if (queueGeneration.current !== queueGen) return;
      const live = () => queueGeneration.current === queueGen;
      automaticPrepIdRef.current = request.id;
      setErrorById((errors) => {
        if (!(request.id in errors)) return errors;
        const { [request.id]: _drop, ...rest } = errors;
        return rest;
      });
      setPrep({ id: request.id, title: request.title, stage: 'starting', done: 0, total: 0 });

      let terminalAudioFailure = false;
      try {
        await setupPlayer();
        // See playText: 'full' keeps addedSegments at 0 so the stitched-track path below
        // is the only playback; preview cues keep playing through the whole wait.
        const incremental = playbackModeRef.current === 'progressive';
        let addedSegments = 0;
        let progressiveStarted = false;
        const appendSegments = async (nextJob: AudioJob) => {
          if (!incremental) return;
          const fresh = nextJob.segments.slice(addedSegments);
          if (!fresh.length) return;
          const firstBatch = addedSegments === 0;
          // The first playable final segment closes preview admission. Cue mutations already
          // admitted finish first through playerTail; this task then removes queued cues and
          // appends final segments without interrupting an active cue or final track.
          if (firstBatch) automaticPrepIdRef.current = null;
          const addFresh = async () => {
            if (!live()) return;
            const activeIndex = await TrackPlayer.getActiveTrackIndex();
            const queue = await TrackPlayer.getQueue();
            const staleIndexes = queue
              .map((track, index) => {
                const slotId = track.slotId ?? track.id;
                const staleSlot = String(slotId) === request.id;
                const queuedPreview = firstBatch && String(track.id).startsWith('preview:');
                return index !== activeIndex && (staleSlot || queuedPreview) ? index : -1;
              })
              .filter((index) => index >= 0);
            if (staleIndexes.length) await TrackPlayer.remove(staleIndexes);
            const existingTrack = await TrackPlayer.getActiveTrack();
            for (const segment of fresh) {
              await TrackPlayer.add({
                id: `${request.id}|${audioJobId}|segment:${segment.index}`,
                slotId: request.id,
                sourceUrl: segment.url,
                segmentIndex: segment.index,
                sentenceText: segment.text,
                narration: nextJob.narration ?? undefined,
                url: apiUrl(segment.url),
                title: request.title,
                artist: 'Reading Companion',
                headers: authHeaders(),
              });
              addedSegments += 1;
            }
            if (!progressiveStarted && live()) {
              const { state } = await TrackPlayer.getPlaybackState();
              if (!existingTrack || state === State.None || state === State.Stopped
                  || state === State.Ended) {
                setCurrentId(request.id);
                setCurrentTitle(request.title);
                setPlaybackStartedAtById((value) => value[request.id]
                  ? value : { ...value, [request.id]: new Date().toISOString() });
                await TrackPlayer.play();
                progressiveStarted = true;
              }
            }
          };
          const playerTask = playerTail.current.then(addFresh, addFresh);
          playerTail.current = playerTask;
          await playerTask;
        };
        let job: AudioJob;
        try {
          job = (await api.getAudioJob(audioJobId)).job;
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          job = (await api.startAudioJob(request.text, billingProject)).job;
        }
        if (!live()) return;
        applyJob(request.id, request.title, job);
        await appendSegments(job);

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
          await appendSegments(job);
        }
        if (job.status === 'error' || !job.url) {
          terminalAudioFailure = true;
          throw new Error(job.error ?? 'Could not prepare queued audio.');
        }

        if (addedSegments > 0) {
          await markHandoffHandled(handoffKey);
          if (chatJobId) await consumeEligibleHandoff(chatJobId);
          setPrep(null);
          return;
        }

        // Full stitched track (the only path in 'full' mode; also the cache fallback for
        // 'progressive'): same preview gate and serialized handoff.
        automaticPrepIdRef.current = null;
        const finalUrl = job.url;
        const finalNarration = job.narration ?? undefined;
        let added = false;
        const addFinal = async () => {
          if (!live()) return;
          const activeIndex = await TrackPlayer.getActiveTrackIndex();
          const queue = await TrackPlayer.getQueue();
          const staleIndexes = queue
            .map((track, index) => {
              const slotId = track.slotId ?? track.id;
              return index !== activeIndex && (
                String(slotId) === request.id || String(track.id).startsWith('preview:')
              ) ? index : -1;
            })
            .filter((index) => index >= 0);
          if (staleIndexes.length) await TrackPlayer.remove(staleIndexes);
          const existingTrack = await TrackPlayer.getActiveTrack();
          await TrackPlayer.add({
            id: request.id,
            slotId: request.id,
            sourceUrl: finalUrl,
            url: apiUrl(finalUrl),
            title: request.title,
            narration: finalNarration,
            artist: 'Reading Companion',
            headers: authHeaders(),
          });
          if (!live()) return;
          const { state } = await TrackPlayer.getPlaybackState();
          if (!existingTrack || state === State.None || state === State.Stopped
              || state === State.Ended) {
            setCurrentId(request.id);
            setCurrentTitle(request.title);
            setPlaybackStartedAtById((value) => value[request.id]
              ? value : { ...value, [request.id]: new Date().toISOString() });
            await TrackPlayer.play();
          }
          added = true;
        };
        const playerTask = playerTail.current.then(addFinal, addFinal);
        playerTail.current = playerTask;
        await playerTask;
        if (!live() || !added) return;
        await markHandoffHandled(handoffKey);
        if (chatJobId) await consumeEligibleHandoff(chatJobId);
        setPrep(null);
      } catch (e) {
        if (!live()) return;
        queuedHandoffs.current.delete(handoffKey);
        if (chatJobId && terminalAudioFailure) await consumeEligibleHandoff(chatJobId);
        setErrorById((errors) => ({
          ...errors,
          [request.id]: (e as Error).message ?? 'Could not prepare queued audio.',
        }));
        setPrep(null);
      } finally {
        automaticPrepIdRef.current = null;
      }
    });
  }, [applyJob]);

  const dismiss = useCallback(async () => {
    cancelPrep();
    await clearPlaybackSnapshot().catch(() => {});
    setCurrentId(null);
    setCurrentTitle(null);
    const reset = () => TrackPlayer.reset().catch(() => {});
    const task = playerTail.current.then(reset, reset);
    playerTail.current = task;
    await task;
  }, [cancelPrep]);

  return (
    <AudioContext.Provider
      value={{
        playText,
        enqueueJob,
        playPreview,
        prep,
        cancelPrep,
        currentId,
        currentTitle,
        dismiss,
        narrationById,
        errorById,
        playbackStartedAtById,
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
