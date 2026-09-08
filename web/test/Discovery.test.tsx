import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Discovery } from '@/components/Discovery';

const active = vi.hoisted(() => ({ pid: 'project-1' as string | null }));
const api = vi.hoisted(() => ({
  addPaper: vi.fn(), getDiscovery: vi.fn(), startDiscovery: vi.fn(),
  cancelDiscovery: vi.fn(), hideSuggestion: vi.fn(), unhideSuggestion: vi.fn(),
}));

vi.mock('@/hooks/useLibrary', () => ({
  useActivePid: () => [active.pid, vi.fn()],
  useLibrary: () => ({ refetch: vi.fn() }),
  useProjectMembership: () => ({ isInProject: () => false }),
}));
vi.mock('@/api/endpoints', () => api);

beforeEach(() => {
  active.pid = 'project-1';
  vi.clearAllMocks();
  localStorage.clear();
  api.getDiscovery.mockResolvedValue({
    goals: 'Learn retrieval', job: null,
    result: { goals: 'Learn retrieval', suggestions: [{
      title: 'Paper One', authors: ['Ada'], year: 2025, arxiv_id: '2501.00001',
      relevance_score: 0.9, citation_count: 3, abstract: 'A useful paper.',
    }] },
  });
});

describe('Discovery', () => {
  it('shows persisted suggestions on re-entry and adds a selected paper', async () => {
    const user = userEvent.setup();
    render(<Discovery onNavigate={vi.fn()} />);
    await screen.findByText('Paper One');
    await user.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => expect(api.addPaper).toHaveBeenCalledWith(
      'project-1', 'Paper One', '2501.00001', 'A useful paper.', 2025,
    ));
  });

  it('starts the background discovery job with trimmed goals', async () => {
    api.getDiscovery.mockResolvedValue({ goals: '', job: null, result: null });
    api.startDiscovery.mockResolvedValue({ job: { status: 'running', phase: 'queries', error: null } });
    const user = userEvent.setup();
    render(<Discovery onNavigate={vi.fn()} />);
    const input = await screen.findByPlaceholderText(/what do you want|transformer attention/i);
    await user.type(input, '  learn agents  ');
    await user.click(screen.getByRole('button', { name: 'Start discovery' }));
    expect(api.startDiscovery).toHaveBeenCalledWith('project-1', 'learn agents');
  });
});

describe('Discovery run control', () => {
  const running = { status: 'running' as const, phase: 'ranking', error: null };

  beforeEach(() => {
    api.getDiscovery.mockResolvedValue({ goals: '', job: running, result: null });
    api.cancelDiscovery.mockResolvedValue({
      job: { status: 'cancelled', phase: 'ranking', error: null },
    });
  });

  it('can stop a run that is spending money', async () => {
    // A discovery run is minutes of paid model work; before this there was no way to end one.
    const user = userEvent.setup();
    render(<Discovery onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    expect(api.cancelDiscovery).toHaveBeenCalledWith('project-1');
    expect(await screen.findByText(/Discovery stopped/)).toBeInTheDocument();
  });

  it('says stopping until the worker reaches a stage boundary', async () => {
    const user = userEvent.setup();
    api.cancelDiscovery.mockReturnValue(new Promise(() => {}));
    render(<Discovery onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    // Cooperative: the thread cannot be killed, so claiming it has stopped would be a lie.
    expect(await screen.findByRole('button', { name: 'Stopping…' })).toBeDisabled();
  });

  it('stops polling once the run is cancelled, and does not offer Stop again', async () => {
    api.getDiscovery.mockResolvedValue({
      goals: '', job: { status: 'cancelled', phase: 'ranking', error: null }, result: null,
    });
    render(<Discovery onNavigate={vi.fn()} />);

    await screen.findByText(/Discovery stopped/);
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    const polls = api.getDiscovery.mock.calls.length;
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    expect(api.getDiscovery).toHaveBeenCalledTimes(polls);
  });

  it('reports a refused stop and lets the reader try again', async () => {
    const user = userEvent.setup();
    api.cancelDiscovery.mockRejectedValue(new Error('No discovery run to stop'));
    render(<Discovery onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    expect(await screen.findByText('No discovery run to stop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });
});

describe('Discovery hidden recommendations', () => {
  const suggestion = {
    title: 'Paper One', authors: ['Ada'], year: 2025, arxiv_id: '2501.00001',
    relevance_score: 0.9, citation_count: 3, abstract: 'A useful paper.',
  };
  const entry = { keys: ['arxiv:2501.00001'], title: 'Paper One', hidden_at: '2026-09-08T00:00:00Z' };

  it('sends the suggestion as rendered, so the server can derive every identity', async () => {
    const user = userEvent.setup();
    api.hideSuggestion.mockResolvedValue({ hidden: entry });
    render(<Discovery onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /stop recommending paper one/i }));

    expect(api.hideSuggestion).toHaveBeenCalledWith('project-1', suggestion);
    await waitFor(() => expect(screen.queryByText('Paper One')).not.toBeInTheDocument());
  });

  it('puts the card back when the server refuses the hide', async () => {
    // Optimistic removal would otherwise read as success for a write that did not happen.
    const user = userEvent.setup();
    api.hideSuggestion.mockRejectedValue(new Error('This paper has no usable identity to hide it by.'));
    render(<Discovery onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /stop recommending paper one/i }));

    expect(await screen.findByText(/no usable identity/)).toBeInTheDocument();
    expect(await screen.findByText('Paper One')).toBeInTheDocument();
  });

  it('undoes a hide by its identity keys, with no re-run', async () => {
    const user = userEvent.setup();
    api.getDiscovery.mockResolvedValue({
      goals: '', job: null, result: { goals: '', suggestions: [] }, hidden: [entry],
    });
    api.unhideSuggestion.mockResolvedValue({ removed: true });
    render(<Discovery onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /1 you told Discover to skip/ }));
    await user.click(screen.getByRole('button', { name: /recommend Paper One again/i }));

    expect(api.unhideSuggestion).toHaveBeenCalledWith('project-1', ['arxiv:2501.00001']);
    // The stored result keeps every suggestion, so a reload is enough — no discovery job.
    expect(api.startDiscovery).not.toHaveBeenCalled();
  });

  it('says nothing about hidden papers when there are none', async () => {
    render(<Discovery onNavigate={vi.fn()} />);
    await screen.findByText('Paper One');
    expect(screen.queryByText(/told Discover to skip/)).not.toBeInTheDocument();
  });
});
