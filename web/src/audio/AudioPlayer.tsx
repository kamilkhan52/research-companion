import { useAudio } from './AudioProvider';

export function NowPlaying({ onOpen }: { onOpen: () => void }) {
  const { current, prep, playing, toggle, dismiss, error } = useAudio();
  if (!current && !prep && !error) return null;
  if (prep) return <div className="now-playing"><span className="spinner" /> Preparing “{prep.title}”… {prep.total ? `${prep.done}/${prep.total}` : prep.stage}</div>;
  if (error) return <div className="now-playing"><span>{error}</span><button className="btn ghost" onClick={dismiss}>Dismiss</button></div>;
  return <div className="now-playing"><button className="btn ghost" onClick={toggle}>{playing ? 'Pause' : 'Play'}</button><button className="now-playing-title" onClick={onOpen}>{current?.title}</button><button className="btn ghost" onClick={dismiss}>✕</button></div>;
}

export function Player() {
  const { current, prep, playing, toggle, dismiss, error } = useAudio();
  if (!current && !prep) return <div className="placeholder-view"><h2>Player</h2><p className="muted">Choose Listen on a companion response to start playback.</p>{error && <p className="build-progress-error">{error}</p>}</div>;
  return <div className="player-screen"><h2>{current?.title || prep?.title}</h2>{prep ? <div className="lc-loading"><span className="spinner" /> Preparing audio…</div> : <><button className="btn primary" onClick={toggle}>{playing ? 'Pause' : 'Play'}</button><button className="btn ghost" onClick={dismiss}>Dismiss</button><article className="notes-body">{current?.narration}</article></>}</div>;
}
