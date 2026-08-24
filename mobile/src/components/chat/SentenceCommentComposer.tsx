import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  FadeInDown,
  FadeOutDown,
  LinearTransition,
} from 'react-native-reanimated';

import {
  type PendingSentenceComment,
  type SelectedSentence,
} from '@/lib/sentenceComments';
import { Button, Icon, IconButton, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { control, radius, space, type ThemePalette } from '@/theme/tokens';

export function SentenceCommentComposer({
  active,
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
  active: boolean;
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
  // DR-108 (Kamil: "The 'Done' button… doesn't do anything. Can't tell if it even registers the
  // press."). It did register — it only left sentence-SELECTION mode, and with comments already
  // attached the tray looked identical afterwards, which is indistinguishable from a dead button.
  // Done now COLLAPSES the attached comments into a single "N comments" chip beside the composer,
  // which is both a visible result and the screen space he asked for back ("This helps free
  // screen area for reading the response").
  const [collapsed, setCollapsed] = useState(false);
  const count = comments.length;
  // A newly attached comment expands: the reader needs to see it land. Tracked by count so
  // re-expanding is tied to the comment arriving, not to every render.
  const seen = useRef(count);
  useEffect(() => {
    if (count > seen.current) setCollapsed(false);
    seen.current = count;
  }, [count]);
  // Selecting a sentence always brings the editor forward, collapsed chip or not.
  const showQueue = count > 0 && !collapsed;

  if (!active && !selected && count === 0) return null;

  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      layout={LinearTransition.duration(180)}
      style={styles.wrap}>
      {active && !selected && count === 0 ? (
        <View style={styles.hint}>
          <Icon name="message-square" size={15} color={t.violet} />
          <Text variant="caption" color={t.muted} style={styles.hintText}>
            Select a sentence in the response
          </Text>
          <Pressable onPress={onDone} hitSlop={12} style={styles.doneBtn} accessibilityRole="button">
            <Text variant="label" color={t.violet}>Done</Text>
          </Pressable>
        </View>
      ) : null}

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

      {showQueue ? (
        // Just the chips: the count header the tray used to carry said what the chips already
        // show, and cost a row of reading space to do it (DR-108).
        <Animated.View
          entering={FadeInDown.duration(160)}
          exiting={FadeOutDown.duration(120)}
          layout={LinearTransition.duration(180)}
          testID="sentence-comment-queue"
          style={styles.queue}>
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
          <Pressable
            testID="sentence-comment-collapse"
            onPress={() => {
              setCollapsed(true);
              onDone();
            }}
            style={styles.collapseBtn}
            accessibilityRole="button"
            accessibilityLabel={`Done. Collapse ${count} attached comment${count === 1 ? '' : 's'}.`}>
            <Icon name="chevron-down" size={16} color={t.violet} />
          </Pressable>
        </Animated.View>
      ) : null}

      {count > 0 && collapsed ? (
        <Animated.View
          entering={FadeInDown.duration(160)}
          exiting={FadeOutDown.duration(120)}
          layout={LinearTransition.duration(180)}>
          <Pressable
            testID="sentence-comment-chip"
            onPress={() => setCollapsed(false)}
            style={styles.countChip}
            accessibilityRole="button"
            accessibilityLabel={
              `${count} comment${count === 1 ? '' : 's'} attached. Tap to show them.`
            }>
            <Icon name="message-square" size={14} color={t.violet} />
            <Text variant="label" color={t.violet}>
              {count} comment{count === 1 ? '' : 's'}
            </Text>
            <Icon name="chevron-up" size={14} color={t.violet} />
          </Pressable>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  wrap: {
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingTop: space.xs,
  },
  hint: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.line2,
    backgroundColor: t.elevated,
  },
  hintText: { flex: 1 },
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
  // DR-053 §2, Opus review: hitSlop alone doesn't produce a real tap target — Android clips a
  // Pressable's touchable area to its PARENT's bounds, and neither `hint` nor `queueHead` had
  // enough height for the slop to have anywhere to extend into. minHeight is real layout, so
  // both surrounding rows grow to fit it (flex rows size to their tallest child) instead of
  // silently clipping an invisible hit-test region back down to the bare text's ~16px.
  doneBtn: { minHeight: control.minTouch, justifyContent: 'center' },
  // DR-053 §2: `queue`/`queueHead` used to carry no background at all, so the tray read as
  // text floating over whatever chat content sat behind the composer overlay rather than a
  // deliberate part of the composer stack. A real surface (matching `hint`'s card treatment
  // above) makes it read as attached, not incidental.
  queue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.line2,
    backgroundColor: t.elevated,
  },
  // The one control the header row used to hold, kept as a real 44px target beside the chips.
  collapseBtn: {
    width: control.minTouch,
    minHeight: control.minTouch,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Collapsed: one pill saying how many comments are attached (DR-108).
  countChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.violet,
    backgroundColor: t.violetWash,
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
