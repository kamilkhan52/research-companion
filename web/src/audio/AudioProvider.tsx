import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { getAudioJob, startAudioJob } from '@/api/endpoints';
import { ApiError, apiGet } from '@/api/client';
import { useActivePid } from '@/hooks/useLibrary';

interface Request { id: string; title: string; text: string; }
interface Current { id: string; title: string; narration: string; }
interface Prep { title: string; stage: string; done: number; total: number; }
interface AudioContextValue { playText: (request: Request) => Promise<void>; current: Current | null; prep: Prep | null; playing: boolean; toggle: () => void; dismiss: () => void; error: string | null; }
const AudioContext = createContext<AudioContextValue | null>(null);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AudioProvider({ children }: { children: ReactNode }) {
  const [activePid] = useActivePid();
  const [current, setCurrent] = useState<Current | null>(null);
  const [prep, setPrep] = useState<Prep | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);

  useEffect(() => () => { audioRef.current?.pause(); window.speechSynthesis?.cancel(); }, []);

  const dismiss = useCallback(() => {
    generation.current += 1; audioRef.current?.pause(); audioRef.current = null; window.speechSynthesis?.cancel();
    setCurrent(null); setPrep(null); setPlaying(false);
  }, []);
  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play(); else audio.pause();
  }, []);

  const playText = useCallback(async ({ id, title, text }: Request) => {
    if (current?.id === id && audioRef.current) { toggle(); return; }
    const run = ++generation.current;
    const live = () => generation.current === run;
    setError(null); setPrep({ title, stage: 'starting', done: 0, total: 0 });
    try {
      const settings = await apiGet<{ speech_provider?: string }>('/api/settings');
      if (!live()) return;
      if (settings.speech_provider === 'browser') {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.onend = () => { if (live()) setPlaying(false); };
        window.speechSynthesis.speak(utterance);
        setCurrent({ id, title, narration: text }); setPrep(null); setPlaying(true); return;
      }
      let { job } = await startAudioJob(text, activePid);
      let restarts = 0;
      while (job.status === 'running') {
        if (!live()) return;
        setPrep({ title, stage: job.stage, done: job.segments_done, total: job.segments_total });
        await delay(1000);
        try { ({ job } = await getAudioJob(job.id));
        } catch (caught) {
          if (caught instanceof ApiError && caught.status === 404 && restarts++ < 2) ({ job } = await startAudioJob(text, activePid));
          else throw caught;
        }
      }
      if (!live()) return;
      if (job.status === 'error' || !job.url) throw new Error(job.error || 'Could not prepare audio.');
      const audio = new Audio(job.url);
      audio.onplay = () => setPlaying(true); audio.onpause = () => setPlaying(false); audio.onended = () => setPlaying(false);
      audioRef.current?.pause(); audioRef.current = audio;
      setCurrent({ id, title, narration: job.narration || text }); setPrep(null); await audio.play();
    } catch (caught) { if (live()) { setPrep(null); setError(caught instanceof Error ? caught.message : 'Could not prepare audio.'); } }
  }, [activePid, current?.id, toggle]);

  return <AudioContext.Provider value={{ playText, current, prep, playing, toggle, dismiss, error }}>{children}</AudioContext.Provider>;
}

export function useAudio() {
  const value = useContext(AudioContext);
  if (!value) throw new Error('useAudio must be used inside AudioProvider');
  return value;
}
