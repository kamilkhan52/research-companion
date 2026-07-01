// Minimal, dependency-free markdown renderer for the scholarly analysis text. Supports the
// subset the backend produces: ATX headings, bold/italic, inline code, unordered/ordered
// lists, blockquotes, fenced code, and paragraphs. Deliberately small — not a full CommonMark
// implementation — to keep reading fast and the bundle lean.

import { Fragment, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/ui';
import { colors, fonts, space } from '@/theme/tokens';

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <View style={{ gap: space.sm }}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </View>
  );
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }

    // Heading
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', text: buf.join(' ') });
      continue;
    }

    // List (unordered or ordered)
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // Paragraph: gather until blank line or a block starter
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !lines[i].startsWith('>') &&
      !lines[i].trim().startsWith('```') &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    blocks.push({ kind: 'paragraph', text: buf.join(' ') });
  }

  return blocks;
}

const HEADING_SIZE: Record<number, number> = { 1: 22, 2: 19, 3: 17, 4: 15.5 };

function Block({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading':
      return (
        <Text
          selectable
          style={{
            fontFamily: fonts.display,
            fontSize: HEADING_SIZE[block.level] ?? 15.5,
            color: colors.text,
            marginTop: space.xs,
          }}>
          <Inline text={block.text} />
        </Text>
      );
    case 'paragraph':
      return (
        <Text selectable variant="body">
          <Inline text={block.text} />
        </Text>
      );
    case 'quote':
      return (
        <View style={styles.quote}>
          <Text selectable variant="body" color={colors.muted} style={{ fontStyle: 'italic' }}>
            <Inline text={block.text} />
          </Text>
        </View>
      );
    case 'code':
      return (
        <View style={styles.code}>
          <Text selectable style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.text }}>{block.text}</Text>
        </View>
      );
    case 'list':
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((item, idx) => (
            <View key={idx} style={styles.listItem}>
              <Text variant="body" color={colors.cyan} style={{ width: 22 }}>
                {block.ordered ? `${idx + 1}.` : '•'}
              </Text>
              <Text selectable variant="body" style={{ flex: 1 }}>
                <Inline text={item} />
              </Text>
            </View>
          ))}
        </View>
      );
  }
}

/** Inline formatting: bold, italic (asterisk or underscore), and inline code. */
function Inline({ text }: { text: string }) {
  const tokens = tokenizeInline(text);
  return (
    <>
      {tokens.map((t, i) => (
        <Fragment key={i}>
          {t.type === 'code' ? (
            <Text style={{ fontFamily: fonts.mono, fontSize: 13.5, color: colors.cyan }}>{t.text}</Text>
          ) : (
            <Text
              style={[
                t.type === 'bold' && { fontFamily: fonts.bodyBold },
                t.type === 'italic' && { fontStyle: 'italic' },
              ]}>
              {t.text}
            </Text>
          )}
        </Fragment>
      ))}
    </>
  );
}

interface InlineToken {
  type: 'text' | 'bold' | 'italic' | 'code';
  text: string;
}

function tokenizeInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|((?:\*|_)([^*_]+)(?:\*|_))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', text: input.slice(last, m.index) });
    if (m[2] !== undefined) tokens.push({ type: 'bold', text: m[2] });
    else if (m[4] !== undefined) tokens.push({ type: 'code', text: m[4] });
    else if (m[6] !== undefined) tokens.push({ type: 'italic', text: m[6] });
    last = re.lastIndex;
  }
  if (last < input.length) tokens.push({ type: 'text', text: input.slice(last) });
  return tokens.length ? tokens : [{ type: 'text', text: input }];
}

const styles = StyleSheet.create({
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.violet,
    paddingLeft: space.md,
    paddingVertical: 2,
  },
  code: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    padding: space.md,
  },
  listItem: { flexDirection: 'row', gap: 4, alignItems: 'flex-start' },
});
