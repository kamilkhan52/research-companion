// Minimal markdown renderer for the scholarly analysis text. Supports the subset the backend
// produces: ATX headings, bold/italic, inline code, unordered/ordered lists, blockquotes,
// fenced code, paragraphs, and TeX math (`\( \)` inline, `\[ \]` / `$$ $$` display — see
// MathView). Deliberately small — not a full CommonMark implementation — to keep reading
// fast and the bundle lean.

import { createContext, Fragment, useContext, useMemo } from 'react';
import { Linking, Platform, StyleSheet, Text as RNText, View } from 'react-native';
// RNGH's ScrollView, not core RN's: the discussion renders messages inside gifted-chat's
// inverted list under a gesture-handler hierarchy, where a core horizontal ScrollView loses
// the Android gesture negotiation and simply doesn't pan.
import { ScrollView } from 'react-native-gesture-handler';

import { FigureCard } from '@/components/FigureCard';
import { InlineMath, MathBlock } from '@/components/MathView';
import type { PaperFigure } from '@/api/types';
import { planFigurePlacement } from '@/lib/figures';
import { RC_SEARCH_PREFIX } from '@/lib/paperLinks';
import { stripPseudoToolTags } from '@/lib/toolTags';
import { Icon, Text } from '@/ui';
import { useDensity, useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, space, type ThemePalette } from '@/theme/tokens';

/** When present, the paper's figures are carded inline immediately before the first paragraph that
 *  references each one (R.10). Absent everywhere except the committed discussion transcript,
 *  so every other Markdown surface (notes, streaming) renders exactly as before. */
export interface FigureContext {
  pid: string;
  slug: string;
  figures: PaperFigure[];
  /** Manifest fetched_ts, forwarded to figureAssetSource for cache-busting. */
  version?: number | null;
}

export interface SentenceAnnotationVisual {
  selected?: boolean;
  annotated?: boolean;
  commentCount?: number;
}

/** Opt-in sentence interaction for one assistant message. Ordinary Markdown callers omit
 *  this, so notes, streaming text, and non-annotated messages keep the exact existing path. */
export interface SentenceAnnotations {
  active: boolean;
  onSentencePress: (quote: string) => void;
  stateForSentence?: (quote: string) => SentenceAnnotationVisual | undefined;
}

// Code is content fidelity, not UI chrome: the design system's Manrope/Newsreader pair has no
// monospace member, so code falls back to the platform's own mono face.
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Called when an inline link is tapped. The discussion screen provides one (via
 *  LinkHandlerContext) that routes `rc-paper:<slug>` links into the in-project paper's discussion,
 *  `rc-search:<title>` links (DR-054 — a citation with no sourceable URL) into a title-search
 *  fallback, and prompts for external URL references; elsewhere links just open http(s) URLs
 *  externally. */
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

