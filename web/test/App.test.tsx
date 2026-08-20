import { render, screen } from '@testing-library/react';
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

  it('shows settings gear icon', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(await screen.findByLabelText('Settings')).toBeInTheDocument();
  });
});
