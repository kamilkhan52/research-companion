// Relocate-to-existing-project confirm sheet. The Library makes Move vs Copy explicit before
// choosing a destination; this sheet handles notes choices and final confirmation.

import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import type { RelocationResult } from '@/api/endpoints';
import { useMoveProject } from '@/api/queries';
import { BottomSheet } from '@/components/BottomSheet';
import { Button, Text } from '@/ui';
import { showToast } from '@/ui/Toast';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export function MoveToProjectSheet({
  visible,
  pid,
  destPid,
  destName,
  slugs,
  notesEligible,
  operation,
  onClose,
  onDone,
}: {
  visible: boolean;
  pid: string | null;
  destPid: string | null;
  destName: string;
  slugs: string[];
  notesEligible: boolean;
  operation: 'move' | 'copy';
  onClose: () => void;
  /** The caller switches projects and opens immediate notes review when one was requested. */
  onDone: (result: RelocationResult) => void;
}) {
  const t = useTheme();
  const move = useMoveProject(pid);
  const [draftNotes, setDraftNotes] = useState(true);
  const [cleanupSource, setCleanupSource] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = slugs.length;
  const remove = operation === 'move';

  async function handleMove() {
    if (!pid || !destPid || count === 0 || move.isPending) return;
    setError(null);
    try {
      const res = await move.mutateAsync({
        dest_pid: destPid,
        slugs,
        remove_from_source: remove,
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
      setDraftNotes(true);
      setCleanupSource(false);
      onDone(res);
    } catch (e) {
      setError((e as Error).message ?? `Could not ${operation} the papers.`);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeightPct={85} scrollable>
      <Text variant="title">
        {operation === 'move' ? 'Move' : 'Copy'} to “{destName}”
      </Text>
      <Text variant="caption" color={t.muted} style={{ marginTop: 2, marginBottom: space.md }}>
        {count} paper{count === 1 ? '' : 's'} and the work done on them (notes, discussions,
        cached analysis) {remove ? 'move' : 'are copied'} to “{destName}”.
      </Text>

      {notesEligible ? (
        <>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: space.md }}>
              <Text variant="body">Update destination Project Notes</Text>
              <Text variant="caption" color={t.muted}>
                AI proposes integrating the selected papers’ committed Notes.
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
                <Text variant="body">Clean up this project’s Project Notes</Text>
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
          onPress={handleMove}
          loading={move.isPending}
          disabled={count === 0 || !destPid}
          style={{ flex: 1 }}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  toggleRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.md },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
});
