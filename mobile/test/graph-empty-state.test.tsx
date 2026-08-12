// DR-046 — Kamil: "Older projects show no map, though maps had been built for them."
// Diagnosed as not data loss: `.state/` (the derived graph) is gitignored, so an imported
// project's map lives only on the source instance. The empty state used to read identically to
// "you never started" — this adds one factual line when the project already has real reading
// history (a paper with notes) but no map here, without claiming "imported" outright since the
// same state is also reachable by simply never having opened this tab.

import { renderAsync, screen } from '@testing-library/react-native';

import { EmptyBuildState } from '@/app/(tabs)/graph';
import type { GraphBuildState } from '@/hooks/useGraphBuild';

const BUILD: GraphBuildState = {
  building: false,
  progress: null,
  error: null,
  run: jest.fn(),
  resume: jest.fn(),
  clearError: jest.fn(),
};

const STATUS = {
  has_graph: false,
  built_at: null,
  model: null,
  graph_revision: null,
  graph_stage: null,
  graph_completeness: null,
  graph_needs_enrichment: false,
  total_papers: 3,
  retrievable_papers: 3,
  stale_papers: [],
  removed_papers: [],
  missing_text_papers: [],
  semantic_scholar_enabled: false,
  semantic_scholar_papers: 0,
  semantic_scholar_stale_papers: [],
  retrieval_candidates: {},
  retrieval_errors: {},
} as never;

test('a project with no reading history yet shows only the bare empty state', async () => {
  await renderAsync(
    <EmptyBuildState status={STATUS} build={BUILD} projectId="p" hasPriorWork={false} />,
  );
  expect(screen.getByText('No map yet')).toBeTruthy();
  expect(screen.queryByText(/nothing was lost/)).toBeNull();
});

test('a project with notes but no map here says nothing was lost', async () => {
  await renderAsync(
    <EmptyBuildState status={STATUS} build={BUILD} projectId="p" hasPriorWork={true} />,
  );
  expect(screen.getByText('No map yet')).toBeTruthy();
  expect(screen.getByText(/nothing was lost, the map just hasn't been built here/)).toBeTruthy();
});

test('a build already in progress never shows the prior-work line', async () => {
  const building: GraphBuildState = {
    ...BUILD,
    building: true,
    progress: {
      phase: 'metadata',
      graphStage: null,
      total: 3,
      ready: 0,
      done: 0,
      currentTitle: null,
      retrievalCandidates: {},
      retrievalErrors: {},
    } as never,
  };
  await renderAsync(
    <EmptyBuildState status={STATUS} build={building} projectId="p" hasPriorWork={true} />,
  );
  expect(screen.queryByText(/nothing was lost/)).toBeNull();
});
