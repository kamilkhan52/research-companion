import { canStartGraphBuild } from '@/graph/buildAvailability';

test('allows graph retrieval when no papers are ready and Semantic Scholar is disabled', () => {
  expect(canStartGraphBuild({ total_papers: 2 })).toBe(true);
});

test('requires a loaded project with at least one paper', () => {
  expect(canStartGraphBuild(null)).toBe(false);
  expect(canStartGraphBuild({ total_papers: 0 })).toBe(false);
});