export function Markdown({
  text,
  onLinkPress,
  figureContext,
  sentenceAnnotations,
}: {
  text: string;
  onLinkPress?: LinkHandler;
  figureContext?: FigureContext;
  sentenceAnnotations?: SentenceAnnotations;
}) {
  // Old transcripts may carry leaked `<search for="…">` pseudo tool tags (G.2); the backend
  // cleans new ones before recording, this pass cleans the archive at render time.
  const blocks = useMemo(() => parseBlocks(stripPseudoToolTags(text)), [text]);
  const contextHandler = useContext(LinkHandlerContext);
  const density = useDensity();
  const papers = useContext(PaperIndexContext);
  const matcher = useMemo(() => (papers?.length ? buildTitleMatcher(papers) : null), [papers]);
  const handleLink = onLinkPress ?? contextHandler ?? defaultLinkPress;
  // Which figures to card after each block — resolved at render time against the paper's
  // current manifest (a late-arriving manifest cards older turns on the next render).
  const figureCards = useMemo(() => {
    const figures = figureContext?.figures;
    if (!figures?.length) return null;
    const texts = blocks.map((b) => (b.kind === 'paragraph' ? b.text : null));
    return planFigurePlacement(texts, figures);
  }, [blocks, figureContext?.figures]);
  return (
    <TitleMatcherContext.Provider value={matcher}>
      <View style={{ gap: density === 'tight' ? 6 : space.sm }}>
        {blocks.map((block, i) => (
          <Fragment key={i}>
            {/* BEFORE the block that first mentions the figure, not after it (DR-003). Carding
                after meant reading "as Figure 3 shows, the loss diverges", scrolling past the
                rest of the paragraph, and only then meeting Figure 3 — by which point the
                sentence it illustrates is off-screen. */}
            {figureCards?.[i]?.map((fig) => (
              <FigureCard
                key={fig.id}
                pid={figureContext!.pid}
                slug={figureContext!.slug}
                figure={fig}
                version={figureContext!.version}
              />
            ))}
            <Block
              block={block}
              onLinkPress={handleLink}
              sentenceAnnotations={sentenceAnnotations}
            />
          </Fragment>
        ))}
      </View>
    </TitleMatcherContext.Provider>
  );
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; text: string }
  | { kind: 'math'; tex: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

// An ordered item keeps its SOURCE number: models separate numbered points with blank lines,
// which splits one logical list into several one-item blocks — rendering positional indexes
// made every one of them "1.".
interface ListItem {
  text: string;
  num: number | null;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
// Models glue the hashes to the title often enough ("###AWQ: Adoption…", plausibly bleed
// from the ###MARKER### output protocol) that 2+ hashes with no space still count as a
// heading. A single glued hash stays prose (#hashtag, #include).
const GLUED_HEADING_RE = /^(#{2,6})([^#\s].*)$/;

function matchHeading(line: string): { level: number; text: string } | null {
  const m = HEADING_RE.exec(line) ?? GLUED_HEADING_RE.exec(line);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
}

// GFM pipe table: a header row containing `|` directly above a delimiter row of dashes/colons
// and pipes (at least two columns — a one-column "table" is prose with a stray pipe).
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

const tableStartAt = (lines: string[], i: number) =>
  lines[i].includes('|') && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1]);

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((cell) => cell.trim());
}

// Thematic break (`---` / `***` / `___`, optionally space-separated à la CommonMark). Models
// separate sections with these constantly; without this rule they rendered as literal "---".
const isThematicBreak = (line: string) => /^(-{3,}|_{3,}|\*{3,})$/.test(line.replace(/\s+/g, ''));

