// DR-046 — Kamil: "Older projects show no map, though maps had been built for them."
// Diagnosed as not data loss: `.state/` (the derived graph) is gitignored, so an imported
// project's map lives only on the source instance. The empty state used to read identically to
// "you never started" — this adds one factual line when the project already has real reading
// history (a paper with notes) but no map here, without claiming "imported" outright since the
// same state is also reachable by simply never having opened this tab.

import { renderAsync, screen } from '@testing-library/react-native';

import { EmptyBuildState } from '@/app/(tabs)/graph';
import type { GraphBuildProgress, GraphBuildState } from '@/hooks/useGraphBuild';
import type { GraphStatus } from '@/api/types';

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
} satisfies GraphStatus;

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

test('a build already in progress shows its own banner, not the prior-work line', async () => {
  const progress = {
    phase: 'metadata',
    graphStage: null,
    total: 3,
    ready: 0,
    done: 0,
    currentSlug: null,
    currentTitle: null,
    perPaper: {},
    retrievalCandidates: {},
  } satisfies GraphBuildProgress;
  const building: GraphBuildState = { ...BUILD, building: true, progress };
  await renderAsync(
    <EmptyBuildState status={STATUS} build={building} projectId="p" hasPriorWork={true} />,
  );
  // Positive assertion that the build's own progress UI actually rendered — not just that the
  // prior-work line is absent, which a component rendering nothing would also satisfy.
  expect(screen.getByText('Building map…')).toBeTruthy();
  expect(screen.queryByText(/nothing was lost/)).toBeNull();
});

// Opus review, PR #374: a build that just FAILED also has an empty `graph` and hasPriorWork can
// still be true — showing "nothing was lost, the map just hasn't been built here" ahead of the
// actual error is misleading in exactly the way this row exists to prevent (a wrong cause
// preempting the real one). The reassurance line must defer to a real error.
test('a failed build shows the error, not the prior-work reassurance', async () => {
  const failed: GraphBuildState = { ...BUILD, error: 'Semantic Scholar timed out.' };
  await renderAsync(
    <EmptyBuildState status={STATUS} build={failed} projectId="p" hasPriorWork={true} />,
  );
  expect(screen.getByText('Semantic Scholar timed out.')).toBeTruthy();
  expect(screen.queryByText(/nothing was lost/)).toBeNull();
});
