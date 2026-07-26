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

  // Once the server stores preferences per user it says so, and then a reader owns their own model,
  // voice and prior-notes scope while the provider keys stay the operator's. The two capabilities
  // are separate flags precisely because they answer differently for the same caller.
  describe('when the caller may set their own preferences but not the shared keys', () => {
    beforeEach(() => {
      api.apiGet.mockImplementation((path: string) => path === '/api/settings'
        ? Promise.resolve({ ...settings, is_operator: false, can_edit_preferences: true })
        : Promise.resolve({ prompts: [] }));
    });

    it('leaves the preferences editable and only the keys read-only', async () => {
      render(<Settings onClose={vi.fn()} />);
      await screen.findByDisplayValue('model/a');
      expect(screen.getByLabelText('Analysis model')).toBeEnabled();
      expect(screen.getByLabelText('Prior notes scope')).toBeEnabled();
      expect(screen.getByLabelText('Speech provider')).toBeEnabled();
      expect(screen.getByLabelText(/OpenRouter API key/)).toBeDisabled();
      expect(screen.getByLabelText(/Firecrawl API key/)).toBeDisabled();
    });

    // Pins the patch SHAPE: preferences go, keys do not. Note the key half is not independently
    // reachable here — the key inputs are disabled, so their state is empty and they would be
    // omitted even without the guard in `save()`. The guard is for the case where `is_operator`
    // flips between typing and saving (a refetch), which this test does not construct.
    it('posts the preferences, and the patch carries no key', async () => {
      const user = userEvent.setup();
      render(<Settings onClose={vi.fn()} />);
      await screen.findByDisplayValue('model/a');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
      const [, patch] = api.apiPost.mock.calls[0];
      expect(patch).toEqual(expect.objectContaining({ model: 'model/a' }));
      expect(patch).not.toHaveProperty('openrouter_api_key');
      expect(patch).not.toHaveProperty('openai_api_key');
    });
  });

  // An older server does not send the flag at all, and its real behaviour is "only the operator
  // may write these" — so absence must reproduce that, not unlock the form. Defaulting the other
  // way is the mistake this codebase has made twice (auth.mode, RC_ENV): letting a missing value
  // be the permissive one.
  it('treats a server that does not send the flag as operator-only', async () => {
    api.apiGet.mockImplementation((path: string) => path === '/api/settings'
      ? Promise.resolve({ ...settings, is_operator: false }) : Promise.resolve({ prompts: [] }));
    render(<Settings onClose={vi.fn()} />);
    await screen.findByDisplayValue('model/a');
    expect(screen.getByLabelText('Analysis model')).toBeDisabled();
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
