import { fullPaperUrl, rcSearchLink, scholarSearchUrl, titleFromRcSearchLink } from '@/lib/paperLinks';

describe('fullPaperUrl', () => {
  it('prefers an explicit PDF URL', () => {
    expect(fullPaperUrl({
      pdf_url: 'https://papers.example/file.pdf',
      arxiv_id: '2501.01005',
      url: 'https://example.com/landing',
    })).toBe('https://papers.example/file.pdf');
  });

  it('turns arXiv ids and abstract pages into PDF links', () => {
    expect(fullPaperUrl({ arxiv_id: '2501.01005v2' })).toBe('https://arxiv.org/pdf/2501.01005v2');
    expect(fullPaperUrl({ source_url: 'https://arxiv.org/abs/2201.11705' })).toBe(
      'https://arxiv.org/pdf/2201.11705',
    );
  });

  it('falls back to a source page and then DOI', () => {
    expect(fullPaperUrl({ source_url: 'https://publisher.example/paper' })).toBe(
      'https://publisher.example/paper',
    );
    expect(fullPaperUrl({ doi: '10.1000/example' })).toBe('https://doi.org/10.1000/example');
  });

  it('rejects non-web and malformed identifiers', () => {
    expect(fullPaperUrl({ url: 'javascript:alert(1)', arxiv_id: 'not an id' })).toBeNull();
  });
});

// DR-054 — a citation the model has no sourceable URL for gets an app-internal
// `rc-search:<url-encoded title>` marker instead of being left unlinked or given a fabricated
// source. Round-trip through encode/decode must survive punctuation, spaces, and non-ASCII.
describe('rc-search link round-trip', () => {
  it('encodes a title and decodes it back exactly', () => {
    const title = 'Efficient Memory Management for Large Language Model Serving, é/ü';
    expect(titleFromRcSearchLink(rcSearchLink(title))).toBe(title);
  });

  it('rejects a plain http(s) or rc-paper link as not an rc-search one', () => {
    expect(titleFromRcSearchLink('https://arxiv.org/abs/2306.00978')).toBeNull();
    expect(titleFromRcSearchLink('rc-paper:awq')).toBeNull();
  });

  it('falls back to the raw text rather than throwing on a malformed percent-sequence', () => {
    expect(titleFromRcSearchLink('rc-search:100%25 wrong%')).toBe('100%25 wrong%');
  });

  it('builds the same Scholar search URL used elsewhere in the app (authors.tsx)', () => {
    expect(scholarSearchUrl('LoongServe')).toBe(
      'https://scholar.google.com/scholar?q=LoongServe',
    );
    expect(scholarSearchUrl('A & B')).toBe(
      'https://scholar.google.com/scholar?q=A%20%26%20B',
    );
  });
});
