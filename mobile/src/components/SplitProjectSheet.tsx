// Split-to-new-project sheet (R8.1). Confirms the selection out of the Library's multi-select
// mode: a name for the new project, an optional theme (seeds the new project's discovery /
// author-profile / lab passes), and whether the papers leave the source (move) or are copied.
// Confirm → POST /split → the app switches to the new project. Deterministic server-side, so
// this is a plain confirmed action, not a job.

import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { useSplitProject } from '@/api/queries';
import { Button, Card, Text } from '@/ui';
import { showToast } from '@/ui/Toast';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

export function SplitProjectSheet({
  visible,
  pid,
  slugs,
  onClose,
  onDone,
}: {
  visible: boolean;
  pid: string | null;
  slugs: string[];
  onClose: () => void;
  /** Called with the new project's id after a successful split (the caller switches to it). */
  onDone: (newPid: string) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const split = useSplitProject(pid);
  const [name, setName] = useState('');
  const [goals, setGoals] = useState('');
  const [remove, setRemove] = useState(true);
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
      });
      showToast(
        remove
          ? `Moved ${res.moved} paper${res.moved === 1 ? '' : 's'} to “${res.name}”`
          : `Copied ${res.moved} paper${res.moved === 1 ? '' : 's'} to “${res.name}”`,
      );
      setName('');
      setGoals('');
      setRemove(true);
      onDone(res.new_pid);
    } catch (e) {
      setError((e as Error).message ?? 'Could not split the project.');
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* behavior="padding" pads this wrapper by the keyboard height, lifting the
           bottom-anchored sheet (and its inputs) above the keyboard. Proven inside a Modal by
           NotesReviewSheet — RN Modals portal to their own window, but keyboard-controller's
           events are window-global. */}
        <KeyboardAvoidingView behavior="padding">
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text variant="title">Split to a new project</Text>
          <Text variant="caption" color={t.muted} style={{ marginTop: 2, marginBottom: space.md }}>
            {count} paper{count === 1 ? '' : 's'} and the work done on them (notes, discussions,
            cached analysis) go to a new project.
          </Text>

          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="New project name"
            placeholderTextColor={t.muted}
            style={styles.input}
            autoFocus
            returnKeyType="next"
          />
          <TextInput
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
        </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: t.scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: t.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: t.line,
    padding: space.lg,
    paddingBottom: space.xxl,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: t.line2,
    alignSelf: 'center', marginBottom: space.md,
  },
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
