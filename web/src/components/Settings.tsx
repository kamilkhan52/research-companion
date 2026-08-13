import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import { getFavoriteModels } from '@/api/endpoints';
import type { FavoriteModel } from '@/api/types';
import './Settings.css';

interface SettingsData {
  has_key: boolean; key_hint: string; model: string; narration_model: string;
  speech_provider: string; has_openai_key: boolean; openai_key_hint: string;
  tts_voice: string; tts_model: string; prior_notes_scope?: 'related' | 'all'; preview_model?: string;
  voices?: string[]; has_brave_key?: boolean; brave_key_hint?: string;
  has_firecrawl_key?: boolean; firecrawl_key_hint?: string;
  /** Whether THIS caller may write these settings. Everything else here is instance-wide — one
   *  key, one model, one voice for every user — so only the operator (RC_OPERATOR_USERS) may
   *  change it; the server 403s anyone else. Optional, and defaulted to `true` below, because a
   *  backend older than the gate omits it and does accept the write. */
  is_operator?: boolean;
  can_edit_preferences?: boolean;
}
interface Props { onClose: () => void; }

export function Settings({ onClose }: Props) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [braveKey, setBraveKey] = useState('');
  const [firecrawlKey, setFirecrawlKey] = useState('');
  const [model, setModel] = useState('');
  const [narrationModel, setNarrationModel] = useState('');
  const [previewModel, setPreviewModel] = useState('');
  const [favorites, setFavorites] = useState<FavoriteModel[]>([]);
  const [speechProvider, setSpeechProvider] = useState('openai');
  const [voice, setVoice] = useState('alloy');
  const [ttsModel, setTtsModel] = useState('tts-1');
  const [priorNotesScope, setPriorNotesScope] = useState<'related' | 'all'>('related');
  const [autoplay, setAutoplay] = useState(false);
  const [prompts, setPrompts] = useState<{ key: string; label: string; valid: boolean }[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(null);
    void apiGet<SettingsData>('/api/settings').then((settings) => {
      if (cancelled) return;
      setData(settings); setModel(settings.model || ''); setNarrationModel(settings.narration_model || '');
      setPreviewModel(settings.preview_model || ''); setSpeechProvider(settings.speech_provider || 'openai'); setVoice(settings.tts_voice || 'alloy');
      setTtsModel(settings.tts_model === 'tts-1-hd' ? 'tts-1' : settings.tts_model || 'tts-1');
      setPriorNotesScope(settings.prior_notes_scope || 'related');
      setAutoplay(localStorage.getItem('rc_autoplay') === '1');
    }).catch((caught) => { if (!cancelled) setLoadError(caught instanceof Error ? caught.message : 'Failed to load settings');
    }).finally(() => { if (!cancelled) setLoading(false); });
    void apiGet<{ prompts: { key: string; label: string; valid: boolean }[] }>('/api/prompts')
      .then((response) => { if (!cancelled) setPrompts(response.prompts || []); }).catch(() => {});
    void getFavoriteModels().then(({ models }) => {
      if (!cancelled) setFavorites(Array.isArray(models) ? models : []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [retry]);

  // Two capabilities, not one. The provider keys are instance-wide configuration and stay the
  // operator's. The model/voice/scope picks describe how ONE person reads, and the server stores
  // them per user — so gating the whole form on `is_operator`, as this did, took a reader's own
  // voice away. Both default to true so a server that predates the flags behaves as it used to.
  const canEditShared = data?.is_operator ?? true;
  // Falls back to `canEditShared`, NOT to true. An absent field means a server older than the
  // split, and that server's real behaviour is "only the operator may write these" — so absence
  // must reproduce the old contract, not unlock the form. Guarding against absence rather than a
  // wrong value is a rule this codebase has been bitten by twice (auth.mode, RC_ENV).
  const canEditPrefs = data?.can_edit_preferences ?? canEditShared;

  async function save() {
    setSaving(true); setMessage('');
    const patch: Record<string, string> = {};
    if (canEditPrefs) {
      Object.assign(patch, {
        model, narration_model: narrationModel, preview_model: previewModel,
        speech_provider: speechProvider, tts_voice: voice, tts_model: ttsModel,
        prior_notes_scope: priorNotesScope,
      });
    }
    if (canEditShared) {
      if (openrouterKey) patch.openrouter_api_key = openrouterKey;
      if (openaiKey) patch.openai_api_key = openaiKey;
      if (braveKey) patch.brave_search_api_key = braveKey;
      if (firecrawlKey) patch.firecrawl_api_key = firecrawlKey;
    }
    // Device-local preference first: it belongs to this browser, not to the instance, so it must
    // survive the shared-settings POST being refused. A reader who is not the operator gets a 403
    // below, and before this ordering that silently discarded their autoplay choice too.
    localStorage.setItem('rc_autoplay', autoplay ? '1' : '0');
    if (Object.keys(patch).length === 0) {
      // Nothing on this form is the caller's to write — autoplay is already saved above. Posting
      // an empty patch would buy a guaranteed 403 and report the whole save as failed.
      setMessage('Autoplay saved.'); setSaving(false); return;
    }
    try {
      await apiPost('/api/settings', patch);
      setOpenrouterKey(''); setOpenaiKey(''); setBraveKey(''); setFirecrawlKey(''); setMessage('Saved.');
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'Save failed');
    } finally { setSaving(false); }
  }

  return <div className="settings-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-modal" aria-label="Settings" role="dialog" aria-modal="true">
      <div className="settings-head"><h2>Settings</h2><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
      {loading ? <div className="lc-loading"><span className="spinner" /> Loading…</div> : loadError ? <div className="settings-body"><p className="build-progress-error">{loadError}</p><button className="btn primary" onClick={() => setRetry((value) => value + 1)}>Retry</button></div> : <div className="settings-body">
        {!canEditShared && <p className="settings-readonly-note">
          {canEditPrefs
            ? 'The API keys below are shared by everyone on this server, so only its operator can change them. The model, voice, and notes settings are yours.'
            : 'The keys, models, and voice below are one shared configuration for everyone on this server, so only its operator can change them. Autoplay is yours and still saves.'}
        </p>}
        <label className="field"><span>OpenRouter API key</span><input type="password" value={openrouterKey} onChange={(event) => setOpenrouterKey(event.target.value)} placeholder="sk-or-…" disabled={!canEditShared} /><small className="muted">{data?.has_key ? `key set: ${data.key_hint}` : 'no key set'}</small></label>
        <datalist id="settings-models">{favorites.map((favorite) => <option key={favorite.id} value={favorite.id}>{favorite.label}</option>)}</datalist>
        <label className="field"><span>Analysis model</span><input list="settings-models" value={model} onChange={(event) => setModel(event.target.value)} disabled={!canEditPrefs} /></label>
        <label className="field"><span>Narration model</span><input list="settings-models" value={narrationModel} onChange={(event) => setNarrationModel(event.target.value)} disabled={!canEditPrefs} /></label>
        <label className="field"><span>Listening cue model</span><input list="settings-models" value={previewModel} onChange={(event) => setPreviewModel(event.target.value)} placeholder="Uses narration model when blank" disabled={!canEditPrefs} /></label>
        <hr className="settings-hr" />
        <label className="field"><span>Speech provider</span><select value={speechProvider} onChange={(event) => setSpeechProvider(event.target.value)} disabled={!canEditPrefs}><option value="openai">OpenAI — premium</option><option value="browser">Browser built-in — free</option></select></label>
        {speechProvider === 'openai' && <><label className="field"><span>OpenAI API key (speech only)</span><input type="password" value={openaiKey} onChange={(event) => setOpenaiKey(event.target.value)} placeholder="sk-…" disabled={!canEditShared} /><small className="muted">{data?.has_openai_key ? `key set: ${data.openai_key_hint}` : 'no key set'}</small></label><div className="settings-row"><label className="field"><span>Voice</span><select value={voice} onChange={(event) => setVoice(event.target.value)} disabled={!canEditPrefs}>{(data?.voices?.length ? data.voices : ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']).map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label className="field"><span>TTS model</span><select value={ttsModel} onChange={(event) => setTtsModel(event.target.value)} disabled={!canEditPrefs}>{['gpt-4o-mini-tts', 'tts-1'].map((name) => <option key={name} value={name}>{name}</option>)}</select></label></div></>}
        <label className="field check"><input type="checkbox" checked={autoplay} onChange={(event) => setAutoplay(event.target.checked)} /> Autoplay narration after each reply</label>
        <hr className="settings-hr" />
        <label className="field"><span>Brave Search API key (web search)</span><input type="password" value={braveKey} onChange={(event) => setBraveKey(event.target.value)} placeholder="optional — leave blank to keep current" disabled={!canEditShared} /><small className="muted">{data?.has_brave_key ? `key set: ${data.brave_key_hint}` : 'no key set'}</small></label>
        <label className="field"><span>Firecrawl API key (web fetch)</span><input type="password" value={firecrawlKey} onChange={(event) => setFirecrawlKey(event.target.value)} placeholder="optional — leave blank to keep current" disabled={!canEditShared} /><small className="muted">{data?.has_firecrawl_key ? `key set: ${data.firecrawl_key_hint}` : 'no key set'}</small></label>
        <label className="field"><span>Prior notes scope</span><select value={priorNotesScope} onChange={(event) => setPriorNotesScope(event.target.value as 'related' | 'all')} disabled={!canEditPrefs}><option value="related">Related papers only</option><option value="all">All read papers</option></select></label>
        {prompts.length > 0 && <div className="prompts-status"><h4 className="settings-subhead">Prompt status</h4>{prompts.map((prompt) => <div className="prompts-row" key={prompt.key}><span>{prompt.label}</span><span className={`badge ${prompt.valid ? 'badge-green' : 'badge-amber'}`}>{prompt.valid ? 'valid' : 'INVALID'}</span></div>)}</div>}
        {message && <p className="settings-message">{message}</p>}<button className="btn primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : (canEditShared || canEditPrefs) ? 'Save' : 'Save autoplay'}</button>
      </div>}
    </section>
  </div>;
}
