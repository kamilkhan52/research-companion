import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { cancelAudioJob, getAudioJob, startAudioJob } from '@/api/endpoints';
import { ApiError, apiGet } from '@/api/client';
import { useActivePid } from '@/hooks/useLibrary';

interface Request { id: string; title: string; text: string; }
interface Current { id: string; title: string; narration: string; }
interface Prep { title: string; stage: string; done: number; total: number; }
interface AudioContextValue { playText: (request: Request) => Promise<void>; current: Current | null; prep: Prep | null; playing: boolean; position: number; duration: number; rate: number; toggle: () => void; dismiss: () => void; seekTo: (seconds: number) => void; seekBy: (seconds: number) => void; seekSentence: (direction: -1 | 1) => void; setRate: (rate: number) => void; error: string | null; }
const AudioContext = createContext<AudioContextValue | null>(null);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AudioProvider({ children }: { children: ReactNode }) {
  const [activePid] = useActivePid();
  const [current, setCurrent] = useState<Current | null>(null);
  const [prep, setPrep] = useState<Prep | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speechRef = useRef<SpeechSynthesisUtterance | null>(null);
  const generation = useRef(0);
  // The in-flight server preparation job, so dismiss can cancel it (stop paid TTS), not
  // just stop watching. Cleared once the job settles.
  const prepJobId = useRef<string | null>(null);
  // Cancel that arrives before the job id is known (startAudioJob still in flight) parks its
  // intent here keyed by the generation it killed; the in-flight run cancels the job it
  // receives before exiting.
  const cancelIntent = useRef<number | null>(null);

  useEffect(() => () => { audioRef.current?.pause(); window.speechSynthesis?.cancel(); }, []);

  const dismiss = useCallback(() => {
    if (prepJobId.current) { void cancelAudioJob(prepJobId.current).catch(() => {}); prepJobId.current = null; }
    // Park intent unconditionally: it is keyed to the exact live generation, so it can only
    // ever fire for the run being cancelled right now (covers the window where a NEW run's
    // start request is in flight and prepJobId doesn't name it yet). Harmless when idle.
    cancelIntent.current = generation.current;
    generation.current += 1; audioRef.current?.pause(); audioRef.current = null; window.speechSynthesis?.cancel();
    speechRef.current = null; setCurrent(null); setPrep(null); setPlaying(false); setPosition(0); setDuration(0);
  }, []);
  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      if (speechRef.current) { if (window.speechSynthesis.paused) window.speechSynthesis.resume(); else window.speechSynthesis.pause(); setPlaying(!window.speechSynthesis.paused); }
      return;
    }
    if (audio.paused) void audio.play(); else audio.pause();
  }, []);
  const seekTo = useCallback((seconds: number) => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, Math.min(seconds, audioRef.current.duration || seconds)); }, []);
  const seekBy = useCallback((seconds: number) => { if (audioRef.current) seekTo(audioRef.current.currentTime + seconds); }, [seekTo]);
  const setRate = useCallback((next: number) => { setRateState(next); if (audioRef.current) audioRef.current.playbackRate = next; }, []);
  const seekSentence = useCallback((direction: -1 | 1) => {
    if (!audioRef.current || !current?.narration || !duration) return;
    const ends = [...current.narration.matchAll(/[^.!?]+[.!?]+|[^.!?]+$/g)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
    const char = (position / duration) * current.narration.length;
    const index = Math.max(0, ends.findIndex((sentence) => char < sentence.end));
    const target = ends[Math.max(0, Math.min(ends.length - 1, index + direction))];
    if (target) seekTo((target.start / current.narration.length) * duration);
  }, [current?.narration, duration, position, seekTo]);

  const playText = useCallback(async ({ id, title, text }: Request) => {
    if (current?.id === id && audioRef.current) { toggle(); return; }
    const run = ++generation.current;
    const live = () => generation.current === run;
    // A leftover id from the previous run must not be what a dismiss during THIS run's start
    // window cancels (that job was deliberately abandoned to warm the cache).
    prepJobId.current = null;
    setError(null); setPrep({ title, stage: 'starting', done: 0, total: 0 });
    try {
      const settings = await apiGet<{ speech_provider?: string }>('/api/settings');
      if (!live()) return;
      if (settings.speech_provider === 'browser') {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = rate; speechRef.current = utterance;
        utterance.onend = () => { if (live()) setPlaying(false); speechRef.current = null; };
        window.speechSynthesis.speak(utterance);
        setCurrent({ id, title, narration: text }); setPrep(null); setPlaying(true); return;
      }
      let { job } = await startAudioJob(text, activePid);
      const abandonIfCancelled = () => {
        if (cancelIntent.current === run && job.status === 'running') {
          void cancelAudioJob(job.id).catch(() => {});
          cancelIntent.current = null;
        }
      };
      let restarts = 0;
      while (job.status === 'running') {
        if (!live()) { abandonIfCancelled(); return; }
        prepJobId.current = job.id;
        setPrep({ title, stage: job.stage, done: job.segments_done, total: job.segments_total });
        await delay(1000);
        try { ({ job } = await getAudioJob(job.id));
        } catch (caught) {
          if (caught instanceof ApiError && caught.status === 404 && restarts++ < 2) ({ job } = await startAudioJob(text, activePid));
          else throw caught;
        }
      }
      prepJobId.current = null;
      if (!live()) return;
      if (job.status === 'cancelled') { setPrep(null); return; }
      if (job.status === 'error' || !job.url) throw new Error(job.error || 'Could not prepare audio.');
      const audio = new Audio(job.url);
      audio.onplay = () => setPlaying(true); audio.onpause = () => setPlaying(false); audio.onended = () => setPlaying(false);
      audio.ontimeupdate = () => setPosition(audio.currentTime); audio.ondurationchange = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0); audio.playbackRate = rate;
      audioRef.current?.pause(); audioRef.current = audio;
      setCurrent({ id, title, narration: job.narration || text }); setPrep(null); await audio.play();
    } catch (caught) { if (live()) { setPrep(null); setError(caught instanceof Error ? caught.message : 'Could not prepare audio.'); } }
  }, [activePid, current?.id, rate, toggle]);

  return <AudioContext.Provider value={{ playText, current, prep, playing, position, duration, rate, toggle, dismiss, seekTo, seekBy, seekSentence, setRate, error }}>{children}</AudioContext.Provider>;
}

export function useAudio() {
  const value = useContext(AudioContext);
  if (!value) throw new Error('useAudio must be used inside AudioProvider');
  return value;
}
