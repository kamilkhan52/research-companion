// DR-120 — Kamil, on a DevTest item's description: "an unformatted plain text jumble with links
// etc not formatted."
//
// The card renders that description twice: formatted, once it is expanded (the real fix, a
// `<Markdown>` render), and as a three-line PREVIEW while it is collapsed. The preview cannot be
// markdown — collapsing it relies on `numberOfLines`, which only a single `<Text>` honours — so
// it needs the prose WITHOUT the syntax, or the first thing he sees is still the jumble.
//
// Deliberately smaller than a parser: it recognizes exactly the constructs `Markdown.tsx` itself
// renders, and every pattern is linear (no nested quantifiers), because this runs on every card
// in a list of 120.

/** Where an escaped character waits out the stripping passes. A control character, so no ledger
 *  prose can contain one and be mistaken for a parked escape. */
const SENTINEL = '\u0000';

/** Strip markdown syntax down to the words, for a single-line preview.
 *
 *  Not a renderer and not reversible: link targets, code fences and emphasis markers are
 *  dropped, and all whitespace collapses to single spaces. Math (`\( … \)`) is left exactly as
 *  written — a half-stripped equation reads worse than the source. */
export function markdownToPlain(md: string): string {
  if (!md) return '';
  let out = md;
  // Escaped punctuation is parked behind a sentinel FIRST and restored last. It cannot simply be
  // unescaped at either end: unescape early and `\*` becomes a live emphasis marker that eats the
  // words on both sides of it; unescape late and the emphasis pass has already eaten them. A
  // ledger row lives in a markdown TABLE, so its pipes must be escaped, and DR-116's cell really
  // does carry `query.trim() \|\| filter !== 'all'`.
  // `(` and `)` are deliberately NOT in the set: `\(` and `\)` are this app's inline-math
  // delimiters (see MathView), and unescaping them would silently dissolve every equation.
  // Parked as a CHARACTER CODE, not as the character behind a marker: leaving the `*` itself in
  // the string would let the emphasis pass find and pair it however it was flagged.
  out = out.replace(/\\([\\`*_{}[\]#+\-.!|>~])/g,
    (_m, c: string) => `${SENTINEL}${c.charCodeAt(0)}${SENTINEL}`);
  // Fenced-code delimiters, not the code inside them: the content is the only part that reads.
  out = out.replace(/^ {0,3}(?:```|~~~).*$/gm, '');
  // Images before links — an image IS a link with a `!`, so the link rule would eat the `!` and
  // leave the alt text looking like ordinary prose with a stray bang.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // `<https://…>` autolinks keep the URL: it is the whole content of that construct.
  out = out.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1');
  // Leading block markers, line by line: heading hashes, blockquote carets, list bullets.
  out = out.replace(/^ {0,3}#{1,6}[ \t]+/gm, '');
  out = out.replace(/^ {0,3}>[ \t]?/gm, '');
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  out = out.replace(/^[ \t]*\d{1,9}[.)][ \t]+/gm, '');
  // A setext underline or a thematic break is pure syntax; the line above it is the content.
  out = out.replace(/^ {0,3}(?:-{3,}|={3,}|\*{3,}|_{3,})[ \t]*$/gm, '');
  // Inline code: the ticks go, the identifier inside stays.
  out = out.replace(/`+([^`]*)`+/g, '$1');
  // Emphasis. Asterisks are unambiguous; underscores are NOT — `how_to_test` and `_ROW_RE` are
  // ordinary words in this ledger's prose, so underscore emphasis is taken only when the run is
  // bounded by non-word characters, the same rule CommonMark uses for intraword `_`.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*\n]+)\*/g, '$1');
  out = out.replace(/(^|\W)__([^_]+)__(?=\W|$)/g, '$1$2');
  out = out.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2');
  // The parked escapes come back as their bare character, now that nothing will read them as
  // syntax.
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, code: string) => String.fromCharCode(Number(code)));
  // One line of prose: a table cell has no line structure to preserve, and `numberOfLines` wants
  // to do the wrapping itself.
  return out.replace(/\s+/g, ' ').trim();
}
