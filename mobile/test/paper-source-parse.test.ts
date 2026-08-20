// DR-087: an arxiv.org/html/ link fell through as a raw pdf_url, so the server parsed the
// HTML page as a PDF. Every arXiv paper-URL flavor must resolve to the id instead.
jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null,
  Chat: () => null,
  InputToolbar: () => null,
  MessageText: () => null,
}));

import { parseSource } from '@/app/paper/[slug]';

describe('parseSource', () => {
  it.each([
    ['https://arxiv.org/abs/2608.11668'],
    ['https://arxiv.org/pdf/2608.11668'],
    ['https://arxiv.org/html/2608.11668'],
    ['https://arxiv.org/html/2608.11668v2'],
  ])('resolves %s to the arXiv id', (url) => {
    expect(parseSource(url)).toEqual({ arxiv_id: '2608.11668' });
  });

  it('resolves an old-style (pre-2007) archive id', () => {
    expect(parseSource('https://arxiv.org/abs/cond-mat/0703185')).toEqual({
      arxiv_id: 'cond-mat/0703185',
    });
  });

  it('passes a non-arXiv URL through as pdf_url', () => {
    expect(parseSource('https://example.com/paper.pdf')).toEqual({
      pdf_url: 'https://example.com/paper.pdf',
    });
  });

  it('treats a bare id as an arXiv id', () => {
    expect(parseSource('2608.11668')).toEqual({ arxiv_id: '2608.11668' });
  });
});
