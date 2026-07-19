import { filterBucket, sortPapers } from '@/lib/paperSort';
import type { Paper } from '@/api/types';

const paper = (over: Partial<Paper>): Paper => ({
  slug: over.slug ?? 't',
  title: over.title ?? 'Title',
  group: '',
  list_status: over.list_status ?? 'unread',
  cites: [],
  retrieved: true,
  has_notes: false,
  session_state: over.session_state ?? null,
  arxiv_id: '',
  year: over.year,
});

describe('filterBucket', () => {
  test('maps session/list state to a bucket', () => {
    expect(filterBucket(paper({ session_state: 'in_discussion' }))).toBe('inprogress');
    expect(filterBucket(paper({ session_state: 'notes_drafted' }))).toBe('inprogress');
    expect(filterBucket(paper({ session_state: 'committed' }))).toBe('done');
    expect(filterBucket(paper({ list_status: 'read', session_state: null }))).toBe('done');
    expect(filterBucket(paper({ session_state: null }))).toBe('toread');
  });
});

describe('sortPapers', () => {
  const a = paper({ slug: 'a', title: 'Zeta', year: 2020, session_state: 'committed' });
  const b = paper({ slug: 'b', title: 'alpha', year: 2024, session_state: null });
  const c = paper({ slug: 'c', title: 'Mango', year: undefined, session_state: 'in_discussion' });
  const papers = [a, b, c];

  test('added preserves server order and returns the same array reference', () => {
    expect(sortPapers(papers, 'added')).toBe(papers);
  });

  test('added descending reverses server order without mutating it', () => {
    expect(sortPapers(papers, 'added', 'desc').map((p) => p.slug)).toEqual(['c', 'b', 'a']);
    expect(papers.map((p) => p.slug)).toEqual(['a', 'b', 'c']);
  });

  test('name sorts case-insensitively', () => {
    expect(sortPapers(papers, 'name').map((p) => p.slug)).toEqual(['b', 'c', 'a']);
    expect(sortPapers(papers, 'name', 'desc').map((p) => p.slug)).toEqual(['a', 'c', 'b']);
  });

  test('pubdate defaults to chronological order and keeps unknown years last', () => {
    expect(sortPapers(papers, 'pubdate').map((p) => p.slug)).toEqual(['a', 'b', 'c']);
    expect(sortPapers(papers, 'pubdate', 'desc').map((p) => p.slug)).toEqual(['b', 'a', 'c']);
  });

  test('status surfaces in-progress, then to-read, then done', () => {
    expect(sortPapers(papers, 'status').map((p) => p.slug)).toEqual(['c', 'b', 'a']);
  });

  test('does not mutate the input array', () => {
    const before = papers.map((p) => p.slug);
    sortPapers(papers, 'name');
    expect(papers.map((p) => p.slug)).toEqual(before);
  });
});