// A paragraph that is nothing but one display-math span renders as a standalone equation
// block: `\[ … \]` (the output contract) or `$$ … $$` (compatibility with existing text).
const DISPLAY_MATH_RE = /^(?:\\\[([\s\S]+)\\\]|\$\$([\s\S]+)\$\$)$/;
const SENTENCE_END_RE = /(?<=[.!?])(?:["”’')\]]*)\s+/g;

/** Sentence/block granularity for the mobile annotation flow. This deliberately matches the
 *  preview-cue boundary: terminal punctuation followed by whitespace. The final fragment is
 *  included because it is stable committed text even when it has no terminal punctuation. */
export function splitAnnotatableSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  SENTENCE_END_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END_RE.exec(text)) !== null) {
    const sentence = text.slice(start, SENTENCE_END_RE.lastIndex).trim();
    if (sentence) sentences.push(sentence);
    start = SENTENCE_END_RE.lastIndex;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

/** A math span that occupies its whole source line belongs to block layout even when the model
 * used inline delimiters (`\( … \)`). This matters especially inside Markdown blockquotes:
 * keeping a long standalone formula inside an RN Text node makes it an indivisible inline view,
 * where it can neither wrap nor host a horizontal ScrollView. */
function standaloneMathAt(lines: string[], index: number): { tex: string; next: number } | null {
  const line = lines[index].trim();
  const inline = /^\\\(([\s\S]+)\\\)$/.exec(line);
  if (inline) return { tex: inline[1].trim(), next: index + 1 };

  for (const [open, close] of [['\\[', '\\]'], ['$$', '$$']] as const) {
    if (!line.startsWith(open)) continue;
    const first = line.slice(open.length);
    if (first.endsWith(close)) {
      return { tex: first.slice(0, -close.length).trim(), next: index + 1 };
    }
    // A closer followed by prose is not a standalone math block; leave the whole line to the
    // inline tokenizer instead of scanning ahead and accidentally swallowing later content.
    if (first.includes(close)) return null;
    const body = [first];
    for (let i = index + 1; i < lines.length; i++) {
      const part = lines[i].trim();
      if (part.endsWith(close)) {
        body.push(part.slice(0, -close.length));
        return { tex: body.join('\n').trim(), next: i + 1 };
      }
      if (part.includes(close)) return null;
      body.push(lines[i]);
    }
  }
  return null;
}

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

    const math = standaloneMathAt(lines, i);
    if (math) {
      blocks.push({ kind: 'math', tex: math.tex });
      i = math.next;
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
    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading.level, text: heading.text });
      i++;
      continue;
    }

    // Thematic break — must run before the list check: CommonMark gives `- - -` to the break,
    // not to a bullet list.
    if (isThematicBreak(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    // Pipe table — before the list/paragraph checks so the delimiter row is consumed here.
    if (tableStartAt(lines, i)) {
      const header = splitTableRow(lines[i]);
      i += 2; // header + delimiter
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      // Parse the quote's contents recursively so formula-only quote lines become MathBlock
      // children with a bounded scroll viewport instead of clipped InlineMath inside Text.
      blocks.push({ kind: 'quote', blocks: parseBlocks(buf.join('\n')) });
      continue;
    }

    // List (unordered or ordered)
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: ListItem[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const marker = /^\s*(?:[-*]|(\d+)\.)\s+/.exec(lines[i]);
        items.push({
          text: lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''),
          num: marker?.[1] ? parseInt(marker[1], 10) : null,
        });
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
      !matchHeading(lines[i]) &&
      !lines[i].startsWith('>') &&
      !lines[i].trim().startsWith('```') &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !isThematicBreak(lines[i]) &&
      !tableStartAt(lines, i) &&
      !standaloneMathAt(lines, i)
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
const TIGHT_HEADING_STYLES: Record<number, object> = {
  1: { fontFamily: fonts.serifMedium, fontSize: 22, lineHeight: 27 },
  2: { fontFamily: fonts.serifMedium, fontSize: 19, lineHeight: 24 },
  3: { fontFamily: fonts.serifMedium, fontSize: 17, lineHeight: 22 },
  4: { fontFamily: fonts.bodySemiBold, fontSize: 14.5, lineHeight: 20 },
};

function Block({
  block,
  onLinkPress,
  sentenceAnnotations,
}: {
  block: Block;
  onLinkPress: LinkHandler;
  sentenceAnnotations?: SentenceAnnotations;
}) {
  const t = useTheme();
  const density = useDensity();
  const styles = useThemedStyles(makeStyles);
  const headingStyles = density === 'tight' ? TIGHT_HEADING_STYLES : HEADING_STYLES;
  switch (block.kind) {
    case 'heading':
      return (
        <Text
          style={[
            headingStyles[block.level] ?? headingStyles[4],
            { color: t.text, marginTop: space.xs },
          ]}>
          <Inline text={block.text} onLinkPress={onLinkPress} serif={block.level < 4} />
        </Text>
      );
    case 'paragraph':
      if (sentenceAnnotations?.active) {
        return (
          <AnnotatableParagraph
            text={block.text}
            onLinkPress={onLinkPress}
            annotations={sentenceAnnotations}
          />
        );
      }
      return (
        <Text variant="serifBody">
          <Inline text={block.text} onLinkPress={onLinkPress} />
        </Text>
      );
    case 'quote':
      return (
        <View style={styles.quote}>
          {block.blocks.map((child, index) => (
            child.kind === 'paragraph' ? (
              <Text key={index} variant="serifItalic">
                <Inline text={child.text} onLinkPress={onLinkPress} />
              </Text>
            ) : (
              <Block
                key={index}
                block={child}
                onLinkPress={onLinkPress}
                sentenceAnnotations={sentenceAnnotations}
              />
            )
          ))}
        </View>
      );
    case 'code':
      return (
        <View style={styles.code}>
          <Text style={{ fontFamily: MONO, fontSize: 13, color: t.text }}>{block.text}</Text>
        </View>
      );
    case 'math':
      return <MathBlock tex={block.tex} />;
    case 'rule':
      return <View testID="md-rule" style={styles.rule} />;
    case 'table':
      return <MdTable block={block} onLinkPress={onLinkPress} />;
    case 'list': {
      const ordinals = block.items.map((item, idx) => listOrdinal(block, idx));
      const markerWidth = Math.max(22, ...ordinals.map((o) => o.length * 9));
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((item, idx) => (
            <View key={idx} style={styles.listItem}>
              <Text variant="serifBody" color={t.mint} style={{ width: markerWidth }}>
                {ordinals[idx]}
              </Text>
              <Text variant="serifBody" style={{ flex: 1 }}>
                <Inline text={item.text} onLinkPress={onLinkPress} />
              </Text>
            </View>
          ))}
        </View>
      );
    }
  }
}

