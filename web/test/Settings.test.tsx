import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '@/components/Settings';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('@/api/client', () => api);

const settings = {
  has_key: true, key_hint: '…1234', model: 'model/a', narration_model: 'model/narrate',
  speech_provider: 'openai', has_openai_key: false, openai_key_hint: '', tts_voice: 'nova',
  tts_model: 'tts-1', prior_notes_scope: 'all',
};

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  api.apiGet.mockImplementation((path: string) => path === '/api/settings'
    ? Promise.resolve(settings) : Promise.resolve({ prompts: [{ key: 'opening', label: 'Opening', valid: true }] }));
  api.apiPost.mockResolvedValue({});
});

describe('Settings', () => {
  it('loads server-backed settings and preserves the prior-notes scope on save', async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} />);
    await screen.findByDisplayValue('model/a');
    expect(screen.getByRole('combobox', { name: 'Prior notes scope' })).toHaveValue('all');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ prior_notes_scope: 'all', model: 'model/a' })));
  });

  it('retries a failed settings load', async () => {
    api.apiGet.mockImplementationOnce(() => Promise.reject(new Error('offline'))).mockImplementation((path: string) =>
      path === '/api/settings' ? Promise.resolve(settings) : Promise.resolve({ prompts: [] }));
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} />);
    await screen.findByText('offline');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByDisplayValue('model/a');
  });
});
