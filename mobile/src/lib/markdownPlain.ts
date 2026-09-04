// DR-120 — Kamil, on a DevTest item's description: "an unformatted plain text jumble with links
// etc not formatted."
//
// The card renders that description twice: formatted, once it is expanded (a `<Markdown>`
// render), and as a three-line PREVIEW while it is collapsed.
//
// DR-128 — Kamil, on DR-120: "When 'Show details' is pressed, it renders the markdown, but stays
// unrendered still when compacted (Hide details; default). Fix that and it should be all good."
// He is right, and the preview was the half he sees FIRST. Collapsing relies on `numberOfLines`,
// which only a single `<Text>` honours — but a `<Text>` NESTED inside that one still clamps with
// it, so inline formatting was always available there; only block layout was not. So this file
// now has two readers, sharing one block layer:
//
//   - `markdownToInlineSource` flattens the BLOCK structure and leaves the inline syntax
//     standing, for `MarkdownRuns` (Markdown.tsx) to render as nested Text runs. Flattening
//     headings, bullets and fences is the right answer for three lines, not a compromise.
//   - `markdownToPlain` goes all the way to words, still needed wherever the text must be a
//     plain string — an `accessibilityLabel` being the case that pays for it here.
//
// Deliberately smaller than a parser: it recognizes exactly the constructs `Markdown.tsx` itself
// renders, and every pattern is linear (no nested quantifiers), because this runs on every card
// in a list of 120.

/** Where an escaped character waits out the stripping passes. A control character, so no ledger
 *  prose can contain one and be mistaken for a parked escape. */
const SENTINEL = '\u0000';

/** Escaped punctuation goes behind a sentinel FIRST and comes back last. It cannot simply be
 *  unescaped at either end: unescape early and `\*` becomes a live emphasis marker that eats the
 *  words on both sides of it; unescape late and the emphasis pass has already eaten them. A
 *  ledger row lives in a markdown TABLE, so its pipes must be escaped, and DR-116's cell really
 *  does carry `query.trim() \|\| filter !== 'all'`.
 *
 *  `(` and `)` are deliberately NOT in the set: `\(` and `\)` are this app's inline-math
 *  delimiters (see MathView), and unescaping them would silently dissolve every equation.
 *
 *  Parked as a CHARACTER CODE, not as the character behind a marker: leaving the `*` itself in
 *  the string would let the emphasis pass find and pair it however it was flagged. */
function parkEscapes(md: string): string {
  return md.replace(/\\([\\`*_{}[\]#+\-.!|>~])/g,
    (_m, c: string) => `${SENTINEL}${c.charCodeAt(0)}${SENTINEL}`);
}

/** The parked escapes back as their bare characters, now that nothing will read them as syntax.
 *
 *  Exported because the inline reader unparks per RENDERED RUN rather than up front: the
 *  sentinel has to survive inline tokenizing for the same reason it has to survive the emphasis
 *  pass — an unparked `\*` is an emphasis marker again the moment anything looks at it. */
export function restoreEscapes(s: string): string {
  return s.replace(/\u0000(\d+)\u0000/g, (_m, code: string) => String.fromCharCode(Number(code)));
}

/** The block layer both readers share: fenced-code delimiters, heading hashes, blockquote
 *  carets, list bullets, setext underlines and thematic breaks, all gone.
 *
 *  `keepLinks` is what separates the two. The inline reader leaves link syntax standing for the
 *  tokenizer downstream; the plain reader drops it HERE, before the line-leading rules run,
 *  which is the order it has always used — a link stripped first means `[- x](url)` reduces to
 *  the word, where stripping it afterwards would leave a stray bullet behind. Keeping the link
 *  whole has no such hazard: a line starting `[` matches none of the leading-marker rules. */
function flattenBlocks(md: string, keepLinks: boolean): string {
  let out = md;
  // Fenced-code delimiters, not the code inside them: the content is the only part that reads.
  out = out.replace(/^ {0,3}(?:```|~~~).*$/gm, '');
  // Images before links — an image IS a link with a `!`, so the link rule would eat the `!` and
  // leave the alt text looking like ordinary prose with a stray bang. The alt text is all an
  // image can contribute to a run of text either way, so both readers reduce it the same.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  if (!keepLinks) out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // `<https://…>` autolinks keep the URL: it is the whole content of that construct, and the
  // inline tokenizer has no rule for the angle-bracket form.
  out = out.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1');
  // Leading block markers, line by line: heading hashes, blockquote carets, list bullets.
  out = out.replace(/^ {0,3}#{1,6}[ \t]+/gm, '');
  out = out.replace(/^ {0,3}>[ \t]?/gm, '');
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  out = out.replace(/^[ \t]*\d{1,9}[.)][ \t]+/gm, '');
  // A setext underline or a thematic break is pure syntax; the line above it is the content.
  return out.replace(/^ {0,3}(?:-{3,}|={3,}|\*{3,}|_{3,})[ \t]*$/gm, '');
}

/** One line of prose: a table cell has no line structure to preserve, and `numberOfLines` wants
 *  to do the wrapping itself. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Strip markdown syntax down to the words, for somewhere that needs a plain string.
 *
 *  Not a renderer and not reversible: link targets, code fences and emphasis markers are
 *  dropped, and all whitespace collapses to single spaces. Math (`\( … \)`) is left exactly as
 *  written — a half-stripped equation reads worse than the source. */
export function markdownToPlain(md: string): string {
  if (!md) return '';
  let out = flattenBlocks(parkEscapes(md), false);
  // Inline code: the ticks go, the identifier inside stays.
  out = out.replace(/`+([^`]*)`+/g, '$1');
  // Emphasis. Asterisks are unambiguous; underscores are NOT — `how_to_test` and `_ROW_RE` are
  // ordinary words in this ledger's prose, so underscore emphasis is taken only when the run is
  // bounded by non-word characters, the same rule CommonMark uses for intraword `_`.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*\n]+)\*/g, '$1');
  out = out.replace(/(^|\W)__([^_]+)__(?=\W|$)/g, '$1$2');
  out = out.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2');
  return oneLine(restoreEscapes(out));
}

/** Markdown with its BLOCK structure flattened away and its INLINE syntax left standing, for a
 *  clamped preview to render as nested Text runs (`MarkdownRuns`).
 *
 *  **Not a display string.** The escapes are still parked behind sentinels, because unparking
 *  them before the inline tokenizer runs would hand it live emphasis markers. Every leaf that
 *  reaches the screen goes through `restoreEscapes` — rendering this value directly would put
 *  control characters on the phone. */
export function markdownToInlineSource(md: string): string {
  if (!md) return '';
  return oneLine(flattenBlocks(parkEscapes(md), true));
}
