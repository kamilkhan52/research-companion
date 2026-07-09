import { useState, useCallback, useEffect } from 'react';
import { Library } from '@/components/Library';
import { Graph } from '@/components/Graph';
import { Discussion } from '@/components/Discussion';
import { Discovery } from '@/components/Discovery';
import { Notes } from '@/components/Notes';

type View = 'library' | 'graph' | 'discover' | 'notes' | 'player' | 'settings' | 'paper';

interface Route {
  view: View;
  param?: string;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return { view: 'library' };
  if (raw === 'graph') return { view: 'graph' };
  if (raw === 'discover') return { view: 'discover' };
  if (raw === 'player') return { view: 'player' };
  if (raw === 'settings') return { view: 'settings' };
  if (raw.startsWith('notes/')) return { view: 'notes', param: raw.slice(6) };
  if (raw.startsWith('paper/')) return { view: 'paper', param: raw.slice(6) };
  return { view: 'library' };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash;
  }, []);

  return (
    <>
      <TopBar
        title="Research Companion"
        showBack={route.view !== 'library'}
        onBack={() => navigate('library')}
        onSettings={() => navigate('settings')}
      />
      <main className="app-main">
        <ViewRouter route={route} navigate={navigate} />
      </main>
    </>
  );
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
      return <Discussion slug={route.param ?? ''} onNavigate={navigate} />;
    case 'discover':
      return <Discovery onNavigate={navigate} />;
    case 'notes':
      return <Notes target={route.param ?? 'working'} />;
    case 'player':
      return (
        <div className="placeholder-view">
          <h2>Player</h2>
          <p className="muted">Coming in Phase 6.</p>
        </div>
      );
    case 'settings':
      return (
        <div className="placeholder-view">
          <h2>Settings</h2>
          <p className="muted">Coming in Phase 6.</p>
        </div>
      );
    default:
      return null;
  }
}
