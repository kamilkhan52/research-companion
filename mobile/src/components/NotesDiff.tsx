import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Markdown, type LinkHandler } from '@/components/Markdown';
import type { StreamItem } from '@/api/types';
import { Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string };

export function draftedWordCount(items: StreamItem[]): number {
  const text = items
    .filter((item): item is Extract<StreamItem, { kind: 'text' }> => item.kind === 'text')
    .map((item) => item.text)
    .join(' ')
    .trim();
  return text ? text.split(/\s+/u).length : 0;
}

export function notesAgentPhase(items: StreamItem[]): string {
  const latest = items.at(-1);
  if (!latest) return 'Reviewing notes…';
  if (latest.kind === 'text') return 'Drafting revision…';
  if (latest.kind === 'tool') return latest.detail.trim() || latest.name.replaceAll('_', ' ');
  return latest.text.trim() || 'Reviewing notes…';
}

/** A deterministic line diff. Notes are short documents, so an LCS table is preferable to
 *  pulling a dependency into the mobile bundle; trimming the shared prefix/suffix keeps the
 *  table limited to the changed middle in the common case. */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.replace(/\r\n/g, '\n').split('\n');
  const right = after.replace(/\r\n/g, '\n').split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix++;

  const a = left.slice(prefix, left.length - suffix);
  const b = right.slice(prefix, right.length - suffix);
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const changed: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      changed.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) {
      changed.push({ kind: 'add', text: b[j++] });
    } else {
      changed.push({ kind: 'remove', text: a[i++] });
    }
  }
  return [
    ...left.slice(0, prefix).map((text) => ({ kind: 'same' as const, text })),
    ...changed,
    ...left.slice(left.length - suffix).map((text) => ({ kind: 'same' as const, text })),
  ];
}

type VisibleLine = DiffLine | { kind: 'gap' };

function visibleHunks(lines: DiffLine[], context = 2): VisibleLine[] {
  const changed = lines.map((line) => line.kind !== 'same');
  if (!changed.some(Boolean)) return lines;
  const keep = changed.map((_, index) => {
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) {
      if (changed[i]) return true;
    }
    return false;
  });
  const result: VisibleLine[] = [];
  let inGap = false;
  lines.forEach((line, index) => {
    if (!keep[index]) {
      if (!inGap) result.push({ kind: 'gap' });
      inGap = true;
      return;
    }
    inGap = false;
    result.push(line);
  });
  return result;
}

export function NotesDiff({
  before,
  after,
  onLinkPress,
}: {
  before: string;
  after: string;
  onLinkPress?: LinkHandler;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const lines = useMemo(() => visibleHunks(diffLines(before, after)), [after, before]);
  const changed = lines.some((line) => line.kind === 'add' || line.kind === 'remove');

  if (!changed) {
    return <Text variant="caption" color={t.muted}>No text changes proposed.</Text>;
  }
  return (
    <View accessibilityLabel="Proposed line changes" style={styles.root}>
      {lines.map((line, index) => {
        if (line.kind === 'gap') {
          return <Text key={`gap-${index}`} variant="caption" color={t.muted} style={styles.gap}>•••</Text>;
        }
        const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ';
        return (
          <View
            key={`${index}:${line.kind}:${line.text}`}
            style={[
              styles.line,
              line.kind === 'add' && styles.added,
              line.kind === 'remove' && styles.removed,
            ]}
          >
            <Text
              accessibilityLabel={line.kind === 'add' ? 'Added line' : line.kind === 'remove' ? 'Removed line' : 'Context line'}
              style={[styles.marker, line.kind === 'add' && { color: t.mint }, line.kind === 'remove' && { color: t.danger }]}
            >
              {prefix}
            </Text>
            <View style={styles.content}>
              <Markdown text={line.text || ' '} onLinkPress={onLinkPress} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  root: {
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.sm,
  },
  line: {
    minHeight: 28,
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  added: { backgroundColor: t.mintWash },
  removed: { backgroundColor: t.dangerWash },
  marker: {
    width: 14,
    color: t.muted,
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    lineHeight: 20,
  },
  content: { flex: 1, minWidth: 0 },
  gap: { paddingHorizontal: space.md, paddingVertical: space.xs },
});
