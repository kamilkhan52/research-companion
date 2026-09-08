/** Reading one free-text field as a reference to a paper. Shared by the Library's add sheet
 *  (which sends it) and the reading screen (which fetches what it named), so neither has to
 *  import the other. */

/** Deliberately the same grammar the mobile client parses
 *  (`AddPaperInline.parseKnownPaper`), so the two clients accept the same input: an arXiv id or
 *  arXiv link becomes a retrievable id, any other http(s) link becomes a direct PDF source, and
 *  anything else is a title for the search-and-hunt path. `source` is the concrete thing to
 *  fetch — null when only a title was given. */
export function parseKnownPaper(value: string): {
  title: string;
  source: string | null;
  arxivId?: string;
  pdfUrl?: string;
} {
  const text = value.trim();
  const arxiv = text.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i)
    ?? text.match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/);
  if (arxiv) {
    return { title: `arXiv ${arxiv[1]}`, source: arxiv[1], arxivId: arxiv[1] };
  }
  if (/^https?:\/\//i.test(text)) {
    const tail = text.split('/').filter(Boolean).pop() ?? '';
    return {
      title: tail.replace(/\.pdf.*$/i, '').replace(/[-_]+/g, ' ').trim() || 'Linked paper',
      source: text,
      pdfUrl: text,
    };
  }
  return { title: text, source: null };
}

/** Named for the field's old home at the bottom of Discover, so the key stays the same one
 *  mobile persists this draft under. (Web's removed Discover field kept no draft of its own —
 *  there is nothing to migrate here; this is a new persistence, matching the mobile control.) */
export function addPaperDraftKey(pid: string): string {
  return `rc.draft.v1:${pid}:discover:specific-paper`;
}

/** Compare titles the way a reader would: case, punctuation and spacing are not a difference. */
function comparableTitle(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Should we offer the source's title for this paper? Adding by arXiv id or link records a
 *  placeholder (`arXiv 2405.17057`) because nothing knows the real title yet; retrieval then
 *  learns it. The rename is the reader's call — the server never renames on its own — so the
 *  offer is made once, until they rule either way. */
export function shouldSuggestCanonicalTitle(
  paper: { title: string; title_confirmed?: boolean } | null,
  found: string | null | undefined,
): found is string {
  return !!paper
    && !paper.title_confirmed
    && !!found
    && comparableTitle(found) !== comparableTitle(paper.title);
}