function AnnotatableParagraph({
  text,
  onLinkPress,
  annotations,
}: {
  text: string;
  onLinkPress: LinkHandler;
  annotations: SentenceAnnotations;
}) {
  const t = useTheme();
  const sentences = useMemo(() => splitAnnotatableSentences(text), [text]);
  return (
    <Text variant="serifBody">
      {sentences.map((sentence, index) => {
        // Queue/display the sentence the reader actually sees, not its Markdown control
        // syntax (`[label](url)`, emphasis markers). Equations retain explicit TeX delimiters
        // so the agent still receives the precise formula being discussed.
        const quote = annotationQuote(sentence);
        const state = annotations.stateForSentence?.(quote);
        return (
          <Fragment key={`${index}:${sentence}`}>
            <RNText
              testID={`md-sentence-${index}`}
              accessibilityRole="button"
              accessibilityLabel={`Comment on: ${quote}`}
              accessibilityState={{ selected: !!state?.selected }}
              onPress={() => annotations.onSentencePress(quote)}
              style={{
                backgroundColor: state?.selected ? t.violetWash : undefined,
                borderLeftColor: state?.annotated ? t.violet : undefined,
                borderLeftWidth: state?.annotated ? 2 : 0,
                paddingLeft: state?.annotated ? 2 : 0,
                textDecorationColor: state?.annotated ? t.violet : undefined,
                textDecorationLine: state?.annotated ? 'underline' : 'none',
              }}>
              <Inline text={sentence} onLinkPress={onLinkPress} suppressLinks />
              {state?.commentCount ? (
                <RNText
                  accessibilityLabel={`${state.commentCount} attached comments`}
                  style={{
                    backgroundColor: t.violet,
                    color: t.bg,
                    fontFamily: fonts.bodyBold,
                    fontSize: 10,
                  }}>
                  {` ${state.commentCount} `}
                </RNText>
              ) : null}
            </RNText>
            {index < sentences.length - 1 ? ' ' : null}
          </Fragment>
        );
      })}
    </Text>
  );
}

/** The marker for item `idx`. Ordered items keep their SOURCE number — a blank-line-separated
 * "3." arrives as its own single-item block and must not restart at 1 — except lazy numbering
 * (every marker repeats the same number), which CommonMark defines as auto-increment. */
function listOrdinal(block: { ordered: boolean; items: ListItem[] }, idx: number): string {
  if (!block.ordered) return '•';
  const nums = block.items.map((item) => item.num);
  const first = nums[0] ?? 1;
  const lazy = block.items.length > 1 && nums.every((n) => n === first);
  const num = lazy || nums[idx] == null ? first + idx : nums[idx];
  return `${num}.`;
}

/** GFM pipe table. Up to three columns it FITS the screen — proportional flex columns, cells
 * wrap — because on a phone a fully visible table beats a pannable one. Wider tables get
 * fixed column widths (character-count heuristic; RN has no auto table layout) inside a
 * horizontal viewport with nestedScrollEnabled, so the pan works inside the inverted
 * message list on Android. */
