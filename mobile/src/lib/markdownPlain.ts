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

/** Strip markdown syntax down to the words, for a single-line preview.
 *
 *  Not a renderer and not reversible: link targets, code fences and emphasis markers are
 *  dropped, and all whitespace collapses to single spaces. Math (`\( … \)`) is left exactly as
 *  written — a half-stripped equation reads worse than the source. */
export function markdownToPlain(md: string): string {
  if (!md) return '';
  let out = md;
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
  // One line of prose: a table cell has no line structure to preserve, and `numberOfLines` wants
  // to do the wrapping itself.
  return out.replace(/\s+/g, ' ').trim();
}
