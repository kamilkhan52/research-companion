import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { PromptStatus } from '@/api/types';
import { Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

export function PromptStatusPanel({
  prompts,
  loading,
  error,
  refreshing,
  onRefresh,
  editable = false,
  onSave,
  onReset,
}: {
  prompts: PromptStatus[] | undefined;
  loading: boolean;
  error: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  /** When true (RC_DEV), each editable prompt can be edited in-app. Off by default. */
  editable?: boolean;
  onSave?: (key: string, value: string) => Promise<unknown> | void;
  onReset?: (key: string) => Promise<unknown> | void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="caption" color={t.muted}>
        {editable
          ? 'Tap a prompt to view its active text; edit it inline and Save to override, or Reset '
            + 'to the default. Managed prompts stay file-only. The Markdown files remain '
            + 'authoritative — edit those in Obsidian for permanent changes.'
          : 'Tap a prompt to view its active text. This screen is read-only; edit the Markdown '
            + 'files in Obsidian. It reports the exact server path and the active version.'}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={refreshing}
        onPress={onRefresh}
        style={({ pressed }) => [styles.refresh, pressed && styles.pressed]}>
        <Text variant="heading" color={t.mint}>
          {refreshing ? 'Refreshing…' : 'Refresh prompt status'}
        </Text>
      </Pressable>

      {loading ? <ActivityIndicator testID="prompt-status-loading" color={t.mint} /> : null}
      {error ? (
        <Text variant="caption" color={t.danger}>
          Prompt status unavailable. Check the server connection and try again.
        </Text>
      ) : null}
      {!loading && !error && prompts?.length === 0 ? (
        <Text variant="caption" color={t.muted}>No prompts reported by the server.</Text>
      ) : null}

      {prompts?.map((prompt) => (
        <PromptRow
          key={prompt.key}
          prompt={prompt}
          editable={editable}
          onSave={onSave}
          onReset={onReset}
        />
      ))}
    </View>
  );
}

function PromptRow({
  prompt,
  editable,
  onSave,
  onReset,
}: {
  prompt: PromptStatus;
  editable: boolean;
  onSave?: (key: string, value: string) => Promise<unknown> | void;
  onReset?: (key: string) => Promise<unknown> | void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(prompt.value);
  const [busy, setBusy] = useState(false);
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // The server can edit a prompt only when it isn't managed (managed ones are file-only).
  const canEdit = editable && !prompt.managed && !!onSave;

  async function run(action: () => Promise<unknown> | void) {
    setBusy(true);
    try {
      await action();
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`${prompt.label}, ${expanded ? 'collapse' : 'expand'}`}
        style={styles.header}>
        <Text variant="heading" style={styles.label}>{prompt.label}</Text>
        <Text
          variant="caption"
          color={prompt.valid ? t.mint : t.danger}
          accessibilityLabel={`${prompt.label}: ${prompt.valid ? 'valid' : 'invalid'}`}>
          {prompt.valid ? 'VALID' : 'INVALID'}
        </Text>
      </Pressable>
      <Text variant="caption" color={t.muted}>
        Active source: {prompt.source.replace(/_/g, ' ')}
        {prompt.is_overridden ? ' · overridden' : ''}
      </Text>
      <Text variant="caption" selectable style={styles.path}>
        {prompt.path ?? `Bundled in server · ${prompt.relative_path}`}
      </Text>
      {prompt.error ? (
        <Text variant="caption" color={t.danger} style={styles.error}>
          {prompt.error}
        </Text>
      ) : null}
      <Text variant="caption" color={t.muted} style={styles.hash}>
        SHA-256 {prompt.effective_hash.slice(0, 12)}
        {prompt.modified_at ? ` · modified ${prompt.modified_at}` : ''}
      </Text>

      {expanded ? (
        editing ? (
          <>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              editable={!busy}
              style={styles.editor}
              textAlignVertical="top"
              autoCapitalize="none"
            />
            <View style={styles.actions}>
              <PanelButton
                label={busy ? 'Saving…' : 'Save override'}
                disabled={busy || draft === prompt.value}
                onPress={() => onSave && run(() => onSave(prompt.key, draft))}
              />
              <PanelButton
                label="Cancel"
                variant="ghost"
                disabled={busy}
                onPress={() => { setDraft(prompt.value); setEditing(false); }}
              />
            </View>
          </>
        ) : (
          <>
            <Text variant="caption" selectable style={styles.body}>{prompt.value}</Text>
            {canEdit ? (
              <View style={styles.actions}>
                <PanelButton label="Edit" onPress={() => { setDraft(prompt.value); setEditing(true); }} />
                {prompt.is_overridden ? (
                  <PanelButton
                    label={busy ? 'Resetting…' : 'Reset to default'}
                    variant="ghost"
                    disabled={busy}
                    onPress={() => onReset && run(() => onReset(prompt.key))}
                  />
                ) : null}
              </View>
            ) : editable && prompt.managed ? (
              <Text variant="caption" color={t.muted} style={styles.managedNote}>
                Managed prompt — edit its Markdown file directly.
              </Text>
            ) : null}
          </>
        )
      ) : null}
    </View>
  );
}

function PanelButton({
  label,
  onPress,
  variant = 'solid',
  disabled,
}: {
  label: string;
  onPress: () => void;
  variant?: 'solid' | 'ghost';
  disabled?: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        variant === 'ghost' ? styles.btnGhost : styles.btnSolid,
        (pressed || disabled) && { opacity: 0.6 },
      ]}>
      <Text variant="label" color={variant === 'ghost' ? t.muted : t.mintInk}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  refresh: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.elevated,
  },
  pressed: { opacity: 0.82 },
  row: {
    borderTopWidth: 1,
    borderTopColor: t.line,
    paddingTop: space.md,
    marginTop: space.md,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  label: { flex: 1 },
  path: { marginTop: space.sm, fontSize: 11.5 },
  error: { marginTop: space.sm },
  hash: { marginTop: space.sm, fontSize: 11 },
  body: {
    marginTop: space.md,
    fontFamily: fonts.body,
    fontSize: 12.5,
    lineHeight: 18,
    color: t.text,
  },
  editor: {
    marginTop: space.md,
    minHeight: 160,
    padding: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.surface,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 12.5,
  },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  btn: {
    minHeight: 40,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  btnSolid: { backgroundColor: t.mint },
  btnGhost: { borderWidth: 1, borderColor: t.line2 },
  managedNote: { marginTop: space.md },
});