function MdTable({
  block,
  onLinkPress,
}: {
  block: { header: string[]; rows: string[][] };
  onLinkPress: LinkHandler;
}) {
  const styles = useThemedStyles(makeStyles);
  const nCols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
  const chars: number[] = [];
  for (let c = 0; c < nCols; c++) {
    chars.push(Math.max(
      plainLength(block.header[c] ?? ''),
      ...block.rows.map((row) => plainLength(row[c] ?? '')),
    ));
  }
  const fits = nCols <= 3;
  // Flex weights are clamped so one verbose column can't crush a terse one to a sliver.
  const weights = chars.map((n) => Math.min(60, Math.max(12, n)));
  const renderRow = (cells: string[], key: number | string, head = false) => (
    <View key={key} style={[styles.tableRow, head && styles.tableHead]}>
      {Array.from({ length: nCols }, (_, c) => (
        <View
          key={c}
          style={[
            styles.tableCell,
            fits
              ? { flex: weights[c], minWidth: 0 }
              : { width: Math.min(280, Math.max(72, 20 + chars[c] * 6.4)) },
          ]}>
          <Text
            variant="serifBody"
            style={head ? { fontFamily: fonts.serifSemiBold } : undefined}>
            <Inline text={cells[c] ?? ''} onLinkPress={onLinkPress} />
          </Text>
        </View>
      ))}
    </View>
  );
  const body = (
    <View>
      {renderRow(block.header, 'head', true)}
      {block.rows.map((row, r) => renderRow(row, r))}
    </View>
  );
  if (fits) {
    return (
      <View testID="md-table" style={styles.tableWrap}>
        {body}
      </View>
    );
  }
  return (
    <ScrollView
      testID="md-table"
      accessibilityLabel="Scrollable table"
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      style={styles.tableWrap}>
      {body}
    </ScrollView>
  );
}

/** Approximate visible length of a cell once link syntax and emphasis markers collapse. */
function plainLength(cell: string): number {
  return cell
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .length;
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
  suppressLinks = false,
}: {
  text: string;
  onLinkPress: LinkHandler;
  serif?: boolean;
  suppressLinks?: boolean;
}) {
  // `theme`, not `t`: renderToken's token param below is named `t`, which would shadow it.
  const theme = useTheme();
  const matcher = useContext(TitleMatcherContext);
  let tokens = tokenizeInline(text);
  if (matcher) tokens = linkifyTitles(tokens, matcher);
  const renderToken = (t: InlineToken, i: number) => (
        <Fragment key={i}>
          {t.type === 'math' ? (
            <InlineMath tex={t.text} />
          ) : t.type === 'code' ? (
            <RNText style={{ fontFamily: MONO, fontSize: 13.5, color: theme.mint }}>{t.text}</RNText>
          ) : t.type === 'link' ? (
            t.href?.startsWith('rc-paper:') ? (
              // A project paper — a *relationship* (design system: violet), rendered as a
              // purpose-built reference: small paper glyph + violet semibold name, no underline.
              // Tapping opens the paper's action sheet (via the rc-paper link handler).
              <RNText
                onPress={suppressLinks ? undefined : () => onLinkPress(t.href ?? '', t.text)}
                style={{
                  color: theme.violet,
                  fontFamily: serif ? fonts.serifSemiBold : fonts.bodySemiBold,
                }}>
                <Icon name="book-open" size={serif ? 13 : 12} color={theme.violet} />
                {/* U+202F narrow no-break space: the previous U+2009 thin space is a
                    legal break point (UAX #14), so long lines wrapped BETWEEN the glyph
                    and the title, stranding the icon at the end of the prior line. */}
                {' '}
                {t.text}
              </RNText>
            ) : t.href?.startsWith(RC_SEARCH_PREFIX) ? (
              // DR-054: a work the model has a name for but no sourceable URL for — an
              // app-internal marker instead of a fabricated link. Search-icon prefix (no
              // underline) signals "opens options to look this up", distinct from both a
              // direct external link and an in-project relationship.
              <RNText
                onPress={suppressLinks ? undefined : () => onLinkPress(t.href ?? '', t.text)}
                style={{ color: theme.mint, fontFamily: serif ? fonts.serifSemiBold : fonts.bodySemiBold }}>
                <Icon name="search" size={serif ? 13 : 12} color={theme.mint} />
                {' '}
                {t.text}
              </RNText>
            ) : (
              <RNText
                style={{ color: theme.mint, textDecorationLine: 'underline' }}
                onPress={suppressLinks ? undefined : () => onLinkPress(t.href ?? '', t.text)}>
                {t.text}
              </RNText>
            )
          ) : t.type === 'bold' ? (
            // Children inherit the bold face through RN Text nesting, so a link inside a
            // bold span keeps its link styling on top of the inherited weight.
            <RNText style={{ fontFamily: serif ? fonts.serifSemiBold : fonts.bodyBold }}>
              {t.children ? t.children.map(renderToken) : t.text}
            </RNText>
          ) : t.type === 'italic' ? (
            <RNText style={serif ? { fontFamily: fonts.serifItalic } : { fontStyle: 'italic' }}>
              {t.children ? t.children.map(renderToken) : t.text}
            </RNText>
          ) : (
            <RNText>{t.text}</RNText>
          )}
        </Fragment>
  );
  return <>{tokens.map(renderToken)}</>;
}

