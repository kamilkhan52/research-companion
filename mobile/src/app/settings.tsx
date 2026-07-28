// Settings — server connection plus the backend's own settings (keys, models, speech). The
// server URL is stored locally (config.ts); everything else is persisted server-side via
// /api/settings so web and mobile share one configuration.

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { getBaseUrl, hasBaseUrl, setBaseUrl } from '@/api/config';
import { useAudio } from '@/audio/AudioProvider';
import { useAuth } from '@/auth/AuthProvider';
import {
  useFavoriteModels,
  usePrompts,
  useResetPrompt,
  useSavePrompt,
  useSaveSettings,
  useSettings,
  useUsage,
} from '@/api/queries';
import type { UsageSummary } from '@/api/types';
import { TopBar } from '@/components/TopBar';
import { PromptStatusPanel } from '@/components/PromptStatusPanel';
import { useActiveProject } from '@/store/project';
import { useListeningMode } from '@/store/listening';
import { useGraphSettings } from '@/store/graphSettings';
import { previewModelDraft, previewModelPatch } from '@/settings/previewModel';
import {
  DENSITY_MODES,
  THEME_MODES,
  useTheme,
  useThemedStyles,
  useThemeMode,
  type DensityMode,
} from '@/theme/ThemeProvider';
import { Button, Card, Screen, Text } from '@/ui';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';
import { useToast } from '@/ui/Toast';
import type { ThemeMode } from '@/theme/tokens';

/** Whether the shared, instance-wide controls on this screen are writable by this user.
 *
 *  Deliberately a context with a `true` default rather than a prop threaded through twenty call
 *  sites: a control I forget to pass it to would otherwise stay editable and 403 on save, which is
 *  precisely the failure this whole change exists to remove. `Field` and `ModelChips` read it
 *  unconditionally — every one of them edits shared state — so forgetting one is impossible.
 *  `Toggle` is the only mixed case: some toggles (playback mode, theme, density, the map filter)
 *  are DEVICE-local and must keep working for readers, so those opt out with `local`. Opting out
 *  is the visible, deliberate act; the safe behaviour is what you get by default. */
const SharedWritableContext = createContext(true);

