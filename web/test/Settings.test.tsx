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

  // The shared block is instance-wide: one key, one model, one voice for every user. A reader who
  // is not the operator gets a 403 from the server, so the form must not invite the edit — and,
  // the sharper half, must not take the reader's OWN device-local autoplay choice down with it.
  describe('when the caller is not the instance operator', () => {
    beforeEach(() => {
      api.apiGet.mockImplementation((path: string) => path === '/api/settings'
        ? Promise.resolve({ ...settings, is_operator: false }) : Promise.resolve({ prompts: [] }));
    });

    it('shows the shared controls read-only but leaves autoplay editable', async () => {
      render(<Settings onClose={vi.fn()} />);
      await screen.findByDisplayValue('model/a');
      expect(screen.getByLabelText('Analysis model')).toBeDisabled();
      expect(screen.getByLabelText(/OpenRouter API key/)).toBeDisabled();
      expect(screen.getByLabelText('Prior notes scope')).toBeDisabled();
      expect(screen.getByLabelText('Speech provider')).toBeDisabled();
      expect(screen.getByLabelText(/Autoplay narration/)).toBeEnabled();
    });

    it('saves autoplay locally without posting a request that would 403', async () => {
      const user = userEvent.setup();
      render(<Settings onClose={vi.fn()} />);
      await screen.findByDisplayValue('model/a');
      await user.click(screen.getByLabelText(/Autoplay narration/));
      await user.click(screen.getByRole('button', { name: 'Save autoplay' }));
      await waitFor(() => expect(localStorage.getItem('rc_autoplay')).toBe('1'));
      expect(api.apiPost).not.toHaveBeenCalled();
    });

    // Guards the two above: without this, an implementation that disabled everything and never
    // posted for ANY user would satisfy them both while breaking the operator entirely.
    it('still posts for the operator, and keeps their autoplay too', async () => {
      api.apiGet.mockImplementation((path: string) => path === '/api/settings'
        ? Promise.resolve({ ...settings, is_operator: true }) : Promise.resolve({ prompts: [] }));
      const user = userEvent.setup();
      render(<Settings onClose={vi.fn()} />);
      await screen.findByDisplayValue('model/a');
      expect(screen.getByLabelText('Analysis model')).toBeEnabled();
      await user.click(screen.getByLabelText(/Autoplay narration/));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ model: 'model/a' })));
      expect(localStorage.getItem('rc_autoplay')).toBe('1');
    });
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