interface InlineToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'math';
  text: string;
  href?: string;
  /** Emphasis content when it holds more than plain text (a link, code, or math inside a
   *  bold/italic span); the common plain case leaves this unset and renders as before. */
  children?: InlineToken[];
}

function annotationQuote(raw: string): string {
  const plain = (tokens: InlineToken[]): string => tokens.map((token) => {
    if (token.children) return plain(token.children);
    if (token.type === 'math') return `\\(${token.text}\\)`;
    return token.text;
  }).join('');
  return plain(tokenizeInline(raw)).trim();
}

/** Split plain-text tokens on exact known-title mentions, turning each into an rc-paper
 *  link token. Code and link tokens pass through untouched, so an authored link label is
 *  never re-linkified; emphasis tokens recurse into their nested content. */
function linkifyTitles(tokens: InlineToken[], matcher: TitleMatcher): InlineToken[] {
  const out: InlineToken[] = [];
  for (const t of tokens) {
    if (t.type !== 'text') {
      out.push(t.children ? { ...t, children: linkifyTitles(t.children, matcher) } : t);
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

/** An emphasis span whose content is more than plain text ("**[label](url)** and more")
 *  nests its parsed content as children; the emphasis regexes exclude their own delimiter
 *  characters, so the recursion cannot revisit an emphasis branch and always terminates. */
function emphasisToken(type: 'bold' | 'italic', content: string): InlineToken {
  const kids = tokenizeInline(content);
  const plain = kids.length === 1 && kids[0].type === 'text';
  return plain ? { type, text: content } : { type, text: content, children: kids };
}

/** A common model malformation: the link target written INSIDE the brackets —
 *  "[PIM-LLM (rc-paper:pim-llm)]" or "[Name (https://…)]" — invalid markdown that rendered as
 *  literal bracketed text. Repaired into a proper link before tokenizing; a legitimate
 *  parenthetical like "[GPTQ (Frantar et al., 2022)](url)" never matches because its
 *  parenthetical does not start with a link scheme. */
const MALFORMED_LINK_RE = /\[([^\[\]()]+?)\s*\(((?:rc-paper:|rc-search:|https?:\/\/)[^\s()]+)\)\]/g;

function tokenizeInline(rawInput: string): InlineToken[] {
  const input = rawInput.replace(MALFORMED_LINK_RE, '[$1]($2)');
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
    else if (m[10] !== undefined) tokens.push(emphasisToken('bold', m[10]));
    else if (m[12] !== undefined) tokens.push({ type: 'code', text: m[12] });
    else if (m[14] !== undefined) tokens.push(emphasisToken('italic', m[14]));
    last = re.lastIndex;
  }
  if (last < input.length) tokens.push({ type: 'text', text: input.slice(last) });
  return tokens.length ? tokens : [{ type: 'text', text: input }];
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: t.line,
    marginVertical: space.xs,
  },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: t.violet,
    paddingLeft: space.md,
    paddingVertical: 2,
    gap: space.sm,
  },
  code: {
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: 10,
    padding: space.md,
  },
  listItem: { flexDirection: 'row', gap: 4, alignItems: 'flex-start' },
  tableWrap: {
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: 10,
  },
  tableRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.line,
  },
  tableHead: { borderTopWidth: 0, backgroundColor: t.elevated },
  tableCell: { paddingVertical: 6, paddingHorizontal: 10 },
});
