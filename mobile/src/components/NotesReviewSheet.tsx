// End-of-chat notes review (R.11). When a discussion reaches notes_drafted, the analyst has
// PROPOSED a Notes block for this paper plus a rewrite of the working notes. This full-screen
// surface fetches that proposal (GET /review/{slug}), lets the reader read it in full and edit
// either part inline (view markdown ↔ raw editor, same shape as the Notes screen), then commit
// with "Approve & commit" — carrying the proposal_revision token so a branch switch or
// regeneration since load is refused (409) instead of silently committing stale text.
// Agent proposes, human commits (CLAUDE.md invariant 4).

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Modal, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { approve as approveCommit } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import type { StreamItem } from '@/api/types';
import { useNotes, useReview } from '@/api/queries';
import { AgentActivity } from '@/components/AgentActivity';
import { ProgressSteps } from '@/components/ProgressSteps';
import { finishSteps } from '@/lib/finishSteps';
import { scholarSearchUrl, titleFromRcSearchLink } from '@/lib/paperLinks';
import { draftedWordCount, NotesDiff } from '@/components/NotesDiff';
import { Markdown } from '@/components/Markdown';
import { Button, Card, IconButton, Screen, Text, ToneIcon, ToneSurface } from '@/ui';
import { useTheme, useThemedStyles, type DensityMode } from '@/theme/ThemeProvider';
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
  requestPhase = null,
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
  /** DR-056: the redraft's marker phase — stages the requesting panel like the Finish
   *  card. The sheet stays open during Request changes, so this is where the stages
   *  must live to be seen. */
  requestPhase?: 'notes' | 'synthesis' | null;
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
      return;
    }
    // DR-054: no sourceable URL for this one — fall back to a title search, same target the
    // discussion's ExternalRefSheet offers for the same link (this view has no "add" sheet).
    const searchTitle = titleFromRcSearchLink(href);
    if (searchTitle) {
      void Linking.openURL(scholarSearchUrl(searchTitle)).catch(() => undefined);
      return;
    }
    if (/^https?:\/\//i.test(href)) {
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
            <ToneSurface tone="neutral" style={styles.loadCard}>
              <ToneIcon name="file-text" />
              <Text variant="heading" style={styles.loadTitle}>The proposal is taking a moment</Text>
              <Text variant="body" color={t.muted} style={styles.loadBody}>
                Nothing has been committed. Try loading the review again.
              </Text>
              <Button title="Try again" variant="ghost" onPress={() => void review.refetch()} style={styles.loadAction} />
            </ToneSurface>
          </View>
        ) : (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
              <View style={styles.intro}>
                <Text variant="overline" color={t.violet}>PROPOSED CHANGES</Text>
                <Text variant="serifTitle" style={styles.paperTitle}>{data.title}</Text>
                <Text variant="body" color={t.muted} style={styles.introBody}>
                  Read what changed. Nothing joins the project until you approve it.
                </Text>
              </View>

              {requesting ? (
                <>
                  <ProgressSteps
                    dotSize={20}
                    style={styles.requestSteps}
                    steps={finishSteps(requestPhase ?? 'drafting')}
                  />
                  <AgentActivity
                    emphasis="panel"
                    status={requestActivity}
                    detail={words > 0 ? `${words} words drafted` : undefined}
                    testID="notes-review-activity"
                  />
                </>
              ) : null}

              <ReviewSection
                icon="file-text"
                title="Notes for this paper"
                description="What this paper contributes on its own."
              >
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
              </ReviewSection>

              {data.plan?.trim() ? (
                <ReviewSection
                  icon="git-branch"
                  title="Change plan"
                  description="The editor's stated intent — judge the working-notes diff against it."
                >
                  <Markdown text={data.plan} />
                </ReviewSection>
              ) : null}

              <ReviewSection
                icon="layers"
                title="Working notes"
                description="The proposed rewrite of your working notes — the synthesis across everything read so far."
              >
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
              </ReviewSection>

              {error ? (
                <ToneSurface tone="danger" style={styles.errorBox}>
                  <ToneIcon name="alert-circle" tone="danger" compact />
                  <Text variant="body" color={t.danger} style={styles.errorText}>{error}</Text>
                </ToneSurface>
              ) : null}

              <Card style={styles.actionCard}>
                <Text variant="overline" color={t.muted}>FINISH REVIEW</Text>
                <Text variant="body" color={t.muted} style={styles.actionIntro}>
                  Approve these changes, or keep the proposal open and ask for another pass.
                </Text>
                {requestOpen ? (
                  <ToneSurface tone="neutral" style={styles.requestBox}>
                    <Text variant="heading">What should change?</Text>
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
                  </ToneSurface>
                ) : null}
                <Button
                  title={busy ? 'Committing…' : 'Approve & commit'}
                  icon="check"
                  onPress={() => void commit()}
                  loading={busy}
                  disabled={busy || requesting}
                  style={styles.approveButton}
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
              </Card>
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </Screen>
    </Modal>
  );
}

function ReviewSection({
  icon,
  title,
  description,
  children,
}: {
  icon: 'file-text' | 'layers' | 'git-branch';
  title: string;
  description: string;
  children: ReactNode;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={styles.reviewSection}>
      <View style={styles.sectionHeader}>
        <ToneIcon name={icon} tone="violet" compact />
        <View style={styles.sectionCopy}>
          <Text variant="heading">{title}</Text>
          <Text variant="caption" color={t.muted} style={styles.sectionDescription}>{description}</Text>
        </View>
      </View>
      <View style={styles.sectionContent}>{children}</View>
    </Card>
  );
}

const makeStyles = (t: ThemePalette, density: DensityMode) => StyleSheet.create({
  requestSteps: { marginBottom: space.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.line,
  },
  body: {
    padding: density === 'tight' ? space.md : space.lg,
    gap: density === 'tight' ? space.md : space.lg,
    paddingBottom: space.xxl,
  },
  intro: { paddingHorizontal: space.xs },
  paperTitle: { marginTop: space.xs },
  introBody: { marginTop: space.xs },
  reviewSection: { padding: density === 'tight' ? space.md : space.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  sectionCopy: { flex: 1, minWidth: 0 },
  sectionDescription: { marginTop: 2 },
  sectionContent: { marginTop: space.md },
  actionCard: { backgroundColor: t.elevated },
  actionIntro: { marginTop: space.xs },
  requestBox: { gap: space.sm, marginTop: space.lg, padding: space.md },
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
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  errorText: { flex: 1, minWidth: 0 },
  approveButton: { marginTop: space.lg },
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
    fontSize: density === 'tight' ? 14 : 15,
    lineHeight: density === 'tight' ? 21 : 23,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  loadCard: { width: '100%', maxWidth: 360 },
  loadTitle: { marginTop: space.md },
  loadBody: { marginTop: space.xs },
  loadAction: { marginTop: space.lg },
});
