import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Notes } from '@/components/Notes';

const active = vi.hoisted(() => ({ pid: 'project-1' as string | null }));
const api = vi.hoisted(() => ({
  getLatestNotesJob: vi.fn(), getNotes: vi.fn(), getNotesJob: vi.fn(),
  saveNotes: vi.fn(), startNotesAgentJob: vi.fn(),
}));

vi.mock('@/hooks/useLibrary', () => ({
  useActivePid: () => [active.pid, vi.fn()],
  usePaperIndex: () => [],
}));
vi.mock('@/api/endpoints', () => api);

beforeEach(() => {
  active.pid = 'project-1';
  vi.clearAllMocks();
  api.getNotes.mockResolvedValue({ target: 'working', title: 'Working notes', markdown: '# Existing notes' });
  api.getLatestNotesJob.mockResolvedValue({ job: null });
});

describe('Notes agent proposals', () => {
  it('recovers a completed proposal on re-entry without writing it automatically', async () => {
    api.getLatestNotesJob.mockResolvedValue({
      job: { id: 'notes-1', status: 'done', result: '# Recovered proposal', error: null },
    });

    render(<Notes target="working" onNavigate={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Agent proposal' });
    expect(screen.getByText('Recovered proposal')).toBeInTheDocument();
    expect(api.saveNotes).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply proposal' }));
    await waitFor(() => expect(api.saveNotes).toHaveBeenCalledWith('project-1', 'working', '# Recovered proposal'));
  });

  it('polls a new agent job and exposes its terminal proposal for human approval', async () => {
    api.startNotesAgentJob.mockResolvedValue({ job: { id: 'notes-2', status: 'running', result: null, error: null } });
    api.getNotesJob.mockResolvedValue({ job: { id: 'notes-2', status: 'done', result: '# New proposal', error: null } });

    const user = userEvent.setup();
    render(<Notes target="working" onNavigate={vi.fn()} />);
    await screen.findByText('Existing notes');
    await user.click(screen.getByRole('button', { name: 'Agent' }));
    await user.type(screen.getByPlaceholderText(/instructions for the agent/i), 'Make it concise');
    await user.click(screen.getByRole('button', { name: 'Ask agent to edit' }));

    await screen.findByText('New proposal');
    expect(api.getNotesJob).toHaveBeenCalledWith('project-1', 'notes-2');
  });
});
