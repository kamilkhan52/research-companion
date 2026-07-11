// Minimal markdown renderer for the scholarly analysis text. Supports the subset the backend
// produces: ATX headings, bold/italic, inline code, unordered/ordered lists, blockquotes,
// fenced code, paragraphs, and TeX math (`\( \)` inline, `\[ \]` / `$$ $$` display — see
// MathView). Deliberately small — not a full CommonMark implementation — to keep reading
// fast and the bundle lean.

import { createContext, Fragment, useContext, useMemo } from 'react';
import { Linking, Platform, StyleSheet, Text as RNText, View } from 'react-native';

import { InlineMath, MathBlock } from '@/components/MathView';
import { stripPseudoToolTags } from '@/lib/toolTags';
import { Icon, Text } from '@/ui';
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

/** The active project's papers, provided app-wide (PaperEntityProvider), so any rendered
 *  Markdown recognizes an exact paper-title mention and turns it into a live rc-paper link.
 *  Deterministic by design: whole-title matches only, no fuzzy matching — a false paper link
 *  is worse than a missed one. */
export const PaperIndexContext = createContext<{ title: string; slug: string }[] | null>(null);

interface TitleMatcher {
  re: RegExp;
  slugByTitle: Map<string, string>;
}

const TitleMatcherContext = createContext<TitleMatcher | null>(null);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One alternation over every known title, longest first so a superset title wins over a
 *  title that happens to be its prefix. Case-insensitive; very short titles are skipped —
 *  they collide with ordinary prose too easily. */
function buildTitleMatcher(papers: { title: string; slug: string }[]): TitleMatcher | null {
  const usable = papers.filter((p) => p.title.trim().length >= 12);
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => b.title.length - a.title.length);
  return {
    re: new RegExp(sorted.map((p) => escapeRegExp(p.title.trim())).join('|'), 'gi'),
    slugByTitle: new Map(sorted.map((p) => [p.title.trim().toLowerCase(), p.slug])),
  };
}

export function Markdown({ text, onLinkPress }: { text: string; onLinkPress?: LinkHandler }) {
  // Old transcripts may carry leaked `<search for="…">` pseudo tool tags (G.2); the backend
  // cleans new ones before recording, this pass cleans the archive at render time.
  const blocks = useMemo(() => parseBlocks(stripPseudoToolTags(text)), [text]);
  const contextHandler = useContext(LinkHandlerContext);
  const papers = useContext(PaperIndexContext);
  const matcher = useMemo(() => (papers?.length ? buildTitleMatcher(papers) : null), [papers]);
  const handleLink = onLinkPress ?? contextHandler ?? defaultLinkPress;
  return (
    <TitleMatcherContext.Provider value={matcher}>
      <View style={{ gap: space.sm }}>
        {blocks.map((block, i) => (
          <Block key={i} block={block} onLinkPress={handleLink} />
        ))}
      </View>
    </TitleMatcherContext.Provider>
  );
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'math'; tex: string };

