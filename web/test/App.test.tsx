import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { vi, afterEach } from 'vitest';

vi.mock('@/components/AuthGate', async () => {
  const { useEffect } = await import('react');
  return { AuthGate: ({ onAuthenticated }: { onAuthenticated: () => void }) => {
    useEffect(() => onAuthenticated(), [onAuthenticated]);
    return null;
  } };
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('App', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('renders the top bar title', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(await screen.findByText('Seminar')).toBeInTheDocument();
  });

  it('shows loading state on library view', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(await screen.findByText(/loading library/i)).toBeInTheDocument();
  });

  it('navigates to graph view via hash', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    window.location.hash = '#graph';
    render(<App />);
    expect(await screen.findByText(/no reference graph/i)).toBeInTheDocument();
  });

  it('shows back button on non-library views', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    window.location.hash = '#graph';
    render(<App />);
    expect(await screen.findByLabelText('Back')).toBeInTheDocument();
  });

  it('hides back button on library view', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<App />);
    await screen.findByText('Seminar');
    expect(screen.queryByLabelText('Back')).not.toBeInTheDocument();
  });

  it('routes a paper-graph hash to the reference map, not to the library', async () => {
    // `paper-graph/` and `paper/` share a prefix in the eye but not in the parser; a fall-through
    // here would silently land the reader on the library with no sign anything went wrong.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    window.location.hash = '#paper-graph/attention';
    render(<App />);

    expect(await screen.findByText(/No reference map for this paper yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/loading library/i)).not.toBeInTheDocument();
  });

  it('comes back to the reference map after Settings, not to the library', async () => {
    // `routeHash` has a case per view. Without the paper-graph one it falls through to the bare
    // view name, `parseHash` no longer matches, and closing Settings drops the reader in the
    // Library with the slug gone — a path no other test walks.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    window.location.hash = '#paper-graph/llm-compiler';
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/No reference map for this paper yet/i);

    await user.click(screen.getByLabelText('Settings'));
    await user.click(await screen.findByLabelText('Close'));

    expect(window.location.hash).toBe('#paper-graph/llm-compiler');
  });

  it('shows settings gear icon', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(await screen.findByLabelText('Settings')).toBeInTheDocument();
  });
});
