import { useEffect, useRef, useState } from 'react';
import { apiGet } from '@/api/client';
import type { SupabaseClient } from '@supabase/supabase-js';

interface Config { enabled: boolean; mode: 'open' | 'token' | 'supabase'; supabase_url?: string; supabase_anon_key?: string; }
export function AuthGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [config, setConfig] = useState<Config | null>(null); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [token, setToken] = useState(''); const [email, setEmail] = useState(''); const [retry, setRetry] = useState(0);
  const supabase = useRef<SupabaseClient | null>(null);
  useEffect(() => {
    let cancelled = false; let unsubscribe: (() => void) | undefined;
    setLoading(true); setError('');
    void apiGet<Config>('/api/auth/config').then(async (next) => {
      if (cancelled) return; setConfig(next);
      if (!next.enabled) { onAuthenticated(); return; }
      if (next.mode === 'token') { if (localStorage.getItem('rc_token')) { try { await apiGet('/api/projects'); if (!cancelled) onAuthenticated(); } catch { localStorage.removeItem('rc_token'); } } return; }
      if (next.mode === 'supabase' && next.supabase_url && next.supabase_anon_key) {
        const { createClient } = await import('@supabase/supabase-js'); if (cancelled) return;
        const client = createClient(next.supabase_url, next.supabase_anon_key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }); supabase.current = client;
        const { data } = client.auth.onAuthStateChange((_event, session) => { if (session?.access_token) { localStorage.setItem('rc_token', session.access_token); onAuthenticated(); } else { localStorage.removeItem('rc_token'); } });
        unsubscribe = () => data.subscription.unsubscribe();
        const session = (await client.auth.getSession()).data.session;
        if (!cancelled && session?.access_token) { localStorage.setItem('rc_token', session.access_token); onAuthenticated(); }
      }
    }).catch(() => { if (!cancelled) { setConfig({ enabled: true, mode: 'token' }); setError('Could not reach the server to check authentication.'); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; unsubscribe?.(); supabase.current = null; };
  }, [onAuthenticated, retry]);
  async function tokenLogin() { if (!token.trim()) return; localStorage.setItem('rc_token', token.trim()); try { await apiGet('/api/projects'); onAuthenticated(); } catch { localStorage.removeItem('rc_token'); setError('Invalid token. Could not authenticate.'); } }
  async function google() { await supabase.current?.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } }); }
  async function magic() { if (!email.trim()) return; const { error: signInError } = await supabase.current!.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.origin } }); setError(signInError?.message || 'Check your email for the sign-in link.'); }
  if (loading || !config) return <div className="lc-loading"><span className="spinner" /> Loading…</div>;
  if (error && !supabase.current && config.mode === 'token') return <div className="auth-panel"><h3>Connection error</h3><p className="muted">{error}</p><button className="btn primary" onClick={() => setRetry((n) => n + 1)}>Retry</button></div>;
  return <div className="auth-panel"><h3>Sign in</h3>{config.mode === 'supabase' ? <><button className="btn primary" onClick={() => void google()}>Continue with Google</button><label className="field"><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label><button className="btn ghost" onClick={() => void magic()}>Email me a magic link</button></> : <><label className="field"><span>Access token</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Enter shared token…" /></label><button className="btn primary" onClick={() => void tokenLogin()}>Sign in</button></>} {error && <p className="muted">{error}</p>}</div>;
}
