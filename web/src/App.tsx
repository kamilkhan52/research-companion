import { useState, useCallback, useEffect, useRef } from 'react';
import { Library } from '@/components/Library';
import { Graph } from '@/components/Graph';
import { Discussion } from '@/components/Discussion';
import { Discovery } from '@/components/Discovery';
import { Notes } from '@/components/Notes';
import { Settings } from '@/components/Settings';
import { AudioProvider } from '@/audio/AudioProvider';
import { NowPlaying, Player } from '@/audio/AudioPlayer';
import { AuthGate } from '@/components/AuthGate';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LibraryProvider } from '@/hooks/useLibrary';
import { paperHash, splitRouteQuery } from '@/routes';

type View = 'library' | 'graph' | 'discover' | 'notes' | 'player' | 'settings' | 'paper';

interface Route {
  view: View;
  param?: string;
  /** `paper` only: the arXiv id or PDF link an add carried, so the reading screen can fetch
   *  exactly what the reader named rather than asking for it again. */
  source?: string;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return { view: 'library' };
  if (raw === 'graph') return { view: 'graph' };
  if (raw === 'discover') return { view: 'discover' };
  if (raw === 'player') return { view: 'player' };
  if (raw === 'settings') return { view: 'settings' };
  if (raw.startsWith('notes/')) return { view: 'notes', param: decodeRouteParam(raw.slice(6)) };
  if (raw.startsWith('paper/')) {
    const { path, query } = splitRouteQuery(raw.slice(6));
    return { view: 'paper', param: decodeRouteParam(path), source: query.get('source') || undefined };
  }
  return { view: 'library' };
}

function decodeRouteParam(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function routeHash(route: Route): string {
  if (route.view === 'paper') return paperHash(route.param ?? '', route.source);
  if (route.view === 'notes') return `notes/${encodeURIComponent(route.param ?? '')}`;
  return route.view === 'library' ? 'library' : route.view;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [authenticated, setAuthenticated] = useState(false);
  const lastContentRoute = useRef<Route>(route.view === 'settings' ? { view: 'library' } : route);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    // Remember where to come back to, but not the one-shot source: by the time Settings closes
    // the reading screen has already consumed it, and re-adding it would re-arm its fetch.
    if (route.view !== 'settings') lastContentRoute.current = { ...route, source: undefined };
  }, [route]);

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash;
  }, []);

  useEffect(() => {
    const regate = () => setAuthenticated(false);
    window.addEventListener('rc:auth-required', regate);
    return () => window.removeEventListener('rc:auth-required', regate);
  }, []);

  if (!authenticated) return <div className="auth-container"><AuthGate onAuthenticated={() => setAuthenticated(true)} /></div>;

  const contentRoute = route.view === 'settings' ? lastContentRoute.current : route;
  return <ErrorBoundary><LibraryProvider><AudioProvider>
    <>
      <TopBar
        title="Seminar"
        showBack={route.view !== 'library' && route.view !== 'settings'}
        onBack={() => navigate('library')}
        onSettings={() => navigate('settings')}
      />
      <PrimaryNav route={contentRoute} navigate={navigate} />
      <main className="app-main">
        <ViewRouter route={contentRoute} navigate={navigate} />
      </main>
      {route.view === 'settings' && <Settings onClose={() => navigate(routeHash(lastContentRoute.current))} />}
      <NowPlaying onOpen={() => navigate('player')} />
    </>
  </AudioProvider></LibraryProvider></ErrorBoundary>;
}

function PrimaryNav({ route, navigate }: { route: Route; navigate: (hash: string) => void }) {
  const items: { view: View; label: string; hash: string }[] = [
    { view: 'library', label: 'Library', hash: 'library' },
    { view: 'discover', label: 'Discover', hash: 'discover' },
    { view: 'notes', label: 'Notes', hash: 'notes/working' },
    { view: 'graph', label: 'Map', hash: 'graph' },
  ];
  return <nav className="primary-nav" aria-label="Primary">
    {items.map((item) => <button key={item.view} className={route.view === item.view ? 'active' : ''}
      aria-current={route.view === item.view ? 'page' : undefined} onClick={() => navigate(item.hash)}>{item.label}</button>)}
  </nav>;
}

function TopBar({
  title,
  showBack,
  onBack,
  onSettings,
}: {
  title: string;
  showBack: boolean;
  onBack: () => void;
  onSettings: () => void;
}) {
  return (
    <header className="topbar">
      {showBack ? (
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          ‹
        </button>
      ) : (
        <div className="icon-btn-placeholder" />
      )}
      <h1 className="topbar-title">{title}</h1>
      <button className="icon-btn" onClick={onSettings} aria-label="Settings">
        ⚙
      </button>
    </header>
  );
}

function ViewRouter({
  route,
  navigate,
}: {
  route: Route;
  navigate: (hash: string) => void;
}) {
  switch (route.view) {
    case 'library':
      return <Library onNavigate={navigate} />;
    case 'graph':
      return <Graph onNavigate={navigate} />;
    case 'paper':
      return <Discussion slug={route.param ?? ''} source={route.source} onNavigate={navigate} />;
    case 'discover':
      return <Discovery onNavigate={navigate} />;
    case 'notes':
      return <Notes target={route.param ?? 'working'} onNavigate={navigate} />;
    case 'player':
      return <Player />;
    case 'settings':
      return null;
    default:
      return null;
  }
}
