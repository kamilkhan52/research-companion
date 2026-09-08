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

/** The draft key matches the field's old home at the bottom of Discover, so an unfinished
 *  title or link follows the control to the Library instead of disappearing in the move. */
export function addPaperDraftKey(pid: string): string {
  return `rc.draft.v1:${pid}:discover:specific-paper`;
}
