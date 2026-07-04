// Settings — server connection plus the backend's own settings (keys, models, speech). The
// server URL is stored locally (config.ts); everything else is persisted server-side via
// /api/settings so web and mobile share one configuration.

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
import { useFavoriteModels, useSaveSettings, useSettings, useUsage } from '@/api/queries';
import type { UsageSummary } from '@/api/types';
import { TopBar } from '@/components/TopBar';
import { useActiveProject } from '@/store/project';
import { Button, Card, Screen, Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

export default function SettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const [url, setUrl] = useState(getBaseUrl());
  const [savingUrl, setSavingUrl] = useState(false);

  const settings = useSettings();
  const favorites = useFavoriteModels();
  const saveSettings = useSaveSettings();

  // Local editable copies of server-side settings.
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [narrationModel, setNarrationModel] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [parallelKey, setParallelKey] = useState('');
  const [firecrawlKey, setFirecrawlKey] = useState('');
  const [voice, setVoice] = useState('');
  const [speechProvider, setSpeechProvider] = useState<'openai' | 'browser'>('openai');
  const [priorScope, setPriorScope] = useState<'related' | 'all'>('related');

  // Sync local fields from the server exactly once, on first successful load — NOT on every
  // settings.data change. A background refetch (e.g. right after saveSettings invalidates the
  // query) would otherwise re-fire this and silently overwrite whatever the user is mid-typing
  // into model/narrationModel/voice with the last-saved server values.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (settings.data && !initializedRef.current) {
      setModel(settings.data.model ?? '');
      setNarrationModel(settings.data.narration_model ?? '');
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
    const payload: Record<string, unknown> = {
      model: model || null,
      narration_model: narrationModel || null,
      speech_provider: speechProvider,
      tts_voice: voice || null,
      prior_notes_scope: priorScope,
    };
    if (apiKey.trim()) payload.openrouter_api_key = apiKey.trim();
    if (openaiKey.trim()) payload.openai_api_key = openaiKey.trim();
    if (parallelKey.trim()) payload.parallel_api_key = parallelKey.trim();
    if (firecrawlKey.trim()) payload.firecrawl_api_key = firecrawlKey.trim();
    await saveSettings.mutateAsync(payload);
    setApiKey('');
    setOpenaiKey('');
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
          <Section title="Server">
            <Text variant="caption" style={{ marginBottom: space.sm }}>
              Your backend URL — the Cloudflare tunnel link (e.g. https://name.trycloudflare.com).
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

          {!hasBaseUrl() ? (
            <Text variant="caption" style={{ textAlign: 'center', marginTop: space.lg }}>
              Set a server URL above to configure analysis and audio.
            </Text>
          ) : settings.isLoading ? (
            <ActivityIndicator color={colors.cyan} style={{ paddingVertical: space.xl }} />
          ) : settings.isError ? (
            <Text variant="caption" color={colors.danger} style={{ textAlign: 'center', marginTop: space.lg }}>
              Couldn't reach the server. Check the URL and that the backend is running.
            </Text>
          ) : (
            <>
              {/* Usage / cost for the active project */}
              <UsageSection />

              {/* Analysis */}
              <Section title="Analysis">
                <Label text="OpenRouter API key" hint={settings.data?.has_key ? `set (${settings.data.key_hint})` : 'not set'} />
                <Field
                  value={apiKey}
                  onChangeText={setApiKey}
                  placeholder={settings.data?.has_key ? 'Replace key…' : 'sk-or-…'}
                  secureTextEntry
                  autoCapitalize="none"
                />

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

                <Label text="Prior notes in paper context" />
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Toggle label="Related papers" active={priorScope === 'related'} onPress={() => setPriorScope('related')} />
                  <Toggle label="All read papers" active={priorScope === 'all'} onPress={() => setPriorScope('all')} />
                </View>
                <Text variant="caption" color={colors.muted} style={{ marginTop: space.xs }}>
                  Which per-paper Notes the analyst sees during a discussion. "All read papers"
                  gives the fullest cross-paper grounding for a single project; "Related" keeps
                  the context smaller by including only citation-related papers.
                </Text>
              </Section>

              {/* Audio */}
              <Section title="Audio">
                <Label text="Speech provider" />
                <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.md }}>
                  <Toggle label="OpenAI" active={speechProvider === 'openai'} onPress={() => setSpeechProvider('openai')} />
                  <Toggle label="Browser" active={speechProvider === 'browser'} onPress={() => setSpeechProvider('browser')} />
                </View>

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
                    <Label text="Voice" />
                    <ModelChips
                      models={(settings.data?.voices ?? []).map((v) => ({ label: v, id: v }))}
                      selected={voice}
                      onPick={setVoice}
                    />
                  </>
                ) : null}
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
                <Text variant="caption" color={colors.muted} style={{ marginTop: space.xs }}>
                  Lets the analyst search the web and read outside papers mid-discussion (author
                  info, adoption, follow-up work). It tries Firecrawl, then Parallel, then a
                  keyless fallback — so search works even with no key, and upgrades when a key
                  has credit. Reading your own project's papers needs no key.
                </Text>
              </Section>

              <Button
                title="Save settings"
                onPress={handleSaveSettings}
                loading={saveSettings.isPending}
                style={{ marginTop: space.sm }}
              />
              {saveSettings.isError ? (
                <Text variant="caption" color={colors.danger} style={{ marginTop: space.sm }}>
                  {(saveSettings.error as Error).message}
                </Text>
              ) : null}
            </>
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
  const { activePid } = useActiveProject();
  const usage = useUsage(activePid);

  if (!activePid) {
    return (
      <Section title="Usage">
        <Text variant="caption" color={colors.muted}>Open a project to see its LLM usage.</Text>
      </Section>
    );
  }
  return (
    <Section title="Usage (this project)">
      {usage.isLoading ? (
        <ActivityIndicator color={colors.cyan} />
      ) : usage.isError || !usage.data ? (
        <Text variant="caption" color={colors.muted}>Usage unavailable.</Text>
      ) : (
        <UsageBody data={usage.data} />
      )}
    </Section>
  );
}

