import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Library } from '@/components/Library';
import { afterEach, vi } from 'vitest';

const mockProjects = [
  { id: 'proj-1', name: 'My Research', paper_count: 3, read_count: 1, created_at: null },
  { id: 'proj-2', name: 'Physics', paper_count: 2, read_count: 0, created_at: null },
];

const mockState = {
  project: { id: 'proj-1', name: 'My Research' },
  has_key: true,
  model: 'anthropic/claude-opus-4.6',
  narration_model: null,
  speech_provider: null,
  has_openai_key: false,
  papers: [
    { slug: 'attention-is-all-you-need', title: 'Attention Is All You Need', group: 'Transformers',
      list_status: 'read' as const, cites: [], retrieved: true, has_notes: true,
      session_state: 'committed' as const },
    { slug: 'gpt3', title: 'Language Models are Few-Shot Learners', group: 'Transformers',
      list_status: 'unread' as const, cites: [], retrieved: true, has_notes: false,
      session_state: 'in_discussion' as const },
    { slug: 'bert', title: 'BERT: Pre-training of Deep Bidirectional Transformers',
      group: 'Pretraining', list_status: 'unread' as const, cites: [], retrieved: false,
      has_notes: false, session_state: null },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('Library', () => {
  it('shows loading spinner initially', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<Library onNavigate={vi.fn()} />);
    expect(screen.getByText(/loading library/i)).toBeInTheDocument();
  });

  it('renders project selector with projects', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    render(<Library onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('My Research (1/3)')).toBeInTheDocument();
    });
  });

  it('renders paper cards grouped by group', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    render(<Library onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('TRANSFORMERS')).toBeInTheDocument();
      expect(screen.getByText('PRETRAINING')).toBeInTheDocument();
    });

    expect(screen.getByText('Attention Is All You Need')).toBeInTheDocument();
    expect(screen.getByText('Language Models are Few-Shot Learners')).toBeInTheDocument();
    expect(screen.getByText('BERT: Pre-training of Deep Bidirectional Transformers')).toBeInTheDocument();
  });

  it('shows status badges with correct labels', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    render(<Library onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Read')).toBeInTheDocument();
      expect(screen.getByText('Discussing')).toBeInTheDocument();
      expect(screen.getByText('Unread')).toBeInTheDocument();
    });
  });

  it('shows empty state when no papers', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ ...mockState, papers: [] }),
      } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    render(<Library onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Start this project')).toBeInTheDocument();
    });
  });

  it('shows error message and retry button on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
    render(<Library onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });
  });

  it('shows new project form when + New is clicked', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const user = userEvent.setup();
    render(<Library onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText('New project')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('New project'));

    expect(screen.getByPlaceholderText('Project name…')).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('navigates on paper click', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<Library onNavigate={onNavigate} />);

    await waitFor(() => {
      expect(screen.getByText('Attention Is All You Need')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Attention Is All You Need'));
    expect(onNavigate).toHaveBeenCalledWith('paper/attention-is-all-you-need');
  });
});
