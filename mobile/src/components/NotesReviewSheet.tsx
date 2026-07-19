// End-of-chat notes review (R.11). When a discussion reaches notes_drafted, the analyst has
// PROPOSED a Notes block for this paper plus an updated project synthesis. This full-screen
// surface fetches that proposal (GET /review/{slug}), lets the reader read it in full and edit
// either part inline (view markdown ↔ raw editor, same shape as the Notes screen), then commit
// with "Approve & commit" — carrying the proposal_revision token so a branch switch or
// regeneration since load is refused (409) instead of silently committing stale text.
// Agent proposes, human commits (CLAUDE.md invariant 4).

import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { approve as approveCommit } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { useReview } from '@/api/queries';
import { Markdown } from '@/components/Markdown';
import { Button, Card, IconButton, Screen, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

export function NotesReviewSheet({
  visible,
  pid,
  slug,
  threadId = 'main',
  onClose,
  onCommitted,
}: {
  visible: boolean;
  pid: string;
  slug: string;
  threadId?: string;
  onClose: () => void;
  onCommitted: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const review = useReview(pid, slug, visible, threadId);
  const data = review.data;

  const [notes, setNotes] = useState('');
  const [synthesis, setSynthesis] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the editable drafts whenever a fresh proposal loads (a new revision replaces old edits
  // — the previous draft was reviewed against a proposal that no longer exists).
  useEffect(() => {
    if (data) {
      setNotes(data.notes_block);
      setSynthesis(data.synthesis_proposed);
      setEditing(false);
      setError(null);
    }
  }, [data?.proposal_revision]); // eslint-disable-line react-hooks/exhaustive-deps

  async function commit() {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      await approveCommit(pid, slug, {
        ...(threadId === 'main' ? {} : { thread_id: threadId }),
        notes_block: notes,
        synthesis,
        summary: data.summary,
        proposal_revision: data.proposal_revision,
      });
      onCommitted();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError('The proposal changed since you opened this review (a retry or branch switch). '
          + 'Reload to see the current version before approving.');
      } else {
        setError((e as Error).message ?? 'Could not commit the notes.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <Screen edges={['top']}>
        <View style={styles.header}>
          <IconButton name="x" accessibilityLabel="Close review" onPress={onClose} />
          <Text variant="heading" style={{ flex: 1 }} numberOfLines={1}>Review notes</Text>
          <IconButton
            name={editing ? 'check' : 'edit-2'}
            accessibilityLabel={editing ? 'Done editing' : 'Edit'}
            color={t.mint}
            onPress={() => setEditing((v) => !v)}
            disabled={!data}
          />
        </View>

        {review.isLoading ? (
          <View style={styles.centered}><ActivityIndicator color={t.mint} /></View>
        ) : review.isError || !data ? (
          <View style={styles.centered}>
            <Text variant="caption" color={t.muted} style={{ textAlign: 'center' }}>
              Could not load the proposed notes.
            </Text>
            <Button title="Retry" variant="ghost" onPress={() => void review.refetch()} />
          </View>
        ) : (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
              <Text variant="serifTitle">{data.title}</Text>

              <Text variant="overline" style={styles.sectionLabel}>Notes for this paper</Text>
              {editing ? (
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  multiline
                  editable={!busy}
                  style={styles.editor}
                  textAlignVertical="top"
                />
              ) : (
                <Card style={styles.viewCard}><Markdown text={notes || '_No notes proposed._'} /></Card>
              )}

              <Text variant="overline" style={styles.sectionLabel}>Project synthesis</Text>
              {editing ? (
                <TextInput
                  value={synthesis}
                  onChangeText={setSynthesis}
                  multiline
                  editable={!busy}
                  style={styles.editor}
                  textAlignVertical="top"
                />
              ) : (
                <Card style={styles.viewCard}>
                  <Markdown text={synthesis || '_No synthesis change proposed._'} />
                </Card>
              )}

              {error ? (
                <Text variant="caption" color={t.danger} style={{ marginTop: space.md }}>{error}</Text>
              ) : null}

              <Button
                title={busy ? 'Committing…' : 'Approve & commit'}
                icon="check"
                onPress={() => void commit()}
                loading={busy}
                disabled={busy}
                style={{ marginTop: space.lg }}
              />
              <Button title="Cancel" variant="ghost" onPress={onClose} disabled={busy} />
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </Screen>
    </Modal>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.line,
  },
  body: { padding: space.lg, gap: space.sm, paddingBottom: space.xxl },
  sectionLabel: { marginTop: space.md },
  viewCard: { padding: space.md },
  editor: {
    minHeight: 180,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.surface,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 21,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
});
