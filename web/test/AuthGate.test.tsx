import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from '@/components/AuthGate';
import { apiGet } from '@/api/client';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: () => Promise.resolve(body) } as Response);

describe('AuthGate', () => {
  it('passes through open mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ enabled: false, mode: 'open' }));
    const onAuthenticated = vi.fn(); render(<AuthGate onAuthenticated={onAuthenticated} />);
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
  });
  it('validates a submitted shared token before opening the app', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => Promise.resolve(String(input).includes('/api/auth/config') ? response({ enabled: true, mode: 'token' }) : response([])));
    const onAuthenticated = vi.fn(); const user = userEvent.setup(); render(<AuthGate onAuthenticated={onAuthenticated} />);
    await user.type(await screen.findByPlaceholderText('Enter shared token…'), 'valid-token');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    expect(localStorage.getItem('rc_token')).toBe('valid-token');
  });
  it('clears a token and emits the re-gate event for a real HTTP 401', async () => {
    localStorage.setItem('rc_token', 'expired'); const regate = vi.fn(); window.addEventListener('rc:auth-required', regate);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ detail: 'Unauthorized' }, false, 401));
    await expect(apiGet('/api/projects')).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem('rc_token')).toBeNull(); expect(regate).toHaveBeenCalledTimes(1);
    window.removeEventListener('rc:auth-required', regate);
  });
});
