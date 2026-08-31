// DR-113 — Kamil's Discover screenshot carried a red "Encountered two children with the same
// key" toast over the results. The cause was real duplication, fixed at the source in
// `discovery_recall.merge_candidates`; this guard exists because results ALREADY SAVED on disk
// still hold the duplicate, and re-running Discover is a paid multi-minute job. Without it, his
// existing results keep showing one paper twice.

import { dedupeSuggestions } from '@/app/(tabs)/discover';

test('a repeated candidate id is shown once, keeping the higher-ranked copy', () => {
  const rows = [
    { candidate_id: 'arxiv:2012.09852', title: 'SpAtten', rank: 11 },
    { candidate_id: 'arxiv:2012.09852', title: 'SpAtten', rank: 12 },
    { candidate_id: 'arxiv:2401.00001', title: 'Another' },
  ];
  const out = dedupeSuggestions(rows);
  expect(out).toHaveLength(2);
  expect(out[0].rank).toBe(11);
  expect(out.map((r) => r.candidate_id)).toEqual(['arxiv:2012.09852', 'arxiv:2401.00001']);
});

test('rows without a candidate id are all kept — a missing id is not evidence of sameness', () => {
  const rows = [
    { candidate_id: undefined, title: 'One' },
    { candidate_id: null, title: 'Two' },
    { candidate_id: '', title: 'Three' },
  ];
  expect(dedupeSuggestions(rows)).toHaveLength(3);
});

test('an ordinary result is passed through unchanged', () => {
  const rows = [{ candidate_id: 'a' }, { candidate_id: 'b' }, { candidate_id: 'c' }];
  expect(dedupeSuggestions(rows)).toEqual(rows);
});
