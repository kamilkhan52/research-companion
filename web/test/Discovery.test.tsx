import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Discovery } from '@/components/Discovery';

const active = vi.hoisted(() => ({ pid: 'project-1' as string | null }));
const api = vi.hoisted(() => ({ addPaper: vi.fn(), getDiscovery: vi.fn(), startDiscovery: vi.fn() }));

vi.mock('@/hooks/useLibrary', () => ({ useActivePid: () => [active.pid, vi.fn()] }));
vi.mock('@/api/endpoints', () => api);

beforeEach(() => {
  active.pid = 'project-1';
  vi.clearAllMocks();
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
    await waitFor(() => expect(api.addPaper).toHaveBeenCalledWith('project-1', 'Paper One', '2501.00001'));
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
