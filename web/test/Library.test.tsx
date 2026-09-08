import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Library } from '@/components/Library';
import { LibraryProvider } from '@/hooks/useLibrary';
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

function renderLibrary(onNavigate = vi.fn()) {
  return render(<LibraryProvider><Library onNavigate={onNavigate} /></LibraryProvider>);
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('Library', () => {
  it('shows loading spinner initially', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    renderLibrary();
    expect(screen.getByText(/loading library/i)).toBeInTheDocument();
  });

  it('renders project selector with projects', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('My Research (1/3)')).toBeInTheDocument();
    });
  });

  it('renders the flat mobile-parity paper list', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    renderLibrary();

    expect(await screen.findByText('Attention Is All You Need')).toBeInTheDocument();
    expect(screen.getByText('Language Models are Few-Shot Learners')).toBeInTheDocument();
    expect(screen.getByText('BERT: Pre-training of Deep Bidirectional Transformers')).toBeInTheDocument();
    expect(screen.queryByText('TRANSFORMERS')).not.toBeInTheDocument();
  });

  it('shows status badges with correct labels', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    renderLibrary();

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

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('Start this project')).toBeInTheDocument();
    });
  });

  it('shows error message and retry button on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
    renderLibrary();

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
    renderLibrary();

    await waitFor(() => {
      expect(screen.getByLabelText('New project')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('New project'));

    expect(screen.getByPlaceholderText('Project name…')).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('clears error on refetch and recovers', async () => {
    // First call fails
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const user = userEvent.setup();
    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });

    // Retry should clear error and show projects
    await user.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(screen.getByText('My Research (1/3)')).toBeInTheDocument();
    });
  });

  it('recovers from project switch after 404', async () => {
    // Projects load fine, state returns 404 for first project, switch to other project
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockRejectedValueOnce(new Error('Request failed (404)'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const user = userEvent.setup();
    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('Request failed (404)')).toBeInTheDocument();
    });

    // Switch to other project — project bar is visible in error state
    const select = screen.getByLabelText('Active project');
    await user.selectOptions(select, 'proj-2');

    await waitFor(() => {
      expect(screen.getByText('Physics (0/2)')).toBeInTheDocument();
    });
    expect(screen.queryByText('Request failed (404)')).not.toBeInTheDocument();
  });

  it('navigates on paper click', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projects: mockProjects }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockState) } as Response);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderLibrary(onNavigate);

    await waitFor(() => {
      expect(screen.getByText('Attention Is All You Need')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Attention Is All You Need'));
    expect(onNavigate).toHaveBeenCalledWith('paper/attention-is-all-you-need');
  });
});

describe('Library add-a-paper', () => {
  const json = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

  /** Route by URL rather than call order: the Library also fetches recent sessions, and an
   *  order-based mock silently hands one endpoint another's body when that timing shifts. */
  function routedFetch(routes: { state?: unknown; addPaper?: () => Promise<Response> } = {}) {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.endsWith('/api/projects')) return Promise.resolve(json({ projects: mockProjects }));
      if (url.includes('/state')) return Promise.resolve(json(routes.state ?? mockState));
      if (url.includes('/recent-sessions')) return Promise.resolve(json({ sessions: [] }));
      if (url.endsWith('/papers')) {
        return routes.addPaper ? routes.addPaper() : Promise.resolve(json({ paper: { slug: 'added' } }));
      }
      return Promise.resolve(json({}));
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch as unknown as typeof globalThis.fetch);
    return fetch;
  }

  it('opens the add sheet from the plus beside the active project', async () => {
    routedFetch();
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByLabelText('Add a paper'));
    expect(screen.getByRole('dialog', { name: 'Add a paper' })).toBeInTheDocument();
  });

  it('opens the added paper, carrying what to fetch', async () => {
    const fetch = routedFetch({ addPaper: () => Promise.resolve(json({ paper: { slug: 'llm-compiler' } })) });
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderLibrary(onNavigate);

    await user.click(await screen.findByLabelText('Add a paper'));
    await user.type(screen.getByLabelText(/paper title, doi, or arxiv link/i), 'arxiv.org/abs/2405.17057');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('paper/llm-compiler?source=2405.17057'));
    expect(screen.queryByRole('dialog', { name: 'Add a paper' })).not.toBeInTheDocument();
    // The list has to be refetched, or coming back from the paper shows a library without it.
    const stateReads = fetch.mock.calls.filter(([url]) => String(url).includes('/state')).length;
    expect(stateReads).toBeGreaterThan(1);
    const addCall = fetch.mock.calls.find(([url]) => String(url).endsWith('/papers'));
    expect(JSON.parse(String(addCall?.[1]?.body))).toEqual({
      title: 'arXiv 2405.17057', arxiv_id: '2405.17057',
    });
  });

  it('offers both ways in from an empty project', async () => {
    routedFetch({ state: { ...mockState, papers: [] } });
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderLibrary(onNavigate);

    const empty = await screen.findByText('Start this project');
    const actions = within(empty.parentElement as HTMLElement);
    await user.click(actions.getByRole('button', { name: 'Add a paper' }));
    expect(screen.getByRole('dialog', { name: 'Add a paper' })).toBeInTheDocument();

    const sheet = within(screen.getByRole('dialog', { name: 'Add a paper' }));
    await user.click(sheet.getByRole('button', { name: /explore with discover/i }));
    expect(onNavigate).toHaveBeenCalledWith('discover');
  });

  it('refreshes the list on the way out to Discover, not only on the hand-off', async () => {
    // An add can land after the reader has left for Discover. Nothing else reloads the list,
    // so Discover would offer to add a paper that is already on it.
    const fetch = routedFetch();
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByLabelText('Add a paper'));
    const reads = fetch.mock.calls.filter(([url]) => String(url).includes('/state')).length;
    await user.click(within(screen.getByRole('dialog', { name: 'Add a paper' }))
      .getByRole('button', { name: /explore with discover/i }));

    await waitFor(() => expect(
      fetch.mock.calls.filter(([url]) => String(url).includes('/state')).length,
    ).toBeGreaterThan(reads));
  });
});
