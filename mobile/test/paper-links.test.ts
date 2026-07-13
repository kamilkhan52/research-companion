import { fullPaperUrl } from '@/lib/paperLinks';

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
