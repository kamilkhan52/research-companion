import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Discussion } from '@/components/Discussion';

const active = vi.hoisted(() => ({ pid: 'project-1' as string | null }));
const api = vi.hoisted(() => ({
  approve: vi.fn(), continueJob: vi.fn(), finishJob: vi.fn(), getActiveChatJob: vi.fn(),
  getChatJob: vi.fn(), getLatestRetrievalJob: vi.fn(), getOpeningDraft: vi.fn(),
  getRetrievalJob: vi.fn(), getReview: vi.fn(), getSession: vi.fn(), reopen: vi.fn(),
  replyJob: vi.fn(), requestChangesJob: vi.fn(), retryJob: vi.fn(), startJob: vi.fn(),
  startRetrievalJob: vi.fn(),
}));

vi.mock('@/hooks/useLibrary', () => ({ useActivePid: () => [active.pid, vi.fn()] }));
vi.mock('@/api/endpoints', () => api);

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
