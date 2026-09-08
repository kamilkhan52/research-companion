import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Discussion } from '@/components/Discussion';

const active = vi.hoisted(() => ({ pid: 'project-1' as string | null }));
const api = vi.hoisted(() => ({
  approve: vi.fn(), continueJob: vi.fn(), finishJob: vi.fn(), getActiveChatJob: vi.fn(),
  getChatJob: vi.fn(), getLatestRetrievalJob: vi.fn(), getOpeningDraft: vi.fn(),
  getFavoriteModels: vi.fn(), getRelated: vi.fn(), cancelChatJob: vi.fn(),
  getRetrievalJob: vi.fn(), getReview: vi.fn(), getSession: vi.fn(), reopen: vi.fn(),
  continueDiscussion: vi.fn(), setSessionMode: vi.fn(),
  replyJob: vi.fn(), requestChangesJob: vi.fn(), retryJob: vi.fn(), startJob: vi.fn(),
  startRetrievalJob: vi.fn(), updatePaper: vi.fn(),
}));

vi.mock('@/hooks/useLibrary', () => ({
  useActivePid: () => [active.pid, vi.fn()],
  useProjectDefaults: () => ({ model: 'model/test', narrationModel: '' }),
  usePaperIndex: () => [],
}));
vi.mock('@/api/endpoints', () => api);
vi.mock('@/audio/AudioProvider', () => ({ useAudio: () => ({ playText: vi.fn() }) }));

function session(slug: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    paper: { slug, title, retrieved: true, list_status: 'unread' },
    state: null,
    transcript: [],
    model: 'model/test',
    ...overrides,
  };
}

beforeEach(() => {
  active.pid = 'project-1';
  vi.clearAllMocks();
  api.getActiveChatJob.mockResolvedValue({ job: null });
  api.getLatestRetrievalJob.mockResolvedValue({ job: null });
  api.getFavoriteModels.mockResolvedValue({ models: [] });
  api.getOpeningDraft.mockImplementation((_pid: string, slug: string) => Promise.resolve({
    title: `Opening ${slug}`, prompt: `Discuss ${slug}`, model: 'model/test',
  }));
});

afterEach(() => localStorage.clear());

