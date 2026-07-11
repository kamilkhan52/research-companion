// A dedicated surface for selecting text out of an assistant answer. Long-pressing a response
// opens this instead of trying to make the answer selectable in place: the discussion list is a
// react-native-gesture-handler FlatList with a per-row swipeable, and RNGH captures touches at
// the native level, so an in-list `<Text selectable>` fights the scroll/swipe gesture — the
// long-press often never reaches the native selection ActionMode, and a scroll sometimes trips
// a stray word-selection. Here the text lives in a read-only multiline TextInput inside a plain
// Modal (no RNGH in the path), where native selection is reliable and its range is observable —
// so we can copy the selection or drop it into the reply as a Markdown blockquote.

import { useState } from 'react';
import { Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { Button, Icon, Text } from '@/ui';
import { colors, fonts, radius, space } from '@/theme/tokens';

export function SelectTextSheet({
  visible,
  text,
  onClose,
  onQuote,
}: {
  visible: boolean;
  text: string;
  onClose: () => void;
  // Insert the chosen text into the reply composer as a quote. Undefined when there's no
  // composer to quote into (e.g. a committed session) — then only Copy is offered.
  onQuote?: (quoted: string) => void;
}) {
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const selected = sel.end > sel.start ? text.slice(sel.start, sel.end).trim() : '';
  const target = selected || text;
  const scope = selected ? 'selection' : 'all';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text variant="overline" color={colors.violet}>
              Select text
            </Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
              <Icon name="x" size={20} color={colors.muted} />
            </Pressable>
          </View>
          <Text variant="caption" style={styles.hint}>
            Hold to select a passage, then copy it or quote it in your reply.
          </Text>
          <TextInput
            // Read-only but selectable: the value is fixed and edits are ignored, so it behaves
            // as a viewer while staying a real (selectable) native input; no keyboard or caret.
            value={text}
            onChangeText={() => undefined}
            multiline
            scrollEnabled
            showSoftInputOnFocus={false}
            caretHidden
            contextMenuHidden={false}
            onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
            textAlignVertical="top"
            style={styles.body}
          />
          <View style={styles.actions}>
            <Button
              title={scope === 'selection' ? 'Copy selection' : 'Copy all'}
              variant="ghost"
              onPress={() => {
                void Clipboard.setStringAsync(target);
                onClose();
              }}
              style={{ flex: 1 }}
            />
            {onQuote ? (
              <Button
                title={scope === 'selection' ? 'Quote selection' : 'Quote all'}
                onPress={() => onQuote(target)}
                style={{ flex: 1 }}
              />
            ) : null}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    maxHeight: '85%',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hint: { marginTop: space.xs, marginBottom: space.md },
  body: {
    flexShrink: 1,
    fontFamily: fonts.serif,
    fontSize: 16,
    lineHeight: 25,
    color: colors.text,
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
  },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
});
