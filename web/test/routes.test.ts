import { describe, expect, it } from 'vitest';
import { forgetRouteSource, paperHash, splitRouteQuery } from '@/routes';

describe('paperHash', () => {
  it('omits the query when there is nothing to fetch', () => {
    expect(paperHash('attention-is-all-you-need')).toBe('paper/attention-is-all-you-need');
    expect(paperHash('a-slug', null)).toBe('paper/a-slug');
  });

  it('round-trips a source that contains URL punctuation', () => {
    const source = 'https://example.org/get?id=7&fmt=pdf#page=2';
    const hash = paperHash('linked-paper', source);
    const { path, query } = splitRouteQuery(hash.slice('paper/'.length));
    expect(decodeURIComponent(path)).toBe('linked-paper');
    expect(query.get('source')).toBe(source);
  });

  it('round-trips a slug that contains a slash or a question mark', () => {
    const hash = paperHash('odd/slug?x', '2501.12345');
    const { path, query } = splitRouteQuery(hash.slice('paper/'.length));
    expect(decodeURIComponent(path)).toBe('odd/slug?x');
    expect(query.get('source')).toBe('2501.12345');
  });
});

describe('splitRouteQuery', () => {
  it('returns an empty query when the route has none', () => {
    const { path, query } = splitRouteQuery('some-slug');
    expect(path).toBe('some-slug');
    expect(query.get('source')).toBeNull();
  });
});

describe('forgetRouteSource', () => {
  it('strips a consumed source without navigating away from the paper', () => {
    window.location.hash = paperHash('llm-compiler', '2405.17057');
    forgetRouteSource('llm-compiler');
    expect(window.location.hash).toBe('#paper/llm-compiler');
  });

  it('leaves a route that carries no source alone', () => {
    window.location.hash = 'paper/llm-compiler';
    forgetRouteSource('llm-compiler');
    expect(window.location.hash).toBe('#paper/llm-compiler');
  });
});