// A paragraph that is nothing but one display-math span renders as a standalone equation
// block: `\[ … \]` (the output contract) or `$$ … $$` (compatibility with existing text).
const DISPLAY_MATH_RE = /^(?:\\\[([\s\S]+)\\\]|\$\$([\s\S]+)\$\$)$/;

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
    const text = buf.join(' ');
    const display = DISPLAY_MATH_RE.exec(text.trim());
    if (display) blocks.push({ kind: 'math', tex: (display[1] ?? display[2]).trim() });
    else blocks.push({ kind: 'paragraph', text });
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
    case 'math':
      return <MathBlock tex={block.tex} />;
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
  const matcher = useContext(TitleMatcherContext);
  let tokens = tokenizeInline(text);
  if (matcher) tokens = linkifyTitles(tokens, matcher);
  return (
    <>
      {tokens.map((t, i) => (
        <Fragment key={i}>
          {t.type === 'math' ? (
            <InlineMath tex={t.text} />
          ) : t.type === 'code' ? (
            <RNText style={{ fontFamily: MONO, fontSize: 13.5, color: colors.mint }}>{t.text}</RNText>
          ) : t.type === 'link' ? (
            t.href?.startsWith('rc-paper:') ? (
              // A project paper — a *relationship* (design system: violet), rendered as a
              // purpose-built reference: small paper glyph + violet semibold name, no underline.
              // Tapping opens the paper's action sheet (via the rc-paper link handler).
              <RNText
                onPress={() => onLinkPress(t.href ?? '', t.text)}
                style={{
                  color: colors.violet,
                  fontFamily: serif ? fonts.serifSemiBold : fonts.bodySemiBold,
                }}>
                <Icon name="book-open" size={serif ? 13 : 12} color={colors.violet} />
                {' '}
                {t.text}
              </RNText>
            ) : (
              <RNText
                style={{ color: colors.mint, textDecorationLine: 'underline' }}
                onPress={() => onLinkPress(t.href ?? '', t.text)}>
                {t.text}
              </RNText>
            )
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
  type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'math';
  text: string;
  href?: string;
}

/** Split plain-text tokens on exact known-title mentions, turning each into an rc-paper
 *  link token. Code, link, and emphasis tokens pass through untouched, so an authored link
 *  label is never re-linkified. */
function linkifyTitles(tokens: InlineToken[], matcher: TitleMatcher): InlineToken[] {
  const out: InlineToken[] = [];
  for (const t of tokens) {
    if (t.type !== 'text') {
      out.push(t);
      continue;
    }
    let last = 0;
    let m: RegExpExecArray | null;
    matcher.re.lastIndex = 0;
    while ((m = matcher.re.exec(t.text)) !== null) {
      const slug = matcher.slugByTitle.get(m[0].trim().toLowerCase());
      if (!slug) continue;
      if (m.index > last) out.push({ type: 'text', text: t.text.slice(last, m.index) });
      out.push({ type: 'link', text: m[0], href: `rc-paper:${slug}` });
      last = matcher.re.lastIndex;
    }
    if (last === 0) out.push(t);
    else if (last < t.text.length) out.push({ type: 'text', text: t.text.slice(last) });
  }
  return out;
}

function tokenizeInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  // Math is matched first — TeX is full of `_` and `*` that the emphasis rules would chew
  // up. `\( … \)` is the inline output contract; `\[ … \]` / `$$ … $$` occurring
  // mid-paragraph render inline too (the block form is handled in parseBlocks). Conservatively
  // accept `$ … $` as compatibility syntax: surrounding whitespace and a strong math signal
  // (a variable, TeX command, script, equality, or Greek letter) are required, and the body may
  // not start with a digit. Escaped dollars and numeric spans stay prose, so prices cannot
  // consume the text between them. Numeric equations must use the explicit `\( … \)` contract.
  // Then link `[label](href)`, so its label isn't consumed by emphasis parsing.
  const re =
    /(\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|(?<!\\)\$(?!\$|\s|\d)(?=[^$\n]*(?:[A-Za-z\\_^=]|[\u0370-\u03ff]))([^$\n]*?\S)(?<!\\)\$(?!\$))|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(`([^`]+)`)|((?:\*|_)([^*_]+)(?:\*|_))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', text: input.slice(last, m.index) });
    if (m[1] !== undefined) {
      tokens.push({ type: 'math', text: (m[2] ?? m[3] ?? m[4] ?? m[5]).trim() });
    } else if (m[7] !== undefined) tokens.push({ type: 'link', text: m[7], href: m[8] });
    else if (m[10] !== undefined) tokens.push({ type: 'bold', text: m[10] });
    else if (m[12] !== undefined) tokens.push({ type: 'code', text: m[12] });
    else if (m[14] !== undefined) tokens.push({ type: 'italic', text: m[14] });
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