describe('Discussion job recovery', () => {
  it('reinitializes when navigating directly between paper slugs', async () => {
    api.getSession.mockImplementation((_pid: string, slug: string) =>
      Promise.resolve(session(slug, slug === 'paper-a' ? 'Paper A' : 'Paper B')));

    const { rerender } = render(<Discussion slug="paper-a" onNavigate={vi.fn()} />);
    await screen.findByText('Start — Opening paper-a');

    rerender(<Discussion slug="paper-b" onNavigate={vi.fn()} />);
    await screen.findByText('Start — Opening paper-b');
    expect(screen.queryByText('Start — Opening paper-a')).not.toBeInTheDocument();
  });

  it('ignores an opening draft that resolves after navigation to another paper', async () => {
    let resolveA!: (value: { title: string; prompt: string; model: string }) => void;
    api.getSession.mockImplementation((_pid: string, slug: string) =>
      Promise.resolve(session(slug, slug === 'paper-a' ? 'Paper A' : 'Paper B')));
    api.getOpeningDraft.mockImplementation((_pid: string, slug: string) => {
      if (slug === 'paper-a') return new Promise((resolve) => { resolveA = resolve; });
      return Promise.resolve({ title: 'Opening paper-b', prompt: 'Discuss paper-b', model: 'model/test' });
    });

    const { rerender } = render(<Discussion slug="paper-a" onNavigate={vi.fn()} />);
    await waitFor(() => expect(api.getOpeningDraft).toHaveBeenCalledWith('project-1', 'paper-a'));
    rerender(<Discussion slug="paper-b" onNavigate={vi.fn()} />);
    await screen.findByText('Start — Opening paper-b');
    resolveA({ title: 'Opening paper-a', prompt: 'Discuss paper-a', model: 'model/test' });

    await waitFor(() => expect(screen.queryByText('Start — Opening paper-a')).not.toBeInTheDocument());
  });

  it('closes the session/active-job race with a canonical refresh', async () => {
    api.getSession
      .mockResolvedValueOnce(session('paper-a', 'Paper A', {
        state: 'in_discussion', transcript: [{ role: 'user', text: 'Question' }],
      }))
      .mockResolvedValueOnce(session('paper-a', 'Paper A', {
        state: 'in_discussion',
        transcript: [
          { role: 'user', text: 'Question' },
          { role: 'assistant', canonical: 'Answer persisted while reconnecting.' },
        ],
      }));

    render(<Discussion slug="paper-a" onNavigate={vi.fn()} />);
    await screen.findByText('Answer persisted while reconnecting.');
    expect(screen.queryByText('No response yet.')).not.toBeInTheDocument();
    expect(api.getSession).toHaveBeenCalledTimes(2);
  });

  it('does not offer another reply while the canonical transcript ends with a user turn', async () => {
    api.getSession.mockResolvedValue(session('paper-a', 'Paper A', {
      state: 'in_discussion', transcript: [{ role: 'user', text: 'Question' }],
    }));

    render(<Discussion slug="paper-a" onNavigate={vi.fn()} />);
    await screen.findByRole('button', { name: 'Generate response' });
    expect(screen.queryByPlaceholderText('Type your reply…')).not.toBeInTheDocument();
  });

  it('starts and polls retrieval as a background job before compose', async () => {
    api.getSession.mockResolvedValue(session('paper-a', 'Paper A', {
      paper: { slug: 'paper-a', title: 'Paper A', retrieved: false, list_status: 'unread' },
    }));
    api.startRetrievalJob.mockResolvedValue({
      job: { id: 'retrieval-1', slug: 'paper-a', status: 'running', phase: 'resolving', detail: '', items: [], candidates: [], retrieved: false, error: null },
    });
    api.getRetrievalJob.mockResolvedValue({
      job: { id: 'retrieval-1', slug: 'paper-a', status: 'done', phase: 'done', detail: '', items: [], candidates: [], retrieved: true, error: null },
    });

    const user = userEvent.setup();
    render(<Discussion slug="paper-a" onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Fetch paper' }));

    await screen.findByText('Start — Opening paper-a');
    expect(api.startRetrievalJob).toHaveBeenCalledWith('project-1', 'paper-a', {
      arxiv_id: undefined, pdf_url: undefined,
    });
    await waitFor(() => expect(api.getRetrievalJob).toHaveBeenCalledWith('project-1', 'retrieval-1'));
  });
});

describe('Discussion source hand-off', () => {
  const unretrieved = () => session('paper-a', 'Paper A', {
    paper: { slug: 'paper-a', title: 'Paper A', retrieved: false, list_status: 'unread' },
  });
  const running = {
    id: 'retrieval-1', slug: 'paper-a', status: 'running', phase: 'resolving', detail: '',
    items: [], candidates: [], retrieved: false, error: null,
  };

  beforeEach(() => {
    api.getSession.mockResolvedValue(unretrieved());
    api.startRetrievalJob.mockResolvedValue({ job: running });
    api.getRetrievalJob.mockResolvedValue({
      job: { ...running, status: 'done', phase: 'done', retrieved: true },
    });
  });

  it('fetches the arXiv id the reader named, without asking for it again', async () => {
    render(<Discussion slug="paper-a" source="2309.06180" onNavigate={vi.fn()} />);

    await waitFor(() => expect(api.startRetrievalJob).toHaveBeenCalledWith('project-1', 'paper-a', {
      arxiv_id: '2309.06180', pdf_url: undefined,
    }));
  });

  it('fetches a direct PDF link the same way, and prefills its field', async () => {
    // A direct link is the input most likely to fail, so its retry field matters most.
    api.getRetrievalJob.mockResolvedValue({ job: running });
    render(<Discussion slug="paper-a" source="https://example.org/p.pdf" onNavigate={vi.fn()} />);

    await waitFor(() => expect(api.startRetrievalJob).toHaveBeenCalledWith('project-1', 'paper-a', {
      arxiv_id: undefined, pdf_url: 'https://example.org/p.pdf',
    }));
    expect(await screen.findByDisplayValue('https://example.org/p.pdf')).toBeInTheDocument();
  });

  it('spends the source once, so a reload cannot re-run the fetch', async () => {
    window.location.hash = 'paper/paper-a?source=2309.06180';
    render(<Discussion slug="paper-a" source="2309.06180" onNavigate={vi.fn()} />);

    await waitFor(() => expect(api.startRetrievalJob).toHaveBeenCalled());
    // The guard against a second fetch is in-process server memory that a restart clears; a
    // source left in the address bar would re-arm the paid fetch on every reload of this tab.
    expect(window.location.hash).toBe('#paper/paper-a');
  });

  it('leaves a failed fetch to the reader, with the source still in the form', async () => {
    api.getLatestRetrievalJob.mockResolvedValue({
      job: { ...running, status: 'error', phase: 'resolving', error: 'No PDF found for 2309.06180.' },
    });

    render(<Discussion slug="paper-a" source="2309.06180" onNavigate={vi.fn()} />);

    expect(await screen.findByText('No PDF found for 2309.06180.')).toBeInTheDocument();
    // The prefill is what makes "try again" one click rather than a re-paste.
    expect(screen.getByDisplayValue('2309.06180')).toBeInTheDocument();
    expect(api.startRetrievalJob).not.toHaveBeenCalled();
  });

  it('waits for the button when the route names no concrete source', async () => {
    render(<Discussion slug="paper-a" source="Attention Is All You Need" onNavigate={vi.fn()} />);

    await screen.findByRole('button', { name: 'Fetch paper' });
    expect(api.startRetrievalJob).not.toHaveBeenCalled();
  });

  it('does not carry one paper\'s source into the next paper\'s fetch form', async () => {
    api.getSession.mockImplementation((_pid: string, slug: string) => Promise.resolve(
      session(slug, slug, { paper: { slug, title: slug, retrieved: false, list_status: 'unread' } }),
    ));
    // Keep both papers on the fetch screen: a resolved retrieval would move paper-a to compose
    // and the assertion would pass for the wrong reason.
    api.getRetrievalJob.mockResolvedValue({ job: running });

    const { rerender } = render(<Discussion slug="paper-a" source="2309.06180" onNavigate={vi.fn()} />);
    await screen.findByDisplayValue('2309.06180');

    rerender(<Discussion slug="paper-b" onNavigate={vi.fn()} />);
    // Wait for paper-b's own fetch screen. The component passes through a form-less view while
    // it re-initializes, and asserting during that gap would pass however stale the field is.
    await screen.findByRole('heading', { name: 'paper-b' });
    expect(screen.queryByDisplayValue('2309.06180')).not.toBeInTheDocument();
  });
});

describe('Discussion source-title offer', () => {
  const paper = (overrides: Record<string, unknown> = {}) => ({
    slug: 'arxiv-2405-17057', title: 'arXiv 2405.17057', retrieved: false,
    list_status: 'unread', ...overrides,
  });
  const retrieved = {
    id: 'retrieval-1', slug: 'arxiv-2405-17057', status: 'done', phase: 'done', detail: '',
    items: [], candidates: [], retrieved: true, error: null, matched_title: 'The LLM Compiler',
  };

  beforeEach(() => {
    api.getSession.mockResolvedValue(session('arxiv-2405-17057', 'arXiv 2405.17057', { paper: paper() }));
    api.startRetrievalJob.mockResolvedValue({
      job: { ...retrieved, status: 'running', phase: 'resolving', retrieved: false, matched_title: null },
    });
    api.getRetrievalJob.mockResolvedValue({ job: retrieved });
    api.updatePaper.mockResolvedValue({ paper: paper({ title: 'The LLM Compiler', title_confirmed: true }) });
  });

  it('offers the source title over the placeholder an identifier-add recorded', async () => {
    render(<Discussion slug="arxiv-2405-17057" source="2405.17057" onNavigate={vi.fn()} />);

    expect(await screen.findByText('Use the source title?')).toBeInTheDocument();
    expect(screen.getByText('The LLM Compiler')).toBeInTheDocument();
  });

  it('renames on the reader\'s say-so and stops offering', async () => {
    const user = userEvent.setup();
    render(<Discussion slug="arxiv-2405-17057" source="2405.17057" onNavigate={vi.fn()} />);
    await screen.findByText('Use the source title?');

    api.getSession.mockResolvedValue(session('arxiv-2405-17057', 'The LLM Compiler', {
      paper: paper({ title: 'The LLM Compiler', title_confirmed: true, retrieved: true }),
    }));
    await user.click(screen.getByRole('button', { name: 'Use this title' }));

    await waitFor(() => expect(api.updatePaper).toHaveBeenCalledWith(
      'project-1', 'arxiv-2405-17057', 'The LLM Compiler', true,
    ));
    await waitFor(() => expect(screen.queryByText('Use the source title?')).not.toBeInTheDocument());
  });

  it('records a decision to keep the reader\'s own title, without renaming', async () => {
    const user = userEvent.setup();
    render(<Discussion slug="arxiv-2405-17057" source="2405.17057" onNavigate={vi.fn()} />);
    await screen.findByText('Use the source title?');

    await user.click(screen.getByRole('button', { name: 'Keep mine' }));

    await waitFor(() => expect(api.updatePaper).toHaveBeenCalledWith(
      'project-1', 'arxiv-2405-17057', undefined, true,
    ));
  });

  it('asks again on re-entry when the reader left without answering', async () => {
    // The paper is already fetched, so nothing raises the offer from a live retrieval; without
    // the re-entry read, the placeholder the add recorded would stand for good.
    api.getSession.mockResolvedValue(session('arxiv-2405-17057', 'arXiv 2405.17057', {
      paper: paper({ retrieved: true }),
    }));
    api.getLatestRetrievalJob.mockResolvedValue({ job: retrieved });

    render(<Discussion slug="arxiv-2405-17057" onNavigate={vi.fn()} />);

    expect(await screen.findByText('Use the source title?')).toBeInTheDocument();
    expect(api.startRetrievalJob).not.toHaveBeenCalled();
  });

  it('asks during a discussion that was started before the title was settled', async () => {
    api.getSession.mockResolvedValue(session('arxiv-2405-17057', 'arXiv 2405.17057', {
      paper: paper({ retrieved: true }),
      state: 'in_discussion',
      transcript: [{ role: 'user', text: 'Question' }, { role: 'assistant', canonical: 'Answer.' }],
    }));
    api.getLatestRetrievalJob.mockResolvedValue({ job: retrieved });

    render(<Discussion slug="arxiv-2405-17057" onNavigate={vi.fn()} />);

    expect(await screen.findByText('Use the source title?')).toBeInTheDocument();
  });

  it('does not re-offer a title a person already ruled on', async () => {
    api.getSession.mockResolvedValue(session('arxiv-2405-17057', 'arXiv 2405.17057', {
      paper: paper({ title_confirmed: true }),
    }));

    api.getLatestRetrievalJob.mockResolvedValue({ job: retrieved });

    render(<Discussion slug="arxiv-2405-17057" source="2405.17057" onNavigate={vi.fn()} />);

    await screen.findByText('Start — Opening arxiv-2405-17057');
    expect(screen.queryByText('Use the source title?')).not.toBeInTheDocument();
  });

  it('stays quiet when the source agrees with the title already recorded', async () => {
    api.getSession.mockResolvedValue(session('attention', 'Attention Is All You Need', {
      paper: { slug: 'attention', title: 'Attention Is All You Need', retrieved: false, list_status: 'unread' },
    }));
    api.getRetrievalJob.mockResolvedValue({
      job: { ...retrieved, slug: 'attention', matched_title: 'attention is all you need' },
    });

    render(<Discussion slug="attention" source="1706.03762" onNavigate={vi.fn()} />);

    await screen.findByText('Start — Opening attention');
    expect(screen.queryByText('Use the source title?')).not.toBeInTheDocument();
  });
});
