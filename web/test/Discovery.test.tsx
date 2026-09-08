import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Discovery, suggestionKey } from '@/components/Discovery';

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

  it('does not claim the stopped run found what an EARLIER run found', async () => {
    // `GET /discover` returns the last COMPLETED run's persisted result. After stopping a second
    // run, those papers are a different run's, and attributing them here would be unverifiable.
    api.getDiscovery.mockResolvedValue({
      goals: '', job: { status: 'cancelled', phase: 'ranking', error: null },
      result: { goals: 'older run', suggestions: [{
        title: 'Paper One', authors: ['Ada'], year: 2025, arxiv_id: '2501.00001',
        relevance_score: 0.9, citation_count: 3, abstract: 'A useful paper.',
      }] },
    });
    render(<Discovery onNavigate={vi.fn()} />);

    await screen.findByText(/Discovery stopped/);
    expect(screen.queryByText(/already found is below/)).not.toBeInTheDocument();
    expect(screen.queryByText(/What this run reached/)).not.toBeInTheDocument();
  });

  it('shows what the stopped run itself had reached', async () => {
    api.getDiscovery.mockResolvedValue({
      goals: '', result: null,
      job: {
        status: 'cancelled', phase: 'triage', error: null, finds_stage: 'grounded',
        finds: [{
          title: 'A Partial Find', year: 2024, citation_count: 7,
          channels: ['cites'], reason: 'Cited by two papers you have read', provisional: true,
        }],
      },
    });
    render(<Discovery onNavigate={vi.fn()} />);

    expect(await screen.findByText('A Partial Find')).toBeInTheDocument();
    expect(screen.getByText('Cited by two papers you have read')).toBeInTheDocument();
    // Finds carry no arXiv id, so adding one would retrieve the wrong paper.
    expect(screen.queryByRole('button', { name: '+ Add' })).not.toBeInTheDocument();
  });

  it('shows finds while the run is still going, and says they are provisional', async () => {
    api.getDiscovery.mockResolvedValue({
      goals: '', result: null,
      job: {
        status: 'running', phase: 'triage', error: null, finds_stage: 'grounded',
        finds: [{ title: 'An Early Find', year: null, citation_count: null, channels: [], reason: '', provisional: true }],
      },
    });
    render(<Discovery onNavigate={vi.fn()} />);

    expect(await screen.findByText('An Early Find')).toBeInTheDocument();
    expect(screen.getByText(/before anything judged them/)).toBeInTheDocument();
  });

  it('says ranked finds are ranked, not provisional', async () => {
    api.getDiscovery.mockResolvedValue({
      goals: '', result: null,
      job: {
        status: 'cancelled', phase: 'scoring', error: null, finds_stage: 'ranked',
        finds: [{ title: 'A Ranked Find', year: 2024, citation_count: 1, channels: [], reason: '', provisional: false }],
      },
    });
    render(<Discovery onNavigate={vi.fn()} />);

    await screen.findByText('A Ranked Find');
    expect(screen.getByText(/Ranked, but this run did not finish/)).toBeInTheDocument();
  });

  it('disables the stop button while the first cancel is in flight', async () => {
    // The disabled attribute is the whole protection: stopDiscovery's own `stopping` check
    // reads the render closure, so it cannot catch a double-click either. Assert the thing
    // that actually holds rather than the thing that looks like it does.
    const user = userEvent.setup();
    api.cancelDiscovery.mockReturnValue(new Promise(() => {}));
    render(<Discovery onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    expect(await screen.findByRole('button', { name: 'Stopping…' })).toBeDisabled();
    expect(api.cancelDiscovery).toHaveBeenCalledTimes(1);
  });

  it('offers a usable Stop on a new run after the last one was stopped', async () => {
    const user = userEvent.setup();
    // `stopping` is never reset on a successful stop, so it is genuinely still true here —
    // otherwise the reset under test would be a no-op and the assertion would prove nothing.
    api.startDiscovery.mockResolvedValue({ job: running });
    render(<Discovery onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    await screen.findByText(/Discovery stopped/);

    await user.type(screen.getByPlaceholderText(/transformer attention/i), 'new goals');
    await user.click(screen.getByRole('button', { name: 'Start discovery' }));

    // Without the reset the new run's button comes up already saying "Stopping…", and disabled.
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('does not write a stopped job onto a project the reader switched to', async () => {
    const user = userEvent.setup();
    let settle!: (value: unknown) => void;
    api.cancelDiscovery.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    const { rerender } = render(<Discovery onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    // The reader switches projects while the cancel is still in flight.
    active.pid = 'project-2';
    api.getDiscovery.mockResolvedValue({ goals: '', job: null, result: null });
    rerender(<Discovery onNavigate={vi.fn()} />);
    settle({ job: { status: 'cancelled', phase: 'ranking', error: null } });

    await waitFor(() => expect(api.getDiscovery).toHaveBeenCalledWith('project-2'));
    // project-1's cancelled snapshot must not describe project-2's screen.
    expect(screen.queryByText(/Discovery stopped/)).not.toBeInTheDocument();
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

describe('suggestionKey', () => {
  const suggestion = {
    title: 'Paper One', authors: ['Ada'], year: 2025, arxiv_id: '2501.00001',
    relevance_score: 0.9, citation_count: 3, abstract: 'A useful paper.',
  };

  it('is stable across the fresh objects every poll builds', () => {
    // This is what makes removing a hidden card survive a response landing mid-interaction;
    // an identity comparison silently matches nothing once the array has been replaced.
    expect(suggestionKey({ ...suggestion })).toBe(suggestionKey(suggestion));
  });

  it('prefers the arXiv id, and falls back to the title when there is none', () => {
    expect(suggestionKey(suggestion)).toBe('2501.00001');
    expect(suggestionKey({ ...suggestion, arxiv_id: '' })).toBe('Paper One');
  });
});
