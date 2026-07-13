/** Resolve the best browser target for a whole paper. Prefer a PDF whenever one is known. */
export function fullPaperUrl(paper: {
  pdf_url?: string | null;
  arxiv_id?: string | null;
  source_url?: string | null;
  url?: string | null;
  doi?: string | null;
}): string | null {
  const explicitPdf = cleanUrl(paper.pdf_url);
  if (explicitPdf) return explicitPdf;

  const arxivId = normalizeArxivId(paper.arxiv_id) ?? arxivIdFromUrl(paper.source_url) ?? arxivIdFromUrl(paper.url);
  if (arxivId) return `https://arxiv.org/pdf/${arxivId}`;

  const source = cleanUrl(paper.source_url) ?? cleanUrl(paper.url);
  if (source) return source;

  const doi = paper.doi?.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  return doi ? `https://doi.org/${doi}` : null;
}

function cleanUrl(value?: string | null): string | null {
  const url = value?.trim();
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function normalizeArxivId(value?: string | null): string | null {
  const raw = value?.trim().replace(/^arxiv:/i, '');
  return raw && /^[\w.-]+\/[\w.-]+(?:v\d+)?$|^\d{4}\.\d{4,5}(?:v\d+)?$/i.test(raw) ? raw : null;
}

function arxivIdFromUrl(value?: string | null): string | null {
  const url = cleanUrl(value);
  if (!url) return null;
  const match = url.match(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?(?:[?#].*)?$/i);
  return normalizeArxivId(match?.[1]);
}
