// Minimal, dependency-free markdown renderer for the scholarly analysis text. Supports the
// subset the backend produces: ATX headings, bold/italic, inline code, unordered/ordered
// lists, blockquotes, fenced code, and paragraphs. Deliberately small — not a full CommonMark
// implementation — to keep reading fast and the bundle lean.

import { createContext, Fragment, useContext, useMemo } from 'react';
import { Linking, Platform, StyleSheet, Text as RNText, View } from 'react-native';

import { Text } from '@/ui';
import { colors, fonts, space } from '@/theme/tokens';

// Code is content fidelity, not UI chrome: the design system's Manrope/Newsreader pair has no
// monospace member, so code falls back to the platform's own mono face.
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Called when an inline link is tapped. The discussion screen provides one (via
 *  LinkHandlerContext) that routes `rc-paper:<slug>` links into the in-project paper's discussion
 *  and prompts for external references; elsewhere links just open http(s) URLs externally. */
export type LinkHandler = (href: string, label?: string) => void;

const defaultLinkPress: LinkHandler = (href) => {
  if (/^https?:\/\//i.test(href)) void Linking.openURL(href).catch(() => undefined);
};

/** Lets a screen (the discussion) install a link handler for all Markdown it renders without
 *  threading a prop through every message component. */
export const LinkHandlerContext = createContext<LinkHandler | null>(null);

export function Markdown({ text, onLinkPress }: { text: string; onLinkPress?: LinkHandler }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const contextHandler = useContext(LinkHandlerContext);
  const handleLink = onLinkPress ?? contextHandler ?? defaultLinkPress;
  return (
    <View style={{ gap: space.sm }}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} onLinkPress={handleLink} />
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

// Long-form document type per the redesign: Newsreader for headings and prose (the "reads
// like a document, not chat" principle), Manrope only for the densest level-4 run-ins.
const HEADING_STYLES: Record<number, object> = {
  1: { fontFamily: fonts.serifMedium, fontSize: 24, lineHeight: 30 },
  2: { fontFamily: fonts.serifMedium, fontSize: 21, lineHeight: 27 },
  3: { fontFamily: fonts.serifMedium, fontSize: 18, lineHeight: 24 },
  4: { fontFamily: fonts.bodySemiBold, fontSize: 15.5, lineHeight: 22 },
};

function Block({ block, onLinkPress }: { block: Block; onLinkPress: LinkHandler }) {
  switch (block.kind) {
    case 'heading':
      return (
        <Text
          style={[
            HEADING_STYLES[block.level] ?? HEADING_STYLES[4],
            { color: colors.text, marginTop: space.xs },
          ]}>
          <Inline text={block.text} onLinkPress={onLinkPress} serif={block.level < 4} />
        </Text>
      );
    case 'paragraph':
      return (
        <Text variant="serifBody">
          <Inline text={block.text} onLinkPress={onLinkPress} />
        </Text>
      );
    case 'quote':
      return (
        <View style={styles.quote}>
          <Text variant="serifItalic">
            <Inline text={block.text} onLinkPress={onLinkPress} />
          </Text>
        </View>
      );
    case 'code':
      return (
        <View style={styles.code}>
          <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.text }}>{block.text}</Text>
        </View>
      );
    case 'list':
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((item, idx) => (
            <View key={idx} style={styles.listItem}>
              <Text variant="serifBody" color={colors.mint} style={{ width: 22 }}>
                {block.ordered ? `${idx + 1}.` : '•'}
              </Text>
              <Text variant="serifBody" style={{ flex: 1 }}>
                <Inline text={item} onLinkPress={onLinkPress} />
              </Text>
            </View>
          ))}
        </View>
      );
  }
}

/** Inline formatting: links, bold, italic (asterisk or underscore), and inline code.
 * Spans are raw RN Text so plain tokens INHERIT the enclosing block's typography (the themed
 * Text would stamp its own body variant over serif blocks). Emphasis picks its face from the
 * block context: serif blocks get Newsreader weights/italics, the Manrope level-4 heading
 * path keeps Manrope (best-effort synthetic italic — Manrope ships no italic cut). */
function Inline({
  text,
  onLinkPress,
  serif = true,
}: {
  text: string;
  onLinkPress: LinkHandler;
  serif?: boolean;
}) {
  const tokens = tokenizeInline(text);
  return (
    <>
      {tokens.map((t, i) => (
        <Fragment key={i}>
          {t.type === 'code' ? (
            <RNText style={{ fontFamily: MONO, fontSize: 13.5, color: colors.mint }}>{t.text}</RNText>
          ) : t.type === 'link' ? (
            <RNText
              style={{ color: colors.mint, textDecorationLine: 'underline' }}
              onPress={() => onLinkPress(t.href ?? '', t.text)}>
              {t.text}
            </RNText>
          ) : t.type === 'bold' ? (
            <RNText style={{ fontFamily: serif ? fonts.serifSemiBold : fonts.bodyBold }}>
              {t.text}
            </RNText>
          ) : t.type === 'italic' ? (
            <RNText style={serif ? { fontFamily: fonts.serifItalic } : { fontStyle: 'italic' }}>
              {t.text}
            </RNText>
          ) : (
            <RNText>{t.text}</RNText>
          )}
        </Fragment>
      ))}
    </>
  );
}

interface InlineToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link';
  text: string;
  href?: string;
}

function tokenizeInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  // Link `[label](href)` is matched first so its label isn't consumed by emphasis parsing.
  const re = /(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(`([^`]+)`)|((?:\*|_)([^*_]+)(?:\*|_))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', text: input.slice(last, m.index) });
    if (m[2] !== undefined) tokens.push({ type: 'link', text: m[2], href: m[3] });
    else if (m[5] !== undefined) tokens.push({ type: 'bold', text: m[5] });
    else if (m[7] !== undefined) tokens.push({ type: 'code', text: m[7] });
    else if (m[9] !== undefined) tokens.push({ type: 'italic', text: m[9] });
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
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    padding: space.md,
  },
  listItem: { flexDirection: 'row', gap: 4, alignItems: 'flex-start' },
});
