// DR-136 — Kamil: "Unexplained text at the top of Discover — see where it says 'Reinforcement
// Learning for robotics...', I think that shouldn't be there. Not sure why it's there. Maybe from
// a previous search."
//
// It is `result.focus`: the query planner's one-line restatement of what the SAVED run searched
// for. His guess is close but not exact — it is not leaked UI state from a later search, it is
// what the run behind these very results decided to look for, written when it planned its
// queries. On his own project that run is from 2026-08-22 and reads "Reinforcement learning for
// robotics…" over LLM-serving results, which is the pre-DR-096 failure (terse goals, no library
// grounding). So the line is a real record and worth keeping — it was unexplained only because it
// was pasted in front of the sentence about the results with no label and no date.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClientProvider } from '@tanstack/react-query';
import { Slot } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import { fireEvent, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { DiscoveryJob, GraphRecommendation } from '@/api/types';
import { describeRunFocus, discoverySkipLabel } from '@/app/(tabs)/discover';
import DiscoverScreen from '@/app/(tabs)/discover';
import { ProjectProvider } from '@/store/project';
import { createTestQueryClient } from './queryClient';

jest.mock('@/api/endpoints');

const FOCUS = 'Reinforcement learning for robotics, covering broad methodological advances.';

describe('describeRunFocus', () => {
  const NOW = Date.parse('2026-09-03T00:00:00Z');

  test('names the focus as the run’s search and dates it', () => {
    expect(describeRunFocus(FOCUS, '2026-08-22T05:22:55Z', NOW))
      .toBe(`Searched 2w ago for “${FOCUS}”`);
  });

  test('still labels the focus when the run has no usable timestamp', () => {
    expect(describeRunFocus(FOCUS, null, NOW)).toBe(`Searched for “${FOCUS}”`);
    expect(describeRunFocus(FOCUS, 'not-a-date', NOW)).toBe(`Searched for “${FOCUS}”`);
    // A clock-skewed future stamp must not render "in -3d".
    expect(describeRunFocus(FOCUS, '2027-01-01T00:00:00Z', NOW))
      .toBe(`Searched for “${FOCUS}”`);
  });

  test('a result with no focus produces no line at all', () => {
    expect(describeRunFocus('', '2026-08-22T05:22:55Z', NOW)).toBe('');
    expect(describeRunFocus(undefined, '2026-08-22T05:22:55Z', NOW)).toBe('');
    expect(describeRunFocus('   ', '2026-08-22T05:22:55Z', NOW)).toBe('');
  });
});

test('Discover names skippable stages and arms the next one elsewhere', () => {
  expect(discoverySkipLabel('searching')).toBe('Skip search');
  expect(discoverySkipLabel('citations')).toBe('Skip citations');
  expect(discoverySkipLabel('evidence')).toBe('Skip evidence');
  expect(discoverySkipLabel('scoring')).toBe('Skip next step');
});

function TestLayout() {
  return (
    <QueryClientProvider client={createTestQueryClient()}>
      <ProjectProvider>
        <Slot />
      </ProjectProvider>
    </QueryClientProvider>
  );
}

async function renderDiscover(
  result: Partial<Record<string, unknown>>,
  job: DiscoveryJob | null = null,
  graphRecommendations: GraphRecommendation[] = [],
) {
  await setBaseUrl('https://api.test');
  // The active project is persisted, not derived — nothing selects one for an empty store.
  await AsyncStorage.setItem('rc.activeProject', 'p1');
  jest.mocked(api.listProjects).mockResolvedValue({
    projects: [
      { id: 'p1', name: 'LLM inference', created_at: null, favorite: false, paper_count: 3, read_count: 1 },
    ],
  } as never);
  jest.mocked(api.getProjectState).mockResolvedValue({ papers: [] } as never);
  jest.mocked(api.getGraphRecommendations).mockResolvedValue(graphRecommendations);
  // getNeighbourhood is deliberately left unmocked: its line renders null without data, and the
  // freshness row is not what this test is about.
  jest.mocked(api.getDiscovery).mockResolvedValue({
    job,
    goals: 'Find new and related papers',
    result: {
      goals: 'Find new and related papers',
      model: 'm',
      queries: [],
      candidate_count: 60,
      top_n: 5,
      suggestions: [],
      in_library: [],
      generated_at: '2026-08-22T05:22:55Z',
      ...result,
    },
  } as never);
  return renderRouter({ _layout: TestLayout, index: DiscoverScreen }, { initialUrl: '/' });
}

test('project-ranked graph recommendations share the one Discover list with provenance', async () => {
  await renderDiscover({ focus: '', suggestions: [] }, null, [{
    id: 'ext:title:project recommendation',
    kind: 'external',
    slug: null,
    title: 'Project Recommendation',
    authors: ['A. Author'],
    venue: '',
    year: 2025,
    arxiv_id: null,
    doi: null,
    url: null,
    group: null,
    list_status: null,
    cited_by_project_count: 2,
    significant_cited_by_count: 1,
    cites_count: 0,
    recommend_score: 6,
    recommend_reasons: ['Cited by 2 papers in this project'],
    betweenness_centrality: 0,
  }]);

  expect(await screen.findByText('Project Recommendation')).toBeTruthy();
  expect(screen.getByText('Project graph')).toBeTruthy();
  expect(screen.getByText('Cited by 2 papers in this project')).toBeTruthy();
  expect(screen.getByText('Papers to add')).toBeTruthy();
});

test('hiding a graph recommendation keeps its Undo row mounted instead of refetching it away', async () => {
  const recommendation: GraphRecommendation = {
    id: 'ext:title:hide me',
    kind: 'external',
    slug: null,
    title: 'Hide Me',
    authors: [],
    venue: '',
    year: 2025,
    arxiv_id: null,
    doi: null,
    url: null,
    group: null,
    list_status: null,
    cited_by_project_count: 1,
    significant_cited_by_count: 0,
    cites_count: 0,
    recommend_score: 2,
    recommend_reasons: ['Connected to this project'],
    betweenness_centrality: 0,
  };
  jest.mocked(api.hideSuggestion).mockResolvedValue({
    hidden: { keys: ['title:hide me'], title: 'Hide Me', hidden_at: '2026-09-16T00:00:00Z' },
  });
  await renderDiscover({ focus: '', suggestions: [] }, null, [recommendation]);

  await screen.findByText('Hide Me');
  fireEvent.press(screen.getByLabelText('Hide Hide Me from recommendations'));

  expect(await screen.findByLabelText('Undo hiding Hide Me')).toBeTruthy();
  expect(api.getGraphRecommendations).toHaveBeenCalledTimes(1);
});

test('the run focus is labelled and dated on the screen, never printed bare', async () => {
  await renderDiscover({ focus: FOCUS });
  const line = await screen.findByTestId('discover-run-focus');
  expect(line.props.children).toContain('Searched');
  expect(line.props.children).toContain(FOCUS);
  // The unlabelled form was `${focus} · 60 papers across …` — one sentence, no attribution.
  expect(screen.queryByText(new RegExp(`^${FOCUS.slice(0, 20)}.* · 60 papers`))).toBeNull();
});

test('a result whose run recorded no focus shows no line', async () => {
  await renderDiscover({ focus: '' });
  await waitFor(() => expect(screen.getByText(/60 papers across/)).toBeTruthy());
  expect(screen.queryByTestId('discover-run-focus')).toBeNull();
});

test('Discover results no longer bury the known-paper entry below the result list', async () => {
  await renderDiscover({ focus: '' });
  // Guard on the persisted result itself before the absence assertion: otherwise a screen that
  // never loaded would also "prove" the field moved.
  await waitFor(() => expect(screen.getByText(/60 papers across/)).toBeTruthy());
  expect(screen.queryByLabelText('Paper title, DOI, or arXiv link')).toBeNull();
  expect(screen.queryByText('OR ADD DIRECTLY')).toBeNull();
});

test('a running Discover exposes Skip beside Stop and arms it on tap', async () => {
  const running = {
    status: 'running', phase: 'searching', finds: [], skip_requested: false, skips: 0,
  } as unknown as DiscoveryJob;
  const armed = { ...running, skip_requested: true } as DiscoveryJob;
  jest.mocked(api.skipDiscovery).mockResolvedValue({ job: armed });
  await renderDiscover({}, running);

  const skip = await screen.findByLabelText('Skip discovery step');
  expect(screen.getByText('Skip search')).toBeTruthy();
  expect(screen.getByLabelText('Stop discovery search')).toBeTruthy();
  fireEvent.press(skip);

  await waitFor(() => expect(api.skipDiscovery).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(screen.getByText('Skip requested')).toBeTruthy());
});
