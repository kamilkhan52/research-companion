// Notes — view and edit one committed notes document: a paper's Notes block, or the
// cross-paper working notes (target === 'working'). Three ways in, one focused screen:
//   view  — the markdown rendered for reading (the default; this is a reading surface first)
//   edit  — the raw markdown in a plain editor; Save commits it to the project's git record
//   agent — a natural-language instruction runs server-side as a background job (job+poll,
//           reusing the analyst's research tools); the revision comes back as a PROPOSAL
//           rendered for review, applied only on explicit Apply. Agent proposes, human commits.

import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
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
import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';
import { TopBar } from '@/components/TopBar';
import { useNotesAgent } from '@/hooks/useNotesAgent';
import { draftKey, usePersistedDraft } from '@/hooks/usePersistedDraft';
import { useActiveProject } from '@/store/project';
import { fullPaperUrl } from '@/lib/paperLinks';
import { Button, Card, Icon, IconButton, Screen, Text } from '@/ui';
import { colors, fonts, radius, space } from '@/theme/tokens';

type Mode = 'view' | 'edit';

export default function NotesScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  // Also mounted as the Notes tab (no route param), which shows the project-level synthesis.
  const { target: targetParam } = useLocalSearchParams<{ target?: string }>();
  const target = targetParam ?? 'working';
  const { activePid: pid } = useActiveProject();

  const notes = useNotes(pid, target ?? null);
  const projectState = useProjectState(pid);
  const agent = useNotesAgent(pid, target ?? null);
  const editDraft = usePersistedDraft<string | null>(
    pid && target ? draftKey(pid, 'notes', target, 'manual-edit') : null,
    null,
  );
  const instructionDraft = usePersistedDraft(
    pid && target ? draftKey(pid, 'notes', target, 'agent-instruction') : null,
    '',
  );

  const [mode, setMode] = useState<Mode>('view');
  const draft = editDraft.value; // non-null while editing
  const setDraft = editDraft.setValue;
  const [asking, setAsking] = useState(false);              // instruction composer open
  const instruction = instructionDraft.value;
  const setInstruction = instructionDraft.setValue;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);

  const markdown = notes.data?.markdown ?? '';
  const title = notes.data?.title ?? (target === 'working' ? 'Working notes' : 'Notes');
  const paper = target === 'working' ? undefined : projectState.data?.papers.find((item) => item.slug === target);
  const paperUrl = paper ? fullPaperUrl(paper) : null;

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

  async function persist(text: string, summary?: string) {
    if (!pid || !target) return;
    setSaving(true);
    setSaveError(null);
    if (text === draft) await editDraft.markSubmitted();
    try {
      await saveNotes(pid, target, text, summary);
      qc.invalidateQueries({ queryKey: keys.notes(pid, target) });
      qc.invalidateQueries({ queryKey: keys.projectState(pid) });
      setMode('view');
      await editDraft.clear(null);
      agent.dismissProposal();
    } catch (e) {
      setSaveError((e as Error).message ?? 'Save failed.');
      await qc.invalidateQueries({ queryKey: keys.notes(pid, target) });
    } finally {
      setSaving(false);
    }
  }

  function startEdit(from: string) {
    setDraft(from);
    setMode('edit');
    agent.dismissProposal();
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
  const actions: SheetOption[] = [];
  if (paperUrl) {
    actions.push({
      key: 'paper',
      title: 'Open full paper',
      subtitle: paperUrl.includes('arxiv.org/pdf/') ? 'PDF' : 'Source page',
      icon: 'external-link',
      accent: colors.mint,
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
        subtitle={showProposal ? 'Proposed revision — review before applying' : 'Notes'}
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
            selectionColor={colors.mint}
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
          <ScrollView contentContainerStyle={styles.body}>
            {showProposal ? (
              <Card style={styles.proposalCard}>
                <View style={styles.proposalHead}>
                  <Icon name="zap" size={14} color={colors.mint} />
                  <Text variant="label" color={colors.mint}>
                    AI revision
                  </Text>
                </View>
                <Text variant="serifItalic" style={{ marginTop: space.xs }}>
                  “{agent.job?.instruction}”
                </Text>
                <Text variant="caption" color={colors.violet} style={{ marginTop: space.xs }}>
                  Review below — nothing is committed until you apply.
                </Text>
              </Card>
            ) : null}

            {showProposal ? (
              <Markdown text={agent.proposal!} />
            ) : markdown.trim() ? (
              <Markdown text={markdown} />
            ) : (
              <View style={styles.empty}>
                <Text variant="body" color={colors.muted} style={{ textAlign: 'center' }}>
                  No notes yet{target === 'working' ? ' — the working notes grow as you read.' : ' for this paper.'}
                </Text>
              </View>
            )}

            {agent.running ? <AgentProgress items={agent.job?.items ?? []} /> : null}
            {agent.error ? <ErrorCard text={agent.error} onDismiss={agent.clearError} /> : null}
            {saveError ? <ErrorCard text={saveError} onDismiss={() => setSaveError(null)} /> : null}
          </ScrollView>

          {showProposal ? (
            <View style={styles.footerRow}>
              <Button title="Discard" variant="ghost" onPress={agent.dismissProposal} style={{ flex: 1 }} />
              <Button
                title="Edit first"
                variant="ghost"
                onPress={() => startEdit(agent.proposal!)}
                style={{ flex: 1 }}
              />
              <Button
                title="Apply"
                onPress={() =>
                  void persist(agent.proposal!, `Notes edit (agent): ${agent.job?.instruction ?? ''}`.trim())
                }
                loading={saving}
                style={{ flex: 1.4 }}
              />
            </View>
          ) : asking ? (
            <View style={styles.askBar}>
              <TextInput
                value={instruction}
                onChangeText={setInstruction}
                placeholder="Tell the analyst what to change…"
                placeholderTextColor={colors.muted}
                multiline
                autoFocus
                style={styles.askInput}
                selectionColor={colors.mint}
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

/** Live progress of the server-side edit: tool calls as a compact trail, plus a character
 *  count of the revision streamed so far (the text itself is reviewed at the end). */
function AgentProgress({ items }: { items: StreamItem[] }) {
  const tools = items.filter((it) => it.kind === 'tool') as Extract<StreamItem, { kind: 'tool' }>[];
  const chars = useMemo(
    () => items.reduce((n, it) => (it.kind === 'text' ? n + it.text.length : n), 0),
    [items],
  );
  return (
    <View style={styles.progressCard}>
      <AgentActivity
        emphasis="panel"
        status="Preparing a notes revision…"
        detail={chars > 0 ? `${chars} characters drafted` : 'The analyst is reviewing the current notes.'}
      />
      {tools.slice(-3).map((t, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <Icon name="tool" size={12} color={colors.mint} />
          <Text variant="caption" color={colors.mint} numberOfLines={1} style={{ flex: 1 }}>
            {t.name}
            {t.detail ? ` — ${t.detail}` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ErrorCard({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <Card style={styles.errorCard}>
      <Text variant="body" color={colors.danger}>
        {text}
      </Text>
      <Button title="Dismiss" variant="ghost" onPress={onDismiss} style={{ marginTop: space.sm }} />
    </Card>
  );
}

function Centered({ text, loading }: { text?: string; loading?: boolean }) {
  return (
    <View style={styles.centered}>
      {loading ? (
        <ActivityIndicator color={colors.mint} />
      ) : (
        <Text variant="body" color={colors.muted} style={{ textAlign: 'center' }}>
          {text}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.md, paddingBottom: space.xl, gap: space.md },
  empty: { paddingVertical: space.xxl, paddingHorizontal: space.lg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  editor: {
    flex: 1,
    margin: space.md,
    padding: space.md,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    color: colors.text,
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
  askBar: { paddingTop: space.xs },
  askInput: {
    marginHorizontal: space.md,
    marginBottom: space.sm,
    padding: space.md,
    minHeight: 64,
    maxHeight: 140,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  proposalCard: { borderColor: colors.violet, borderWidth: 1 },
  proposalHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  progressCard: { marginTop: space.sm },
  errorCard: { borderColor: colors.danger, borderWidth: 1, marginTop: space.sm },
  centeredText: { textAlign: 'center' },
});
