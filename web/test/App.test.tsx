import { render, screen } from '@testing-library/react';
import { App } from '@/App';
import { vi, afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('App', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('renders the top bar title', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(screen.getByText('Research Companion')).toBeInTheDocument();
  });

  it('shows loading state on library view', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(screen.getByText(/loading library/i)).toBeInTheDocument();
  });

  it('navigates to graph view via hash', () => {
    window.location.hash = '#graph';
    render(<App />);
    expect(screen.getByText('Reference Graph')).toBeInTheDocument();
  });

  it('shows back button on non-library views', () => {
    window.location.hash = '#graph';
    render(<App />);
    expect(screen.getByLabelText('Back')).toBeInTheDocument();
  });

  it('hides back button on library view', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(screen.queryByLabelText('Back')).not.toBeInTheDocument();
  });

  it('shows settings gear icon', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(screen.getByLabelText('Settings')).toBeInTheDocument();
  });
});