export default function SettingsScreen() {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const qc = useQueryClient();
  const { activePid } = useActiveProject();
  const [url, setUrl] = useState(getBaseUrl());
  const [savingUrl, setSavingUrl] = useState(false);

  const settings = useSettings();
  const favorites = useFavoriteModels();
  const prompts = usePrompts(activePid);
  const saveSettings = useSaveSettings();
  // Everything under /api/settings and /api/prompts is INSTANCE-wide: one key, one model, one
  // voice, one set of prompts, shared by every user. Only the named operator may write them
  // (RC_OPERATOR_USERS); the server 403s everyone else. Default true so a backend older than the
  // gate — which accepts the write from anyone — is not shown a read-only form it would honour.
  const isOperator = settings.data?.is_operator ?? true;
  // ...except the model, voice and prior-notes picks, which the server now stores PER USER. Those
  // describe how one person reads, not how the instance is configured, so gating them on
  // `is_operator` as well took a reader's own voice away. Same default, same reason.
  // Falls back to `isOperator`, NOT to true: an absent field means a server older than the split,
  // whose real behaviour is "only the operator may write these". Absence must reproduce the old
  // contract rather than unlock the form.
  const canEditPrefs = settings.data?.can_edit_preferences ?? isOperator;
  const savePrompt = useSavePrompt(activePid);
  const resetPrompt = useResetPrompt(activePid);

  // Local editable copies of server-side settings.
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [narrationModel, setNarrationModel] = useState('');
  const [previewModel, setPreviewModel] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [parallelKey, setParallelKey] = useState('');
  const [firecrawlKey, setFirecrawlKey] = useState('');
  const [semanticScholarKey, setSemanticScholarKey] = useState('');
  const [voice, setVoice] = useState('');
  const [speechProvider, setSpeechProvider] = useState<'openai' | 'browser'>('openai');
  const [priorScope, setPriorScope] = useState<'related' | 'all'>('related');
  // Device-local (AsyncStorage), applies immediately — not part of the server settings save.
  const { playbackMode, setPlaybackMode } = useListeningMode();
  const { allowAllFilter, setAllowAllFilter } = useGraphSettings();
  const {
    mode: themeMode,
    setMode: setThemeMode,
    density,
    setDensity,
  } = useThemeMode();
  const { toast } = useToast();
  const { status: authStatus, email: authEmail, signOut } = useAuth();
  const { dismiss: dismissAudio } = useAudio();

  async function handleSignOut() {
    // Stops preparation as well as playback. The provider-independent teardown in AuthProvider
    // handles the rest — and handles the paths this button never sees, like a token expiring.
    await dismissAudio().catch(() => {});
    await signOut();
  }
  function handleThemeMode(mode: ThemeMode) {
    if (mode === themeMode) return;
    setThemeMode(mode);
    toast(`Theme: ${THEME_MODES.find((m) => m.mode === mode)?.label ?? mode}`);
  }
  function handleDensity(mode: DensityMode) {
    if (mode === density) return;
    setDensity(mode);
    toast(`Layout: ${DENSITY_MODES.find((item) => item.mode === mode)?.label ?? mode}`);
  }

  // Sync local fields from the server exactly once, on first successful load — NOT on every
  // settings.data change. A background refetch (e.g. right after saveSettings invalidates the
  // query) would otherwise re-fire this and silently overwrite whatever the user is mid-typing
  // into model/narrationModel/voice with the last-saved server values.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (settings.data && !initializedRef.current) {
      setModel(settings.data.model ?? '');
      setNarrationModel(settings.data.narration_model ?? '');
      setPreviewModel(previewModelDraft(settings.data.preview_model));
      setVoice(settings.data.tts_voice ?? '');
      setSpeechProvider((settings.data.speech_provider as 'openai' | 'browser') ?? 'openai');
      setPriorScope(settings.data.prior_notes_scope === 'all' ? 'all' : 'related');
      initializedRef.current = true;
    }
  }, [settings.data]);

  async function handleSaveUrl() {
    setSavingUrl(true);
    try {
      await setBaseUrl(url);
      setUrl(getBaseUrl());
      await qc.invalidateQueries();
    } finally {
      setSavingUrl(false);
    }
  }

  async function handleSaveSettings() {
    // Send only what this caller may write. A key in the payload from someone who is not the
    // operator 403s the WHOLE request, taking their voice change down with it.
    const payload: Record<string, unknown> = {};
    if (canEditPrefs) {
      Object.assign(payload, {
        model: model || null,
        narration_model: narrationModel || null,
        preview_model: previewModelPatch(previewModel),
        speech_provider: speechProvider,
        tts_voice: voice || null,
        prior_notes_scope: priorScope,
      });
    }
    if (isOperator) {
      if (apiKey.trim()) payload.openrouter_api_key = apiKey.trim();
      if (openaiKey.trim()) payload.openai_api_key = openaiKey.trim();
      if (parallelKey.trim()) payload.parallel_api_key = parallelKey.trim();
      if (firecrawlKey.trim()) payload.firecrawl_api_key = firecrawlKey.trim();
      if (semanticScholarKey.trim()) {
        payload.semantic_scholar_api_key = semanticScholarKey.trim();
      }
    }
    if (Object.keys(payload).length === 0) return;
    await saveSettings.mutateAsync(payload);
    setApiKey('');
    setOpenaiKey('');
    setSemanticScholarKey('');
  }

  return (
    <Screen edges={['top']}>
      <TopBar
        title="Settings"
        onBack={() => router.back()}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Server connection */}
          <Section title="Connection">
            <Text variant="body" color={t.muted} style={{ marginBottom: space.md }}>
              Connect your backend to sync projects, papers, audio, and notes — the Cloudflare
              tunnel link (e.g. https://name.trycloudflare.com).
            </Text>
            <Field
              value={url}
              onChangeText={setUrl}
              placeholder="https://…trycloudflare.com"
              autoCapitalize="none"
              keyboardType="url"
            />
            <Button
              title={savingUrl ? 'Saving…' : 'Save & connect'}
              onPress={handleSaveUrl}
              loading={savingUrl}
              disabled={!url.trim()}
              style={{ marginTop: space.sm }}
            />
          </Section>

          {authStatus === 'signed-in' ? (
            <Section title="Account">
              <Text variant="body" color={t.muted} style={{ marginBottom: space.md }}>
                {authEmail ? `Signed in as ${authEmail}.` : 'Signed in.'}
              </Text>
              <Button title="Sign out" onPress={() => { void handleSignOut(); }} />
              <Button
                title="Delete account"
                variant="danger"
                icon="trash-2"
                onPress={() => router.push('/delete-account')}
                style={{ marginTop: space.sm }}
              />
            </Section>
          ) : null}

          {!hasBaseUrl() ? (
            <>
              <LockedRow label="Analysis model" />
              <LockedRow label="Audio voice" />
              <LockedRow label="Research sources" />
              <Text variant="caption" style={{ textAlign: 'center', marginTop: space.lg }}>
                Set a server URL first to configure analysis and audio.
              </Text>
            </>
          ) : settings.isLoading ? (
            <ActivityIndicator color={t.mint} style={{ paddingVertical: space.xl }} />
          ) : settings.isError ? (
            <Text variant="caption" color={t.danger} style={{ textAlign: 'center', marginTop: space.lg }}>
              Couldn't reach the server. Check the URL and that the backend is running.
            </Text>
          ) : (
            // Scoped to the shared settings only — the server URL above it belongs to this device
            // and stays editable for everyone, including a reader who cannot change the instance.
            <SharedWritableContext.Provider value={isOperator}>
              {!isOperator ? (
                <Card style={{ marginBottom: space.lg }}>
                  <Text variant="heading">Some settings are read-only</Text>
                  <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
                    {canEditPrefs
                      ? 'The API keys and prompts below are one shared configuration for everyone on this server, so only its operator can change them. The models, voice, and prior-notes setting are yours, as are playback, theme, layout, the map filter, and the server URL.'
                      : 'The keys, models, voice, and prompts below are one shared configuration for everyone on this server, so only its operator can change them. Playback, theme, layout, the map filter, and the server URL are yours and still work.'}
                  </Text>
                </Card>
              ) : null}
              {/* Models & analysis */}
              <Section title="Models & analysis">
                <Label text="OpenRouter API key" hint={settings.data?.has_key ? `set (${settings.data.key_hint})` : 'not set'} />
                <Field
                  value={apiKey}
                  onChangeText={setApiKey}
                  placeholder={settings.data?.has_key ? 'Replace key…' : 'sk-or-…'}
                  secureTextEntry
                  autoCapitalize="none"
                />

                {/* Nested provider: the key above is the instance's, everything below is the
                    reader's own. The context is just "is this row writable", so nesting is the
                    whole mechanism. */}
                <SharedWritableContext.Provider value={canEditPrefs}>
                <Label text="Analysis model" />
                <Field value={model} onChangeText={setModel} placeholder="anthropic/claude-opus-…" autoCapitalize="none" />
                <ModelChips
                  models={favorites.data ?? []}
                  selected={model}
                  onPick={setModel}
                />

                <Label text="Narration model" />
                <Field value={narrationModel} onChangeText={setNarrationModel} placeholder="anthropic/claude-haiku-…" autoCapitalize="none" />
                <ModelChips
                  models={favorites.data ?? []}
                  selected={narrationModel}
                  onPick={setNarrationModel}
                />

                <Label text="Listening preview model" />
                <Field value={previewModel} onChangeText={setPreviewModel} placeholder="Defaults to narration model" autoCapitalize="none" />
                <ModelChips
                  models={favorites.data ?? []}
                  selected={previewModel}
                  onPick={setPreviewModel}
                />

                <Label text="Prior notes in paper context" />
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Toggle label="Related papers" active={priorScope === 'related'} onPress={() => setPriorScope('related')} />
                  <Toggle label="All read papers" active={priorScope === 'all'} onPress={() => setPriorScope('all')} />
                </View>
                <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
                  Which per-paper Notes the analyst sees during a discussion. "All read papers"
                  gives the fullest cross-paper grounding for a single project; "Related" keeps
                  the context smaller by including only citation-related papers.
                </Text>
                </SharedWritableContext.Provider>
              </Section>

              {/* Audio */}
              <Section title="Audio">
                <Label
                  text="Narration playback"
                  hint="applies immediately, stored on this device"
                />
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Toggle label="Full track" local active={playbackMode === 'full'} onPress={() => setPlaybackMode('full')} />
                  <Toggle label="Progressive" local active={playbackMode === 'progressive'} onPress={() => setPlaybackMode('progressive')} />
                </View>
                <Text variant="caption" style={{ marginBottom: space.md, marginTop: space.xs }}>
                  {playbackMode === 'full'
                    ? 'Waits for the complete narration: full length visible, survives locking the phone, rewind anywhere. Cues fill the wait.'
                    : 'Starts speaking as parts are synthesized: faster to first audio, but seeking is bounded by the current part and backgrounding can interrupt.'}
                </Text>

                <SharedWritableContext.Provider value={canEditPrefs}>
                  <Label text="Speech provider" />
                  <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.md }}>
                    <Toggle label="OpenAI" active={speechProvider === 'openai'} onPress={() => setSpeechProvider('openai')} />
                    <Toggle label="Browser" active={speechProvider === 'browser'} onPress={() => setSpeechProvider('browser')} />
                  </View>
                </SharedWritableContext.Provider>

                {speechProvider === 'openai' ? (
                  <>
                    <Label text="OpenAI API key" hint={settings.data?.has_openai_key ? `set (${settings.data.openai_key_hint})` : 'not set'} />
                    <Field
                      value={openaiKey}
                      onChangeText={setOpenaiKey}
                      placeholder={settings.data?.has_openai_key ? 'Replace key…' : 'sk-…'}
                      secureTextEntry
                      autoCapitalize="none"
                    />
                    <SharedWritableContext.Provider value={canEditPrefs}>
                      <Label text="Voice" />
                      <ModelChips
                        models={(settings.data?.voices ?? []).map((v) => ({ label: v, id: v }))}
                        selected={voice}
                        onPick={setVoice}
                      />
                    </SharedWritableContext.Provider>
                  </>
                ) : null}
              </Section>

              {/* Appearance (R.2) */}
              <Section title="Appearance">
                <Label
                  text="Theme"
                  hint="stored on this device"
                />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                  {THEME_MODES.map(({ mode, label }) => (
                    <Toggle
                      key={mode}
                      label={label}
                      active={themeMode === mode}
                      local
                      onPress={() => handleThemeMode(mode)}
                    />
                  ))}
                </View>
                <Text variant="caption" style={{ marginTop: space.xs }}>
                  {themeMode === 'system'
                    ? 'Follows your phone: dark uses Dim, light uses Light. Black stays opt-in.'
                    : themeMode === 'black'
                      ? 'True-black surfaces for OLED displays.'
                      : themeMode === 'light'
                        ? 'Warm paper for bright surroundings.'
                        : 'The original Scholar dark.'}
                </Text>
                <Label
                  text="Layout density"
                  hint="stored on this device"
                />
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  {DENSITY_MODES.map(({ mode, label }) => (
                    <Toggle
                      key={mode}
                      label={label}
                      active={density === mode}
                      local
                      onPress={() => handleDensity(mode)}
                    />
                  ))}
                </View>
                <Text variant="caption" style={{ marginTop: space.xs }}>
                  {density === 'tight'
                    ? 'Smaller common type and closer reading-list rhythm. Tap targets, math, code, and audio controls stay full size.'
                    : 'The original, more spacious reading rhythm.'}
                </Text>
              </Section>

              {/* Map */}
              <Section title="Map">
                <Label
                  text="Semantic Scholar API key"
                  hint={settings.data?.has_semantic_scholar_key
                    ? `set (${settings.data.semantic_scholar_key_hint})`
                    : 'not set'}
                />
                <Field
                  value={semanticScholarKey}
                  onChangeText={setSemanticScholarKey}
                  placeholder={settings.data?.has_semantic_scholar_key
                    ? 'Replace key…'
                    : 'Semantic Scholar API key'}
                  secureTextEntry
                  autoCapitalize="none"
                />
                <Text variant="caption" color={t.muted} style={{ marginTop: space.xs, marginBottom: space.md }}>
                  Enables fast paper identity, reference, citation-context, and influence
                  metadata. Requests are cached and paced below the account's one-per-second
                  cumulative limit. Graph results using this data will attribute Semantic Scholar.
                </Text>
                <Label text="'All' filter" hint="applies immediately, stored on this device" />
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Toggle label="Hidden" local active={!allowAllFilter} onPress={() => setAllowAllFilter(false)} />
                  <Toggle label="Shown" local active={allowAllFilter} onPress={() => setAllowAllFilter(true)} />
                </View>
                <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
                  The reference graph defaults to a "Significant" filter, paginated 20 papers at a
                  time. A project's full graph can run into the hundreds of external references —
                  turn this on to also offer an "All" filter chip there.
                </Text>
              </Section>

              {/* Research agent — web-search provider keys for the analyst's tools */}
              <Section title="Research agent (web search)">
                <Label
                  text="Firecrawl API key"
                  hint={settings.data?.has_firecrawl_key ? `set (${settings.data.firecrawl_key_hint})` : 'not set'}
                />
                <Field
                  value={firecrawlKey}
                  onChangeText={setFirecrawlKey}
                  placeholder={settings.data?.has_firecrawl_key ? 'Replace key…' : 'fc-…'}
                  secureTextEntry
                  autoCapitalize="none"
                />
                <Label
                  text="Parallel Search API key"
                  hint={settings.data?.has_parallel_key ? `set (${settings.data.parallel_key_hint})` : 'not set'}
                />
                <Field
                  value={parallelKey}
                  onChangeText={setParallelKey}
                  placeholder={settings.data?.has_parallel_key ? 'Replace key…' : 'Parallel API key'}
                  secureTextEntry
                  autoCapitalize="none"
                />
                <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
                  Lets the analyst search the web and read outside papers mid-discussion (author
                  info, adoption, follow-up work). It tries Firecrawl, then Parallel, then a
                  keyless fallback — so search works even with no key, and upgrades when a key
                  has credit. Reading your own project's papers needs no key.
                </Text>
              </Section>

              {/* Usage / cost for the active project — near the end, below configuration. */}
              <UsageSection />

              <Section title="Prompts">
                <PromptStatusPanel
                  prompts={prompts.data}
                  loading={prompts.isLoading}
                  error={prompts.isError}
                  refreshing={prompts.isFetching}
                  onRefresh={() => { void prompts.refetch(); }}
                  // Was `devMode` (RC_DEV), which staging and prod REFUSE TO BOOT with — so the
                  // named operator could not edit a prompt on either, the exact environments the
                  // operator role exists for. The server's own gate is RC_OPERATOR_USERS; match it.
                  editable={isOperator}
                  onSave={(key, value) => savePrompt.mutateAsync({ key, value })}
                  onReset={(key) => resetPrompt.mutateAsync({ key })}
                />
              </Section>

              {isOperator || canEditPrefs ? (
                <>
                  <Button
                    title="Save settings"
                    onPress={handleSaveSettings}
                    loading={saveSettings.isPending}
                    style={{ marginTop: space.sm }}
                  />
                  {saveSettings.isError ? (
                    <Text variant="caption" color={t.danger} style={{ marginTop: space.sm }}>
                      {(saveSettings.error as Error).message}
                    </Text>
                  ) : null}
                </>
              ) : null}
            </SharedWritableContext.Provider>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function fmtUsd(n: number): string {
  if (!n) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(2)}`;
}

const fmtNum = (n: number) => n.toLocaleString();

/** The active project's accumulated LLM spend (GET /api/projects/{pid}/usage). Read-only. */
function UsageSection() {
  const t = useTheme();
  const { activePid } = useActiveProject();
  const usage = useUsage(activePid);

  if (!activePid) {
    return (
      <Section title="Usage">
        <Text variant="caption" color={t.muted}>Open a project to see its LLM usage.</Text>
      </Section>
    );
  }
  return (
    <Section title="Usage (this project)">
      {usage.isLoading ? (
        <ActivityIndicator color={t.mint} />
      ) : usage.isError || !usage.data ? (
        <Text variant="caption" color={t.muted}>Usage unavailable.</Text>
      ) : (
        <UsageBody data={usage.data} />
      )}
    </Section>
  );
}

function UsageBody({ data }: { data: UsageSummary }) {
  // `t` is the usage total here (pre-existing binding), so the palette is read as `theme`.
  const theme = useTheme();
  const t = data.total;
  const ops = Object.entries(data.by_operation).sort(
    (a, b) => b[1].cost_nanousd - a[1].cost_nanousd,
  );
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm }}>
        <Text variant="heading" style={{ fontSize: 22 }}>
          {fmtUsd(t.cost_usd)}
        </Text>
        {data.estimated ? (
          <Text variant="caption" color={theme.muted}>
            estimated{data.pending_count ? ` · ${data.pending_count} pending` : ''}
          </Text>
        ) : null}
      </View>
      <Text variant="caption" color={theme.muted} style={{ marginTop: 2 }}>
        {fmtNum(t.total_tokens)} tokens · {fmtNum(t.calls)} calls
      </Text>

      {ops.length ? (
        <View style={{ marginTop: space.md, gap: 6 }}>
          {ops.map(([op, b]) => (
            <View key={op} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text variant="caption">{op.replace(/_/g, ' ')}</Text>
              <Text variant="caption" color={theme.muted}>
                {fmtNum(b.total_tokens)} tok · {fmtUsd(b.cost_usd)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {data.estimated ? (
        <Text variant="caption" color={theme.muted} style={{ marginTop: space.sm }}>
          Some billed streams ended before reporting cost, so the total is a lower bound.
        </Text>
      ) : null}
    </View>
  );
}

/** Disconnected placeholder row (Figma `08 · Settings / Connect`). */
function LockedRow({ label }: { label: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={styles.lockedRow}>
      <Text variant="heading">{label}</Text>
      <Text variant="caption">Locked until connected</Text>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text variant="label" style={{ marginBottom: space.sm }}>
        {title.toUpperCase()}
      </Text>
      <Card>{children}</Card>
    </View>
  );
}

function Label({ text, hint }: { text: string; hint?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6, marginTop: space.sm }}>
      <Text variant="heading">{text}</Text>
      {hint ? <Text variant="caption">{hint}</Text> : null}
    </View>
  );
}

/** A text input for a SHARED setting. Read-only whenever this user is not the operator — every
 *  Field on this screen edits instance-wide configuration, so there is no opt-out. */
function Field(props: React.ComponentProps<typeof TextInput>) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const writable = useContext(SharedWritableContext);
  return (
    <TextInput
      {...props}
      editable={writable && props.editable !== false}
      placeholderTextColor={t.muted}
      style={[styles.input, !writable && styles.inputReadOnly, props.style]}
    />
  );
}

/** `local` marks a toggle that writes DEVICE state (AsyncStorage) rather than instance settings —
 *  playback mode, theme, density, the map filter. Those stay usable by every reader. Anything
 *  without it is treated as shared and goes inert for non-operators. */
function Toggle({
  label,
  active,
  onPress,
  local = false,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  local?: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const writable = useContext(SharedWritableContext) || local;
  return (
    <Pressable
      onPress={writable ? onPress : undefined}
      disabled={!writable}
      accessibilityRole="radio"
      accessibilityState={{ checked: active, disabled: !writable }}
      style={[styles.toggle, active && styles.toggleActive, !writable && styles.controlReadOnly]}>
      <Text variant="heading" color={active ? t.mintInk : t.text}>
        {label}
      </Text>
    </Pressable>
  );
}

function ModelChips({
  models,
  selected,
  onPick,
}: {
  models: { label: string; id: string }[];
  selected: string;
  onPick: (id: string) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const writable = useContext(SharedWritableContext);
  if (models.length === 0) return null;
  return (
    // Still rendered when read-only: which model the instance is on is worth seeing even when you
    // cannot change it. Only the picking goes away.
    <View style={[styles.chips, !writable && styles.controlReadOnly]}>
      {models.map((m) => {
        const active = m.id === selected;
        return (
          <Pressable
            key={m.id}
            onPress={writable ? () => onPick(m.id) : undefined}
            disabled={!writable}
            hitSlop={6}
            accessibilityRole="radio"
            accessibilityState={{ checked: active, disabled: !writable }}
            style={[styles.modelChip, active && styles.modelChipActive]}>
            <Text variant="caption" color={active ? t.mint : t.muted}>
              {m.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (t: ThemePalette, density: DensityMode) => {
  const tight = density === 'tight';
  return StyleSheet.create({
  content: {
    padding: tight ? space.sm : space.md,
    paddingBottom: space.xxl * 2,
  },
  lockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
    paddingVertical: space.lg,
  },
  input: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: tight ? 10 : 12,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: tight ? 14 : 15,
  },
  // Read-only shared controls: dimmed and flattened so they read as "displayed" rather than
  // "broken". The value stays legible — knowing which model the instance runs on is useful even
  // when you cannot change it.
  inputReadOnly: { backgroundColor: t.bg, color: t.muted },
  controlReadOnly: { opacity: 0.55 },
  toggle: {
    flex: 1,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleActive: { backgroundColor: t.mint, borderColor: t.mint },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  modelChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
  },
  modelChipActive: { borderColor: t.mint, backgroundColor: t.mintWash },
  });
};
