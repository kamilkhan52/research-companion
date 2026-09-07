import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useAddPaper } from '@/api/queries';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
import { Icon, Text, ToneIcon, ToneSurface } from '@/ui';
import { useTheme, useThemedStyles, type DensityMode } from '@/theme/ThemeProvider';
import { control, fonts, radius, space, type ThemePalette } from '@/theme/tokens';

export function parseKnownPaper(value: string): {
  title: string;
  source: string | null;
  arxivId?: string;
  pdfUrl?: string;
} {
  const text = value.trim();
  const arxiv = text.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i)
    ?? text.match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/);
  if (arxiv) {
    return { title: `arXiv ${arxiv[1]}`, source: arxiv[1], arxivId: arxiv[1] };
  }
  if (/^https?:\/\//i.test(text)) {
    const tail = text.split('/').filter(Boolean).pop() ?? '';
    return {
      title: tail.replace(/\.pdf.*$/i, '').replace(/[-_]+/g, ' ').trim() || 'Linked paper',
      source: text,
      pdfUrl: text,
    };
  }
  return { title: text, source: null };
}

export function AddPaperInline({
  pid,
  autoFocus = false,
  showDivider = true,
  onNavigate,
}: {
  pid: string;
  autoFocus?: boolean;
  showDivider?: boolean;
  /** Close an owning sheet before this component pushes the new paper route. */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const inputRef = useRef<TextInput>(null);
  const addPaper = useAddPaper(pid);
  // Keep the legacy key when relocating this entry from Discover to Library: an unfinished
  // title/link draft follows the control instead of disappearing during the upgrade.
  const textDraft = usePersistedDraft(draftKey(pid, 'discover', 'specific-paper'), '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [autoFocus]);

  async function submit() {
    const parsed = parseKnownPaper(textDraft.value);
    if (!parsed.title) return;
    setError(null);
    await textDraft.markSubmitted();
    try {
      const result = await addPaper.mutateAsync({
        title: parsed.title,
        arxivId: parsed.arxivId,
        pdfUrl: parsed.pdfUrl,
        autoAnalyze: true,
      });
      if (!result.paper) return;
      await textDraft.clear('');
      const query = new URLSearchParams();
      query.set('autoStart', '1');
      if (parsed.source) query.set('source', parsed.source);
      onNavigate?.();
      router.push(`/paper/${encodeURIComponent(result.paper.slug)}?${query.toString()}`);
    } catch (e) {
      setError((e as Error).message ?? 'Could not add the paper.');
    }
  }

  return (
    <View style={styles.root}>
      {showDivider ? (
        <View style={styles.orRow}>
          <View style={styles.orLine} />
          <Text variant="overline" color={t.muted}>OR ADD DIRECTLY</Text>
          <View style={styles.orLine} />
        </View>
      ) : null}
      <View style={[styles.field, error && styles.fieldError]}>
        <ToneIcon name="link-2" tone={error ? 'danger' : 'violet'} compact />
        <TextInput
          ref={inputRef}
          value={textDraft.value}
          onChangeText={textDraft.setValue}
          style={styles.input}
          placeholder="Title, DOI, or arXiv link"
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={autoFocus}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          accessibilityLabel="Paper title, DOI, or arXiv link"
        />
        <Pressable
          onPress={() => void submit()}
          disabled={!textDraft.value.trim() || addPaper.isPending}
          accessibilityRole="button"
          accessibilityLabel="Add and start analysis"
          accessibilityState={{ disabled: !textDraft.value.trim() || addPaper.isPending, busy: addPaper.isPending }}
          style={({ pressed }) => [
            styles.action,
            textDraft.value.trim() && styles.actionReady,
            pressed && styles.actionPressed,
          ]}
        >
          {addPaper.isPending ? (
            <ActivityIndicator size="small" color={t.mintInk} />
          ) : (
            <>
              <Text variant="label" color={textDraft.value.trim() ? t.mintInk : t.muted} style={styles.actionLabel}>Add</Text>
              <Icon name="arrow-right" size={15} color={textDraft.value.trim() ? t.mintInk : t.muted} />
            </>
          )}
        </Pressable>
      </View>
      {error ? (
        <ToneSurface tone="danger" style={styles.errorBox} accessibilityLiveRegion="polite">
          <Icon name="alert-circle" size={16} color={t.danger} />
          <Text variant="caption" color={t.danger} style={styles.errorText}>{error}</Text>
        </ToneSurface>
      ) : null}
    </View>
  );
}

const makeStyles = (t: ThemePalette, density: DensityMode) => StyleSheet.create({
  root: { marginTop: space.md },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.md },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: t.line2 },
  field: {
    minHeight: density === 'tight' ? 52 : 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    paddingLeft: density === 'tight' ? space.sm : space.md,
    paddingRight: space.xs,
  },
  fieldError: { borderColor: t.danger },
  input: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    paddingVertical: space.sm,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: density === 'tight' ? 14 : 15,
  },
  action: {
    minWidth: 72,
    height: control.minTouch,
    borderRadius: radius.md - 2,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  actionReady: { backgroundColor: t.mint, borderColor: t.mint },
  actionPressed: { opacity: 0.82 },
  actionLabel: { fontFamily: fonts.bodySemiBold },
  errorBox: {
    marginTop: space.sm,
    padding: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  errorText: { flex: 1, minWidth: 0 },
});
