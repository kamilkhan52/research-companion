// Split-to-new-project sheet (R8.1). Confirms the selection out of the Library's multi-select
// mode: a name for the new project, an optional theme (seeds the new project's discovery /
// author-profile / lab passes), and whether the papers leave the source (move) or are copied.
// Confirm → POST /split → the app switches to the new project. Deterministic server-side, so
// this is a plain confirmed action, not a job.

import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import type { RelocationResult } from '@/api/endpoints';
import { useSplitProject } from '@/api/queries';
import { BottomSheet, BottomSheetTextInput } from '@/components/BottomSheet';
import { Button, Text } from '@/ui';
import { showToast } from '@/ui/Toast';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

export function SplitProjectSheet({
  visible,
  pid,
  slugs,
  notesEligible,
  onClose,
  onDone,
}: {
  visible: boolean;
  pid: string | null;
  slugs: string[];
  /** At least one selected paper has committed Notes that can ground the AI passes. */
  notesEligible: boolean;
  onClose: () => void;
  /** The caller switches projects and opens immediate notes review when one was requested. */
  onDone: (result: RelocationResult) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const split = useSplitProject(pid);
  const [name, setName] = useState('');
  const [goals, setGoals] = useState('');
  const [remove, setRemove] = useState(true);
  const [draftNotes, setDraftNotes] = useState(true);
  const [cleanupSource, setCleanupSource] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = slugs.length;
  const trimmed = name.trim();

  async function handleSplit() {
    if (!pid || !trimmed || count === 0 || split.isPending) return;
    setError(null);
    try {
      const res = await split.mutateAsync({
        name: trimmed,
        slugs,
        remove_from_source: remove,
        goals: goals.trim() || undefined,
        draft_destination_notes: notesEligible && draftNotes,
        cleanup_source_notes: notesEligible && remove && cleanupSource,
      });
      const movedMessage = remove
          ? `Moved ${res.moved} paper${res.moved === 1 ? '' : 's'} to “${res.name}”`
          : `Copied ${res.moved} paper${res.moved === 1 ? '' : 's'} to “${res.name}”`;
      const notesFailed = res.notes_jobs?.destination_error || res.notes_jobs?.source_cleanup_error;
      const notesStarted = res.notes_jobs?.destination || res.notes_jobs?.source_cleanup;
      showToast(
        notesFailed
          ? `${movedMessage}. An AI notes proposal could not start.`
          : notesStarted
            ? `${movedMessage}. Preparing AI notes proposals.`
            : movedMessage,
      );
      setName('');
      setGoals('');
      setRemove(true);
      setDraftNotes(true);
      setCleanupSource(false);
      onDone(res);
    } catch (e) {
      setError((e as Error).message ?? 'Could not split the project.');
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeightPct={85} scrollable>
      <Text variant="title">Split to a new project</Text>
      <Text variant="caption" color={t.muted} style={{ marginTop: 2, marginBottom: space.md }}>
        {count} paper{count === 1 ? '' : 's'} and the work done on them (notes, discussions,
        cached analysis) go to a new project.
      </Text>

      <BottomSheetTextInput
        value={name}
        onChangeText={setName}
        placeholder="New project name"
        placeholderTextColor={t.muted}
        style={styles.input}
        autoFocus
        returnKeyType="next"
      />
      <BottomSheetTextInput
        value={goals}
        onChangeText={setGoals}
        placeholder="What is this project about? (optional)"
        placeholderTextColor={t.muted}
        style={[styles.input, { marginTop: space.sm, minHeight: 64 }]}
        multiline
      />

      <View style={styles.toggleRow}>
        <View style={{ flex: 1, paddingRight: space.md }}>
          <Text variant="body">Remove from this project</Text>
          <Text variant="caption" color={t.muted}>
            {remove
              ? 'Moves the papers out of the current project.'
              : 'Keeps copies here as well.'}
          </Text>
        </View>
        <Switch
          value={remove}
          onValueChange={setRemove}
          trackColor={{ true: t.mint, false: t.line2 }}
          thumbColor={t.surface}
        />
      </View>

      {notesEligible ? (
        <>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: space.md }}>
              <Text variant="body">Draft destination working notes</Text>
              <Text variant="caption" color={t.muted}>
                AI proposes a synthesis from the selected papers’ committed Notes.
              </Text>
            </View>
            <Switch
              value={draftNotes}
              onValueChange={setDraftNotes}
              trackColor={{ true: t.mint, false: t.line2 }}
              thumbColor={t.surface}
            />
          </View>

          {remove ? (
            <View style={styles.toggleRow}>
              <View style={{ flex: 1, paddingRight: space.md }}>
                <Text variant="body">Clean up this project’s working notes</Text>
                <Text variant="caption" color={t.muted}>
                  AI proposes removing contributions tied to the papers leaving.
                </Text>
              </View>
              <Switch
                value={cleanupSource}
                onValueChange={setCleanupSource}
                trackColor={{ true: t.mint, false: t.line2 }}
                thumbColor={t.surface}
              />
            </View>
          ) : null}
        </>
      ) : null}

      {error ? (
        <Text variant="caption" color={t.danger} style={{ marginTop: space.sm }}>
          {error}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Button title="Cancel" variant="ghost" onPress={onClose} style={{ flex: 1 }} />
        <Button
          title={remove ? 'Move papers' : 'Copy papers'}
          onPress={handleSplit}
          loading={split.isPending}
          disabled={!trimmed || count === 0}
          style={{ flex: 1 }}
        />
      </View>
    </BottomSheet>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  input: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    color: t.text,
    fontFamily: fonts.body,
    fontSize: 15,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.md,
  },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
});
