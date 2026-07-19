import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import {
  type PendingSentenceComment,
  type SelectedSentence,
} from '@/lib/sentenceComments';
import { Button, Icon, IconButton, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';

export function SentenceCommentComposer({
  comments,
  selected,
  draft,
  onChangeDraft,
  onSave,
  onCancelSelection,
  onOpen,
  onRemove,
  onDone,
}: {
  comments: PendingSentenceComment[];
  selected: SelectedSentence | null;
  draft: string;
  onChangeDraft: (text: string) => void;
  onSave: () => void;
  onCancelSelection: () => void;
  onOpen: (comment: PendingSentenceComment) => void;
  onRemove: (comment: PendingSentenceComment) => void;
  onDone: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  if (!selected && comments.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {selected ? (
        <View style={styles.editor}>
          <View style={styles.editorHead}>
            <Icon name="message-square" size={15} color={t.violet} />
            <Text variant="caption" numberOfLines={2} style={{ flex: 1 }}>
              “{selected.quote}”
            </Text>
            <IconButton
              name="x"
              size={15}
              filled={false}
              onPress={onCancelSelection}
              accessibilityLabel="Cancel sentence comment"
            />
          </View>
          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={onChangeDraft}
              placeholder="Add a comment…"
              placeholderTextColor={t.muted}
              style={styles.input}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={draft.trim() ? onSave : undefined}
              accessibilityLabel="Sentence comment"
            />
            <Button
              title="OK"
              onPress={onSave}
              disabled={!draft.trim()}
              style={styles.ok}
            />
          </View>
        </View>
      ) : null}

      {comments.length ? (
        <View style={styles.queue}>
          <View style={styles.queueHead}>
            <Text variant="overline" color={t.violet}>
              {comments.length} comment{comments.length === 1 ? '' : 's'} attached
            </Text>
            <Pressable onPress={onDone} accessibilityRole="button">
              <Text variant="label" color={t.muted}>Done</Text>
            </Pressable>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}>
            {comments.map((comment) => (
              <View
                key={`${comment.assistantIndex}:${comment.quote}`}
                style={styles.chip}>
                <Pressable
                  onPress={() => onOpen(comment)}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit comment on: ${comment.quote}`}
                  style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="caption" numberOfLines={1}>“{comment.quote}”</Text>
                  <Text variant="label" numberOfLines={1} color={t.violet}>
                    {comment.comment}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => onRemove(comment)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove comment on: ${comment.quote}`}>
                  <Icon name="x" size={14} color={t.muted} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  wrap: {
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingTop: space.xs,
  },
  editor: {
    gap: space.sm,
    padding: space.sm,
    borderWidth: 1,
    borderColor: t.violet,
    borderRadius: radius.md,
    backgroundColor: t.surface,
  },
  editorHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  input: {
    flex: 1,
    minHeight: 38,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    color: t.text,
  },
  ok: { minWidth: 58 },
  queue: {
    gap: space.xs,
    paddingVertical: space.xs,
  },
  queueHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xs,
  },
  chips: { gap: space.sm, paddingRight: space.md },
  chip: {
    width: 230,
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.violet,
    backgroundColor: t.violetWash,
  },
});
