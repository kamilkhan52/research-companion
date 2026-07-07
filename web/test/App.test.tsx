import { render, screen } from '@testing-library/react';
import { App } from '@/App';

describe('App', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('renders the top bar title', () => {
    render(<App />);
    expect(screen.getByText('Research Companion')).toBeInTheDocument();
  });

  it('renders the library placeholder by default', () => {
    render(<App />);
    expect(screen.getByText('Library')).toBeInTheDocument();
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
    render(<App />);
    expect(screen.queryByLabelText('Back')).not.toBeInTheDocument();
  });

  it('shows settings gear icon', () => {
    render(<App />);
    expect(screen.getByLabelText('Settings')).toBeInTheDocument();
  });
});