function UsageBody({ data }: { data: UsageSummary }) {
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
          <Text variant="caption" color={colors.muted}>
            estimated{data.pending_count ? ` · ${data.pending_count} pending` : ''}
          </Text>
        ) : null}
      </View>
      <Text variant="caption" color={colors.muted} style={{ marginTop: 2 }}>
        {fmtNum(t.total_tokens)} tokens · {fmtNum(t.calls)} calls
      </Text>

      {ops.length ? (
        <View style={{ marginTop: space.md, gap: 6 }}>
          {ops.map(([op, b]) => (
            <View key={op} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text variant="caption">{op.replace(/_/g, ' ')}</Text>
              <Text variant="caption" color={colors.muted}>
                {fmtNum(b.total_tokens)} tok · {fmtUsd(b.cost_usd)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {data.estimated ? (
        <Text variant="caption" color={colors.muted} style={{ marginTop: space.sm }}>
          Some billed streams ended before reporting cost, so the total is a lower bound.
        </Text>
      ) : null}
    </View>
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

function Field(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      {...props}
      placeholderTextColor={colors.muted}
      style={[styles.input, props.style]}
    />
  );
}

function Toggle({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      style={[styles.toggle, active && styles.toggleActive]}>
      <Text variant="heading" color={active ? colors.cyanInk : colors.text}>
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
  if (models.length === 0) return null;
  return (
    <View style={styles.chips}>
      {models.map((m) => {
        const active = m.id === selected;
        return (
          <Pressable
            key={m.id}
            onPress={() => onPick(m.id)}
            hitSlop={6}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            style={[styles.modelChip, active && styles.modelChipActive]}>
            <Text variant="caption" color={active ? colors.cyan : colors.muted}>
              {m.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.md, paddingBottom: space.xxl * 2 },
  input: {
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    color: colors.text,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
  },
  toggle: {
    flex: 1,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleActive: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  modelChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line2,
  },
  modelChipActive: { borderColor: colors.cyan },
});
