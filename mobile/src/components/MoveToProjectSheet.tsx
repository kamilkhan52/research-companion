// Move-to-existing-project confirm sheet (R9.13). Reached from the Library multi-select →
// Move → an existing destination. Confirms move (default) vs copy, then POST /move. Same
// result shape as split, so the caller switches to the destination on success. Deterministic
// server-side (a plain confirmed action, not a job).

import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, View } from 'react-native';

import { useMoveProject } from '@/api/queries';
import { Button, Text } from '@/ui';
import { showToast } from '@/ui/Toast';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';

export function MoveToProjectSheet({
  visible,
  pid,
  destPid,
  destName,
  slugs,
  onClose,
  onDone,
}: {
  visible: boolean;
  pid: string | null;
  destPid: string | null;
  destName: string;
  slugs: string[];
  onClose: () => void;
  /** Called with the destination's id after a successful move (the caller switches to it). */
  onDone: (destPid: string) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const move = useMoveProject(pid);
  const [remove, setRemove] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const count = slugs.length;

  async function handleMove() {
    if (!pid || !destPid || count === 0 || move.isPending) return;
    setError(null);
    try {
      const res = await move.mutateAsync({ dest_pid: destPid, slugs, remove_from_source: remove });
      showToast(
        remove
          ? `Moved ${res.moved} paper${res.moved === 1 ? '' : 's'} to “${res.name}”`
          : `Copied ${res.moved} paper${res.moved === 1 ? '' : 's'} to “${res.name}”`,
      );
      setRemove(true);
      onDone(res.new_pid);
    } catch (e) {
      setError((e as Error).message ?? 'Could not move the papers.');
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text variant="title">Move to “{destName}”</Text>
          <Text variant="caption" color={t.muted} style={{ marginTop: 2, marginBottom: space.md }}>
            {count} paper{count === 1 ? '' : 's'} and the work done on them (notes, discussions,
            cached analysis) go to “{destName}”.
          </Text>

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
              onPress={handleMove}
              loading={move.isPending}
              disabled={count === 0 || !destPid}
              style={{ flex: 1 }}
            />
          </View>
        </Pressable>
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
  toggleRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.md },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
});
