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
import { messageAudioId, parseMessageAudioId, sessionAddressFromAudioSlug } from '@/audio/identity';
import {
  nextQueuedResponseIndex,
  nextTranscriptResponse,
  shouldAutoAdvance,
} from '@/audio/playlist';
import { setupPlayer } from '@/audio/setup';
import { consumeEligibleHandoff, dismissEligibleHandoffs } from '@/audio/handoffState';
import { useActiveProject } from '@/store/project';
import { showToast } from '@/ui/Toast';
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
  /** The server job id, once known — what cancelPrep POSTs to stop paid synthesis. */
  jobId?: string;
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
  /** Session-only opt-in. It is intentionally reset when this provider remounts. */
  playlistAutoplay: boolean;
  setPlaylistAutoplay: (enabled: boolean) => void;
  /** Advance to, or prepare, the next existing response in the active track's thread. */
  playNextResponse: () => Promise<boolean>;
}

const POLL_MS = 1000;
/** R6.5 — a manual (reading-mode) preparation that took longer than this gets an "Audio
 *  ready" toast when playback starts: the user has usually navigated away by then, and the
 *  toast explains why sound just started. Instant cache hits stay silent. Listening-mode
 *  queued audio never toasts — auto-play is its whole contract. */
const READY_TOAST_MIN_MS = 5000;
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

/** Stop playback and forget it, from outside the React tree.
 *
 *  Exists because the thing that ends a session — sign-out, an expiring token, a server switch —
 *  happens in `AuthProvider`, which sits ABOVE this provider and so cannot reach its context. And
 *  unmounting is not a usable trigger either: TrackPlayer is a singleton deliberately configured
 *  to outlive the React UI, and handoff eligibility is *meant* to survive a remount so playback
 *  can recover from a transient failure. Tying teardown to unmount would break that recovery.
 *
 *  Without this, the previous user's narration keeps playing over the sign-in screen and on into
 *  whoever signs in next. */
let sessionEpoch = 0;

/** The current audio session. Every in-flight pipeline captures this and stops if it changes:
 *  resetting the player is not enough on its own, because a queued `TrackPlayer.add` resolving
 *  afterwards would start the previous session's audio again on top of a reset player — over the
 *  sign-in screen, or into the next user's session. */
export function audioSessionEpoch(): number {
  return sessionEpoch;
}

export async function stopPlaybackForSessionEnd(): Promise<void> {
  // Bumped FIRST and synchronously, so everything already in flight is invalidated before any
  // await below gives it another chance to run.
  sessionEpoch += 1;
  await clearPlaybackSnapshot().catch(() => {});
  await dismissEligibleHandoffs().catch(() => {});
  await TrackPlayer.reset().catch(() => {});
}

