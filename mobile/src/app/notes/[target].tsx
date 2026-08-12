// Notes — view and edit one committed notes document: a paper's Notes block, or the
// cross-paper working notes (target === 'working'). Three ways in, one focused screen:
//   view  — the markdown rendered for reading (the default; this is a reading surface first)
//   edit  — the raw markdown in a plain editor; Save commits it to the project's git record
//   agent — a natural-language instruction runs server-side as a background job (job+poll,
//           reusing the analyst's research tools); the revision comes back as a PROPOSAL
//           rendered for review, applied only on explicit Apply. Agent proposes, human commits.

import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { saveNotes } from '@/api/endpoints';
import { keys, useNotes, useProjectState } from '@/api/queries';
import type { StreamItem } from '@/api/types';
import { Markdown } from '@/components/Markdown';
import { AgentActivity } from '@/components/AgentActivity';
import { draftedWordCount, notesAgentPhase, NotesDiff } from '@/components/NotesDiff';
import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';
import { TopBar } from '@/components/TopBar';
import { useNotesAgent } from '@/hooks/useNotesAgent';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
import { useActiveProject } from '@/store/project';
import { fullPaperUrl, scholarSearchUrl, titleFromRcSearchLink } from '@/lib/paperLinks';
import { Button, Card, Icon, IconButton, Screen, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

type Mode = 'view' | 'edit';
type ProposalRef = {
  baseRevision: string;
  jobId: string;
  summary: string;
};
type NotesEditDraft = {
  markdown: string;
  proposal: ProposalRef | null;
};

export default function NotesScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // Also mounted as the Notes tab (no route param), which shows the project-level synthesis.
  const { target: targetParam } = useLocalSearchParams<{ target?: string }>();
  const target = targetParam ?? 'working';
  const { activePid: pid } = useActiveProject();

  const notes = useNotes(pid, target ?? null);
  const projectState = useProjectState(pid);
  const agent = useNotesAgent(pid, target ?? null);
  // `string` remains in the read type to migrate drafts written by earlier app versions.
  const editDraft = usePersistedDraft<NotesEditDraft | string | null>(
    pid && target ? draftKey(pid, 'notes', target, 'manual-edit') : null,
    null,
  );
  const instructionDraft = usePersistedDraft(
    pid && target ? draftKey(pid, 'notes', target, 'agent-instruction') : null,
    '',
  );

  const [mode, setMode] = useState<Mode>('view');
  const draft = typeof editDraft.value === 'string'
    ? editDraft.value
    : editDraft.value?.markdown ?? null;
  const editingProposal = typeof editDraft.value === 'object'
    ? editDraft.value?.proposal ?? null
    : null;
  const setDraft = (next: string) => {
    editDraft.setValue({
      markdown: next,
      proposal: editingProposal,
    });
  };
  const [asking, setAsking] = useState(false);              // instruction composer open
  const instruction = instructionDraft.value;
  const setInstruction = instructionDraft.setValue;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const markdown = notes.data?.markdown ?? '';
  const title = notes.data?.title ?? (target === 'working' ? 'Working notes' : 'Notes');
  const paper = target === 'working' ? undefined : projectState.data?.papers.find((item) => item.slug === target);
  const paperUrl = paper ? fullPaperUrl(paper) : null;
  const openProposalLink = (href: string) => {
    if (href.startsWith('rc-paper:')) {
      const slug = href.slice('rc-paper:'.length);
      if (slug) router.push(`/paper/${encodeURIComponent(slug)}`);
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

  // This tab stays mounted across project switches. Keep local editor/proposal metadata scoped
  // to the active document; persisted drafts reload from their own project-keyed storage below.
  useEffect(() => {
    setMode('view');
    setAsking(false);
    setSaveError(null);
  }, [pid, target]);

  // Reattach to an agent edit already in flight for this document (navigated away and back).
  useEffect(() => {
    void agent.resume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, target]);

  useEffect(() => {
    if (editDraft.ready && editDraft.hasDraft && editDraft.value !== null) setMode('edit');
    // Restoring is tied to the storage load transition. Later edits set mode directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editDraft.ready]);

  useEffect(() => {
    if (instructionDraft.ready && instructionDraft.hasDraft) setAsking(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instructionDraft.ready]);

  useEffect(() => {
    if (editDraft.submitted && draft !== null && notes.data?.markdown === draft) {
      void editDraft.clear(null);
      setMode('view');
    }
  }, [draft, editDraft.clear, editDraft.submitted, notes.data?.markdown]);

  useEffect(() => {
    if (
      instructionDraft.submitted
      && agent.job?.instruction.trim() === instruction.trim()
    ) {
      void instructionDraft.clear('');
      setAsking(false);
    }
  }, [agent.job?.instruction, instruction, instructionDraft.clear, instructionDraft.submitted]);

  async function persist(
    text: string,
    summary?: string,
    proposal = editingProposal,
  ) {
    if (!pid || !target) return;
    setSaving(true);
    setSaveError(null);
    if (text === draft) await editDraft.markSubmitted();
    try {
      const saved = await saveNotes(pid, target, text, {
        summary,
        base_revision: proposal?.baseRevision,
        job_id: proposal?.jobId,
      });
      qc.invalidateQueries({ queryKey: keys.notes(pid, target) });
      qc.invalidateQueries({ queryKey: keys.projectState(pid) });
      setMode('view');
      await editDraft.clear(null);
      // Only an edit-first/apply save sent a job id for the backend to discard. A separate
      // proposal that happened to finish while a manual draft was open must remain reviewable.
      if (proposal) {
        agent.proposalApplied();
        if (saved.next_job) await agent.resume();
        if (saved.next_error) {
          setSaveError(`Saved, but the next migrated paper could not start: ${saved.next_error}`);
        }
      }
    } catch (e) {
      setSaveError((e as Error).message ?? 'Save failed.');
      await qc.invalidateQueries({ queryKey: keys.notes(pid, target) });
    } finally {
      setSaving(false);
    }
  }

  function startEdit(
    from: string,
    proposal?: ProposalRef,
  ) {
    editDraft.setValue({ markdown: from, proposal: proposal ?? null });
    setMode('edit');
    if (!proposal) agent.dismissProposal();
  }

  function cancelEdit() {
    const dirty = draft !== null && draft !== markdown;
    const close = () => {
      setMode('view');
      void editDraft.clear(null);
    };
    if (dirty) {
      Alert.alert('Discard changes?', 'Your edits to these notes will be lost.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: close },
      ]);
    } else {
      close();
    }
  }

  async function submitInstruction() {
    const text = instruction.trim();
    if (!text) return;
    await instructionDraft.markSubmitted();
    if (await agent.run(text)) {
      await instructionDraft.clear('');
      setAsking(false);
    }
  }

  const showProposal = agent.proposal !== null && mode === 'view';
  const relocationProgress =
    agent.job?.relocation_index && agent.job?.relocation_total
      ? `Paper ${agent.job.relocation_index} of ${agent.job.relocation_total}`
      : null;
  const actions: SheetOption[] = [];
  if (paperUrl) {
    actions.push({
      key: 'paper',
      title: 'Open full paper',
      subtitle: paperUrl.includes('arxiv.org/pdf/') ? 'PDF' : 'Source page',
      icon: 'external-link',
      accent: t.mint,
      onPress: () => void Linking.openURL(paperUrl).catch(() => undefined),
    });
  }
  actions.push(
    {
      key: 'edit',
      title: 'Edit directly',
      subtitle: 'Change the markdown yourself',
      icon: 'edit-3',
      disabled: agent.running,
      onPress: () => startEdit(markdown),
    },
    {
      key: 'revise',
      title: 'Propose revision',
      subtitle: 'Ask the analyst, then review before applying',
      icon: 'zap',
      disabled: agent.running || !markdown.trim(),
      onPress: () => setAsking(true),
    },
  );

  return (
    <Screen edges={['top']}>
      <TopBar
        title={title}
        subtitle={
          relocationProgress
            ? `${relocationProgress} · ${showProposal ? 'review before applying' : 'preparing notes'}`
            : showProposal
              ? 'Proposed revision — review before applying'
              : 'Notes'
        }
        onBack={router.canGoBack() ? () => router.back() : undefined}
        right={
          mode === 'view' && !asking && !showProposal ? (
            <IconButton
              name="more-vertical"
              onPress={() => setActionsOpen(true)}
              accessibilityLabel="Notes actions"
            />
          ) : undefined
        }
      />

      <OptionsSheet
        visible={actionsOpen}
        onClose={() => setActionsOpen(false)}
        title="Notes actions"
        options={actions}
      />

      {!pid || !target ? (
        <Centered text="No active project." />
      ) : notes.isLoading ? (
        <Centered loading />
      ) : notes.isError ? (
        <Centered text={(notes.error as Error)?.message ?? 'Could not load notes.'} />
      ) : mode === 'edit' ? (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={8}>
          <TextInput
            value={draft ?? ''}
            onChangeText={setDraft}
            multiline
            autoFocus
            textAlignVertical="top"
            style={styles.editor}
            selectionColor={t.mint}
          />
          {saveError ? <ErrorCard text={saveError} onDismiss={() => setSaveError(null)} /> : null}
          <View style={styles.footerRow}>
            <Button title="Cancel" variant="ghost" onPress={cancelEdit} style={{ flex: 1 }} />
            <Button
              title="Save"
              onPress={() => draft !== null && void persist(draft)}
              loading={saving}
              disabled={draft === null || !draft.trim() || draft === markdown}
              style={{ flex: 2 }}
            />
          </View>
        </KeyboardAvoidingView>
      ) : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={8}>
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.body}
            onContentSizeChange={() => {
              if (agent.running) scrollRef.current?.scrollToEnd({ animated: true });
            }}
          >
            {showProposal ? (
              <Card style={styles.proposalCard}>
                <View style={styles.proposalHead}>
                  <Icon name="zap" size={14} color={t.mint} />
                  <Text variant="label" color={t.mint}>
                    AI revision
                  </Text>
                </View>
                <Text variant="serifItalic" style={{ marginTop: space.xs }}>
                  “{agent.job?.instruction}”
                </Text>
                <Text variant="caption" color={t.violet} style={{ marginTop: space.xs }}>
                  {relocationProgress
                    ? `${relocationProgress}${agent.job?.relocation_title ? ` · ${agent.job.relocation_title}` : ''}. Apply or discard to continue to the next paper.`
                    : 'Review below — nothing is committed until you apply.'}
                </Text>
              </Card>
            ) : null}

            {showProposal ? (
              <NotesDiff
                before={markdown}
                after={agent.proposal!}
                onLinkPress={openProposalLink}
              />
            ) : markdown.trim() ? (
              <Markdown text={markdown} />
            ) : (
              <View style={styles.empty}>
                <Text variant="body" color={t.muted} style={{ textAlign: 'center' }}>
                  No notes yet{target === 'working' ? ' — the working notes grow as you read.' : ' for this paper.'}
                </Text>
              </View>
            )}

            {agent.running ? <AgentProgress items={agent.job?.items ?? []} /> : null}
            {agent.error ? <ErrorCard text={agent.error} onDismiss={agent.clearError} /> : null}
            {saveError ? <ErrorCard text={saveError} onDismiss={() => setSaveError(null)} /> : null}
          </ScrollView>

          {showProposal ? (
            <View style={styles.reviewActions}>
              <Button
                title="Approve & commit"
                icon="check"
                onPress={() =>
                  void persist(
                    agent.proposal!,
                    agent.job?.summary || `Notes edit (agent): ${agent.job?.instruction ?? ''}`.trim(),
                    {
                      baseRevision: agent.job?.base_revision ?? '',
                      jobId: agent.job?.id ?? '',
                      summary: agent.job?.summary ?? '',
                    },
                  )
                }
                loading={saving}
              />
              <Button
                title="Edit before committing"
                variant="ghost"
                onPress={() => startEdit(agent.proposal!, {
                  baseRevision: agent.job?.base_revision ?? '',
                  jobId: agent.job?.id ?? '',
                  summary: agent.job?.summary ?? '',
                })}
                style={styles.reviewSecondary}
              />
              <Button
                title="Discard proposal"
                variant="ghost"
                onPress={agent.dismissProposal}
              />
            </View>
          ) : asking ? (
            <View style={styles.askBar}>
              <TextInput
                value={instruction}
                onChangeText={setInstruction}
                placeholder="Tell the analyst what to change…"
                placeholderTextColor={t.muted}
                multiline
                autoFocus
                style={styles.askInput}
                selectionColor={t.mint}
              />
              <View style={styles.footerRow}>
                <Button
                  title="Cancel"
                  variant="ghost"
                  onPress={() => {
                    setAsking(false);
                    void instructionDraft.clear('');
                  }}
                  style={{ flex: 1 }}
                />
                <Button
                  title="Revise"
                  onPress={submitInstruction}
                  disabled={!instruction.trim()}
                  style={{ flex: 2 }}
                />
              </View>
            </View>
          ) : null}
        </KeyboardAvoidingView>
      )}
    </Screen>
  );
}

/** Live progress of the server-side edit: the current real phase, recent tool calls, and the
 *  number of words actually streamed so far (the text itself is reviewed at the end). */
function AgentProgress({ items }: { items: StreamItem[] }) {
  // Palette named `theme` here: the tool-trail map callback below already uses `t`.
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const tools = items.filter((it) => it.kind === 'tool') as Extract<StreamItem, { kind: 'tool' }>[];
  const words = draftedWordCount(items);
  return (
    <View style={styles.progressCard}>
      <AgentActivity
        emphasis="panel"
        status={notesAgentPhase(items)}
        detail={words > 0 ? `${words} words drafted` : undefined}
        testID="notes-agent-activity"
      />
      {tools.slice(-3).map((t, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <Icon name="tool" size={12} color={theme.mint} />
          <Text variant="caption" color={theme.mint} numberOfLines={1} style={{ flex: 1 }}>
            {t.name}
            {t.detail ? ` — ${t.detail}` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ErrorCard({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={styles.errorCard}>
      <Text variant="body" color={t.danger}>
        {text}
      </Text>
      <Button title="Dismiss" variant="ghost" onPress={onDismiss} style={{ marginTop: space.sm }} />
    </Card>
  );
}

function Centered({ text, loading }: { text?: string; loading?: boolean }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.centered}>
      {loading ? (
        <ActivityIndicator color={t.mint} />
      ) : (
        <Text variant="body" color={t.muted} style={{ textAlign: 'center' }}>
          {text}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  body: { padding: space.md, paddingBottom: space.xl, gap: space.md },
  empty: { paddingVertical: space.xxl, paddingHorizontal: space.lg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  editor: {
    flex: 1,
    margin: space.md,
    padding: space.md,
    backgroundColor: t.elevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.line2,
    color: t.text,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 19,
  },
  footerRow: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    paddingTop: space.xs,
  },
  reviewActions: { gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.md },
  reviewSecondary: { borderWidth: 1, borderColor: t.line2 },
  askBar: { paddingTop: space.xs },
  askInput: {
    marginHorizontal: space.md,
    marginBottom: space.sm,
    padding: space.md,
    minHeight: 64,
    maxHeight: 140,
    backgroundColor: t.elevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.line2,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  proposalCard: { borderColor: t.violet, borderWidth: 1 },
  proposalHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  progressCard: { marginTop: space.sm },
  errorCard: { borderColor: t.danger, borderWidth: 1, marginTop: space.sm },
  centeredText: { textAlign: 'center' },
});
