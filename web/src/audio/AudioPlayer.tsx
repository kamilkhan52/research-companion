import { useAudio } from './AudioProvider';

export function NowPlaying({ onOpen }: { onOpen: () => void }) {
  const { current, prep, playing, toggle, dismiss, error, position, duration } = useAudio();
  if (!current && !prep && !error) return null;
  if (prep) return <div className="now-playing"><span className="spinner" /> Preparing “{prep.title}”… {prep.total ? `${prep.done}/${prep.total}` : prep.stage}</div>;
  if (error) return <div className="now-playing"><span>{error}</span><button className="btn ghost" onClick={dismiss}>Dismiss</button></div>;
  return <div className="now-playing"><button className="btn ghost" onClick={toggle}>{playing ? 'Pause' : 'Play'}</button><button className="now-playing-title" onClick={onOpen}>{current?.title}<small>{formatTime(position)} / {formatTime(duration)}</small></button><button className="btn ghost" onClick={dismiss}>✕</button></div>;
}

export function Player() {
  const { current, prep, playing, toggle, dismiss, error, position, duration, rate, seekTo, seekBy, seekSentence, setRate } = useAudio();
  if (!current && !prep) return <div className="placeholder-view"><h2>Player</h2><p className="muted">Choose Listen on a companion response to start playback.</p>{error && <p className="build-progress-error">{error}</p>}</div>;
  return <div className="player-screen"><span className="muted">Now listening</span><h2>{current?.title || prep?.title}</h2>{prep ? <div className="lc-loading"><span className="spinner" /> Preparing audio…</div> : <>
    <input className="player-scrubber" type="range" min={0} max={duration || 1} step={0.1} value={Math.min(position, duration || 1)} onChange={(event) => seekTo(Number(event.target.value))} aria-label="Playback position" />
    <div className="player-time"><span>{formatTime(position)}</span><span>{formatTime(duration)}</span></div>
    <div className="player-controls"><button className="btn ghost" onClick={() => seekBy(-15)}>−15s</button><button className="btn ghost" onClick={() => seekSentence(-1)}>Previous sentence</button><button className="btn primary player-play" onClick={toggle}>{playing ? 'Pause' : 'Play'}</button><button className="btn ghost" onClick={() => seekSentence(1)}>Next sentence</button><button className="btn ghost" onClick={() => seekBy(15)}>+15s</button></div>
    <div className="player-options"><label>Speed <select value={rate} onChange={(event) => setRate(Number(event.target.value))}><option value={0.75}>0.75×</option><option value={1}>1×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select></label><button className="btn ghost" onClick={dismiss}>Dismiss</button></div>
    <article className="notes-body">{current?.narration}</article></>}</div>;
}

function formatTime(seconds: number) { if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'; const minutes = Math.floor(seconds / 60); return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