export function AudioProvider({ children }: { children: ReactNode }) {
  const [prep, setPrep] = useState<PrepState | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  const [narrationById, setNarrationById] = useState<Record<string, string>>({});
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [playbackStartedAtById, setPlaybackStartedAtById] = useState<Record<string, string>>({});
  const [playlistAutoplay, setPlaylistAutoplayState] = useState(false);
  const playlistAutoplayRef = useRef(false);
  const playlistAdvanceRef = useRef<Promise<boolean> | null>(null);
  const prepRef = useRef<PrepState | null>(null);
  prepRef.current = prep;
  // When cancel arrives before the server job id is known (startAudioJob still in flight),
  // the intent is parked here keyed by the generations it kills; the in-flight run cancels
  // the job it receives before exiting. A generation superseded by a NEW play request is
  // deliberately absent: abandoning keeps the server job running into the cache.
  // Separate refs per pipeline: the manual playText loop and the queued listening loop can
  // overlap, and each must consume ONLY its own intent — a shared object let whichever loop
  // unwound first clear the other's intent, leaking that job's paid synthesis.
  const cancelIntentGen = useRef<number | null>(null);
  const cancelIntentQueueGen = useRef<number | null>(null);

  /** Cancel a server job with retries across the network blips this app expects (tunnel
   *  drops, backgrounding): a cancel the UI already showed must not silently die on one
   *  failed POST while the backend keeps billing. Resolves true once acknowledged; a 404
   *  counts (server restarted — the in-memory job is already gone). */
  const cancelServerJob = useCallback(async (jobId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await api.cancelAudioJob(jobId);
        return true;
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status !== undefined) return status === 404;
        await sleep(1000 * (attempt + 1));
      }
    }
    return false;
  }, []);
  // Bumped whenever a new prep starts (or is cancelled); stale loops see it and exit quietly.
  const generation = useRef(0);
  const queueGeneration = useRef(0);
  // Server polling for queued final narrations remains ordered independently from native-player
  // mutations. Preview cues may use the player while that slow polling is in progress.
  const queueTail = useRef<Promise<void>>(Promise.resolve());
  const playerTail = useRef<Promise<void>>(Promise.resolve());
  const automaticPrepIdRef = useRef<string | null>(null);
  const queuedHandoffs = useRef(new Set<string>());
  const queuedPreparationCounts = useRef(new Map<string, number>());
  // The initiating project, for billing the narration LLM spend (audio itself is app-global).
  // Held in a ref so playText keeps a stable identity as the active project changes.
  const { activePid } = useActiveProject();
  const activePidRef = useRef(activePid);
  activePidRef.current = activePid;
  // Playback style (polish plan I.1, Settings → Audio): 'full' waits for the complete
  // stitched track (duration visible, lock/background-proof, whole-response rewind);
  // 'progressive' plays segments as they land (starts sooner). Captured per preparation
  // via this ref so flipping the setting mid-prep can't mix the two paths.
  const { listeningMode, playbackMode, playbackRate } = useListeningMode();
  const listeningModeRef = useRef(listeningMode);
  listeningModeRef.current = listeningMode;
  const playbackModeRef = useRef(playbackMode);
  playbackModeRef.current = playbackMode;
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  const setPlaylistAutoplay = useCallback((enabled: boolean) => {
    playlistAutoplayRef.current = enabled;
    setPlaylistAutoplayState(enabled);
  }, []);

  // R6.6 — apply the persisted speed live when the user changes it; harmless no-op when the
  // player isn't set up yet (the track-change hook below covers every track load, including
  // the cold-start restore, since platform players can reset rate with a new queue).
  useEffect(() => {
    void TrackPlayer.setRate(playbackRate).catch(() => {});
  }, [playbackRate]);

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
    if (playbackRateRef.current !== 1) {
      void TrackPlayer.setRate(playbackRateRef.current).catch(() => {});
    }
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
    // Also stop the SERVER job (fire-and-forget): before this, cancel only stopped the client
    // watching while the backend kept billing narration/TTS for audio nobody wanted. Segments
    // already synthesized stay cached, so a later re-tap resumes instead of restarting.
    const jobId = prepRef.current?.jobId;
    if (jobId) void cancelServerJob(jobId);
    // Park intent unconditionally (generation-keyed, so it can only fire for the run being
    // cancelled right now): covers windows where the visible prep's jobId is stale or absent —
    // e.g. a queued preparation whose first poll hasn't landed. Double-cancel is idempotent.
    cancelIntentGen.current = generation.current;
    cancelIntentQueueGen.current = queueGeneration.current;
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
  }, [cancelServerJob]);

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
      jobId: job.id,
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
      const epoch = sessionEpoch;
      const live = () => generation.current === gen && sessionEpoch === epoch;
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
      const prepStartedAt = Date.now();
      const toastIfWaited = () => {
        if (Date.now() - prepStartedAt >= READY_TOAST_MIN_MS) showToast('Audio ready');
      };

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
            toastIfWaited();
            await TrackPlayer.play();
          }
        };
        let { job } = await api.startAudioJob(text, billingProject);
        // Cancel raced ahead of the job id becoming known: without this, the stale-generation
        // exit below would leak a running billed job the user believes is cancelled.
        const abandonIfCancelled = () => {
          if (cancelIntentGen.current === gen && job.status === 'running') {
            // Clear the intent only once the server acknowledged; a failed POST keeps it so
            // a later exit point (or nothing — it is generation-keyed) can't leak the job.
            void cancelServerJob(job.id).then((ok) => {
              if (ok && cancelIntentGen.current === gen) cancelIntentGen.current = null;
            });
          }
        };
        if (!live()) {
          abandonIfCancelled();
          return;
        }
        applyJob(id, title, job);
        await appendSegments(job);

        let pollFailures = 0;
        let restarts = 0;
        while (job.status === 'running') {
          await sleep(POLL_MS);
          if (!live()) {
            abandonIfCancelled();
            return;
          }
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
          if (!live()) {
            abandonIfCancelled();
            return;
          }
          applyJob(id, title, job);
          await appendSegments(job);
        }

        if (job.status === 'cancelled') {
          if (live()) setPrep(null);   // cancelled elsewhere; wind down without an error row
          return;
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
        toastIfWaited();
        await TrackPlayer.play();
      } catch (e) {
        fail((e as Error).message ?? 'Could not prepare audio.');
      }
    },
    [currentId, applyJob, cancelServerJob],
  );

  const playPreview = useCallback(async (id: string, title: string, url: string) => {
    const queueGen = queueGeneration.current;
    const queueEpoch = sessionEpoch;
    let played = false;
    const run = async () => {
      const live = () => queueGeneration.current === queueGen && sessionEpoch === queueEpoch;
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
                                  chatJobId?: string | null,
                                  persistHandoff = true,
                                  playWhenReady = false) => {
    const handoffIdentity = `${request.id}|${chatJobId ?? audioJobId}|${audioJobId}`;
    const handoffKey = persistHandoff ? handoffIdentity : `playlist|${handoffIdentity}`;
    if (queuedHandoffs.current.has(handoffKey)) return;
    // A live handoff already polling this exact response wins over transcript fallback. It will
    // append through this same path, and a second playlist poll would only duplicate the track.
    if (!persistHandoff && queuedPreparationCounts.current.has(request.id)) return;
    queuedHandoffs.current.add(handoffKey);
    queuedPreparationCounts.current.set(
      request.id,
      (queuedPreparationCounts.current.get(request.id) ?? 0) + 1,
    );
    const releasePreparation = () => {
      const remaining = (queuedPreparationCounts.current.get(request.id) ?? 1) - 1;
      if (remaining > 0) queuedPreparationCounts.current.set(request.id, remaining);
      else queuedPreparationCounts.current.delete(request.id);
    };
    const queueGen = queueGeneration.current;
    const queueEpoch = sessionEpoch;

    queueTail.current = queueTail.current.then(async () => {
      if (queueGeneration.current !== queueGen || sessionEpoch !== queueEpoch) {
        releasePreparation();
        return;
      }
      if (persistHandoff && (await handledHandoffs()).includes(handoffKey)) {
        releasePreparation();
        if (chatJobId) await consumeEligibleHandoff(chatJobId);
        return;
      }
      if (queueGeneration.current !== queueGen || sessionEpoch !== queueEpoch) {
        releasePreparation();
        return;
      }
      const live = () => queueGeneration.current === queueGen && sessionEpoch === queueEpoch;
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
            const firstAddedIndex = queue.length - staleIndexes.length;
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
              if (playWhenReady) await TrackPlayer.skip(firstAddedIndex);
              if (playWhenReady || !existingTrack || state === State.None || state === State.Stopped
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
        // Mirror of playText's early-dismiss race: cancel intent parked before the job id was
        // known must still stop the billed server job.
        const abandonIfCancelled = () => {
          if (cancelIntentQueueGen.current === queueGen && job.status === 'running') {
            void cancelServerJob(job.id).then((ok) => {
              if (ok && cancelIntentQueueGen.current === queueGen) cancelIntentQueueGen.current = null;
            });
          }
        };
        if (!live()) {
          abandonIfCancelled();
          return;
        }
        applyJob(request.id, request.title, job);
        await appendSegments(job);

        let pollFailures = 0;
        while (job.status === 'running') {
          await sleep(POLL_MS);
          if (!live()) {
            abandonIfCancelled();
            return;
          }
          try {
            job = (await api.getAudioJob(job.id)).job;
            pollFailures = 0;
          } catch (e) {
            if ((e as { status?: number }).status === undefined
                && ++pollFailures < MAX_POLL_FAILURES) continue;
            throw e;
          }
          if (!live()) {
            abandonIfCancelled();
            return;
          }
          applyJob(request.id, request.title, job);
          await appendSegments(job);
        }
        if (job.status === 'cancelled') {
          if (live()) setPrep(null);
          return;
        }
        if (job.status === 'error' || !job.url) {
          terminalAudioFailure = true;
          throw new Error(job.error ?? 'Could not prepare queued audio.');
        }

        if (addedSegments > 0) {
          if (persistHandoff) await markHandoffHandled(handoffKey);
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
          const addedIndex = queue.length - staleIndexes.length;
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
          if (playWhenReady) await TrackPlayer.skip(addedIndex);
          if (playWhenReady || !existingTrack || state === State.None || state === State.Stopped
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
        if (persistHandoff) await markHandoffHandled(handoffKey);
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
        releasePreparation();
        if (!persistHandoff) queuedHandoffs.current.delete(handoffKey);
      }
    });
  }, [applyJob, cancelServerJob]);

  const playNextResponse = useCallback((automatic = false, activeIndexHint?: number) => {
    if (!listeningModeRef.current
        || (automatic && !shouldAutoAdvance(playlistAutoplayRef.current, true))) {
      return Promise.resolve(false);
    }
    if (playlistAdvanceRef.current) return playlistAdvanceRef.current;

    const advance = async (): Promise<boolean> => {
      try {
        await setupPlayer();
        const [queue, reportedIndex, activeTrack] = await Promise.all([
          TrackPlayer.getQueue(),
          TrackPlayer.getActiveTrackIndex(),
          TrackPlayer.getActiveTrack(),
        ]);
        const activeIndex = reportedIndex ?? activeIndexHint;
        const queuedIndex = nextQueuedResponseIndex(queue, activeIndex);
        if (queuedIndex != null) {
          await TrackPlayer.skip(queuedIndex);
          await TrackPlayer.play();
          return true;
        }

        const currentTrack = activeTrack ?? (activeIndex == null ? undefined : queue[activeIndex]);
        const currentSlotId = currentTrack?.slotId ?? currentTrack?.id;
        const identity = parseMessageAudioId(currentSlotId == null ? '' : String(currentSlotId));
        if (!identity) return false;

        const address = sessionAddressFromAudioSlug(identity.slug);
        const session = await api.getSession(identity.project, address.slug, address.threadId);
        const next = nextTranscriptResponse(session.transcript, identity.assistantIndex);
        if (!next) return false;

        // A live handoff may have landed while the transcript request was in flight. Prefer that
        // already-queued work and never synthesize a duplicate playlist copy.
        const [freshQueue, freshActiveIndex, freshActiveTrack] = await Promise.all([
          TrackPlayer.getQueue(),
          TrackPlayer.getActiveTrackIndex(),
          TrackPlayer.getActiveTrack(),
        ]);
        const resolvedFreshIndex = freshActiveIndex ?? activeIndexHint;
        const resolvedFreshTrack = freshActiveTrack
          ?? (resolvedFreshIndex == null ? undefined : freshQueue[resolvedFreshIndex]);
        const freshSlotId = resolvedFreshTrack?.slotId ?? resolvedFreshTrack?.id;
        if (freshSlotId != null && String(freshSlotId) !== String(currentSlotId)) return true;
        const freshNextIndex = nextQueuedResponseIndex(
          freshQueue,
          resolvedFreshIndex,
        );
        if (freshNextIndex != null) {
          await TrackPlayer.skip(freshNextIndex);
          await TrackPlayer.play();
          return true;
        }

        const nextId = messageAudioId(
          identity.project,
          identity.slug,
          next.assistant_index,
          next.canonical,
        );
        if (queuedPreparationCounts.current.has(nextId)) return true;

        let audioJobId = next.audio_error ? null : next.audio_job_id;
        if (!audioJobId) {
          audioJobId = (await api.startAudioJob(next.canonical, identity.project)).job.id;
        }
        enqueueJob(
          {
            id: nextId,
            title: session.paper.title ?? 'Narration',
            text: next.canonical,
          },
          audioJobId,
          identity.project,
          null,
          false,
          !automatic,
        );
        return true;
      } catch {
        return false;
      }
    };

    const task = advance().finally(() => {
      if (playlistAdvanceRef.current === task) playlistAdvanceRef.current = null;
    });
    playlistAdvanceRef.current = task;
    return task;
  }, [enqueueJob]);

  useTrackPlayerEvents([Event.PlaybackQueueEnded], (event) => {
    void playNextResponse(true, event.track);
  });

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
        playlistAutoplay,
        setPlaylistAutoplay,
        playNextResponse: () => playNextResponse(false),
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
