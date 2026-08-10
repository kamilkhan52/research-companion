// End-of-chat notes review (R.11). When a discussion reaches notes_drafted, the analyst has
// PROPOSED a Notes block for this paper plus an updated project synthesis. This full-screen
// surface fetches that proposal (GET /review/{slug}), lets the reader read it in full and edit
// either part inline (view markdown ↔ raw editor, same shape as the Notes screen), then commit
// with "Approve & commit" — carrying the proposal_revision token so a branch switch or
// regeneration since load is refused (409) instead of silently committing stale text.
// Agent proposes, human commits (CLAUDE.md invariant 4).

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { approve as approveCommit } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import type { StreamItem } from '@/api/types';
import { useNotes, useReview } from '@/api/queries';
import { AgentActivity } from '@/components/AgentActivity';
import { draftedWordCount, NotesDiff } from '@/components/NotesDiff';
import { Button, IconButton, Screen, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

export function NotesReviewSheet({
  visible,
  pid,
  slug,
  threadId = 'main',
  onClose,
  onCommitted,
  onRequestEdits,
  requesting = false,
  requestActivity = 'Reviewing notes…',
  requestItems = [],
  refreshNonce = 0,
}: {
  visible: boolean;
  pid: string;
  slug: string;
  threadId?: string;
  onClose: () => void;
  onCommitted: () => void;
  onRequestEdits?: (instruction: string) => Promise<void>;
  requesting?: boolean;
  requestActivity?: string;
  requestItems?: StreamItem[];
  refreshNonce?: number;
}) {
  const t = useTheme();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const review = useReview(pid, slug, visible, threadId);
  const currentNotes = useNotes(visible ? pid : null, visible ? slug : null);
  const data = review.data;

  const [notes, setNotes] = useState('');
  const [synthesis, setSynthesis] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const previousRefresh = useRef(refreshNonce);

  // Seed the editable drafts whenever a fresh proposal loads (a new revision replaces old edits
  // — the previous draft was reviewed against a proposal that no longer exists).
  useEffect(() => {
    if (data) {
      setNotes(data.notes_block);
      setSynthesis(data.synthesis_proposed);
      setEditing(false);
      setError(null);
      setRequestOpen(false);
      setInstruction('');
    }
  }, [data?.proposal_revision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (refreshNonce !== previousRefresh.current) {
      previousRefresh.current = refreshNonce;
      if (visible) void review.refetch();
    }
  }, [refreshNonce, review.refetch, visible]);

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

  async function requestEdits() {
    const text = instruction.trim();
    if (!text || !onRequestEdits) return;
    setError(null);
    try {
      await onRequestEdits(text);
    } catch (e) {
      setError((e as Error).message ?? 'Could not request those edits.');
    }
  }

  const words = draftedWordCount(requestItems);
  const openProposalLink = (href: string) => {
    if (href.startsWith('rc-paper:')) {
      const target = href.slice('rc-paper:'.length);
      if (target) router.push(`/paper/${encodeURIComponent(target)}`);
    } else if (/^https?:\/\//i.test(href)) {
      void Linking.openURL(href).catch(() => undefined);
    }
  };

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

              {requesting ? (
                <AgentActivity
                  emphasis="panel"
                  status={requestActivity}
                  detail={words > 0 ? `${words} words drafted` : undefined}
                  testID="notes-review-activity"
                />
              ) : null}

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
              ) : currentNotes.isLoading ? (
                <ActivityIndicator color={t.mint} />
              ) : (
                <NotesDiff
                  before={currentNotes.data?.markdown ?? ''}
                  after={notes}
                  onLinkPress={openProposalLink}
                />
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
                <NotesDiff
                  before={data.synthesis_current}
                  after={synthesis}
                  onLinkPress={openProposalLink}
                />
              )}

              {requestOpen ? (
                <View style={styles.requestBox}>
                  <Text variant="label">What should change?</Text>
                  <TextInput
                    value={instruction}
                    onChangeText={setInstruction}
                    placeholder="Tell the analyst what to revise…"
                    placeholderTextColor={t.muted}
                    multiline
                    autoFocus
                    editable={!requesting}
                    style={styles.requestInput}
                    selectionColor={t.mint}
                  />
                  <Button
                    title={requesting ? 'Requesting…' : 'Send edit request'}
                    onPress={() => void requestEdits()}
                    disabled={requesting || !instruction.trim()}
                    loading={requesting}
                  />
                </View>
              ) : null}

              {error ? (
                <Text variant="caption" color={t.danger} style={{ marginTop: space.md }}>{error}</Text>
              ) : null}

              <Button
                title={busy ? 'Committing…' : 'Approve & commit'}
                icon="check"
                onPress={() => void commit()}
                loading={busy}
                disabled={busy || requesting}
                style={{ marginTop: space.lg }}
              />
              {onRequestEdits ? (
                <Button
                  title="Request edits"
                  variant="ghost"
                  onPress={() => setRequestOpen(true)}
                  disabled={busy || requesting || requestOpen}
                  style={styles.secondaryButton}
                />
              ) : null}
              <Button title="Cancel" variant="ghost" onPress={onClose} disabled={busy || requesting} />
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
  requestBox: { gap: space.sm, marginTop: space.md },
  requestInput: {
    minHeight: 88,
    maxHeight: 180,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.surface,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 22,
  },
  secondaryButton: { borderWidth: 1, borderColor: t.line2 },
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
