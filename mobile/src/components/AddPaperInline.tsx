import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { useAddPaper } from '@/api/queries';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
import { Button, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

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
}: {
  pid: string;
  autoFocus?: boolean;
  showDivider?: boolean;
}) {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const inputRef = useRef<TextInput>(null);
  const addPaper = useAddPaper(pid);
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
          <Text variant="overline" color={t.muted}>or</Text>
          <View style={styles.orLine} />
        </View>
      ) : null}
      <TextInput
        ref={inputRef}
        value={textDraft.value}
        onChangeText={textDraft.setValue}
        style={styles.input}
        placeholder="Add a paper you already know — title, DOI, or arXiv link"
        placeholderTextColor={t.muted}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        accessibilityLabel="Paper title, DOI, or arXiv link"
      />
      {textDraft.value.trim() ? (
        <Button
          title="Add and start analysis"
          variant="ghost"
          onPress={() => void submit()}
          loading={addPaper.isPending}
          style={styles.action}
        />
      ) : null}
      {error ? <Text variant="caption" color={t.danger}>{error}</Text> : null}
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  root: { marginTop: space.md },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: t.line2 },
  input: {
    minHeight: 48,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 15,
  },
  action: { marginTop: space.xs, minHeight: 48 },
});
