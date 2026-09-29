// DR-052 staged surface merge — Map owns the query/list for empty, unbuilt, and built projects.
// These tests bind the first-paper latch and the combined graph/list surface so removing the
// Discover tab cannot strand either a fresh project or a paper-bearing project with no map yet.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, fireEventAsync, waitFor } from '@testing-library/react-native';
import { router, Slot, Tabs, useRouter } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import { ScrollView } from 'react-native';

import GraphScreen, { MAP_SEARCH_PLACEHOLDER } from '@/app/(tabs)/graph';
import LibraryScreen from '@/app/(tabs)/index';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { keys } from '@/api/queries';
import type {
  DiscoveryJob,
  GraphBuildJob,
  GraphResponse,
  PaperSuggestion,
} from '@/api/types';
import { GraphSettingsProvider } from '@/store/graphSettings';
import { ProjectProvider } from '@/store/project';
import { ReadingSettingsProvider } from '@/store/readingSettings';
import { Button } from '@/ui';
import { createTestQueryClient } from './queryClient';

jest.mock('@/components/graph/GraphCanvas', () => ({
  GraphCanvas: () => require('react').createElement(
    require('react-native').View,
    { testID: 'combined-map-canvas' },
  ),
}));

const PID = 'first-project';
let client = createTestQueryClient();

function suggestion(candidateId: string, title: string): PaperSuggestion {
  return {
    candidate_id: candidateId,
    arxiv_id: null,
    title,
    abstract: 'A useful abstract.',
    authors: ['A. Researcher'],
    affiliations: [],
    year: 2026,
    category: 'cs.LG',
    url: '',
    pdf_url: '',
    citation_count: 1,
    sources: ['semantic_scholar'],
    relevance: 9,
    credibility: 3,
    score: 9,
    reasons: ['Strong fit'],
  };
}

function TestLayout() {
  return (
    <QueryClientProvider client={client}>
      <ProjectProvider>
        <GraphSettingsProvider>
          <ReadingSettingsProvider>
            <Slot />
          </ReadingSettingsProvider>
        </GraphSettingsProvider>
      </ProjectProvider>
    </QueryClientProvider>
  );
}

// Unlike Slot, a bottom-tab navigator keeps visited screens mounted and sends focus/blur events.
// That is the production lifecycle which exposed the second review finding.
function TabsTestLayout() {
  return (
    <QueryClientProvider client={client}>
      <ProjectProvider>
        <GraphSettingsProvider>
          <ReadingSettingsProvider>
            <Tabs screenOptions={{ headerShown: false }} />
          </ReadingSettingsProvider>
        </GraphSettingsProvider>
      </ProjectProvider>
    </QueryClientProvider>
  );
}

function ReturnToMap() {
  const router = useRouter();
  return <Button title="Return to Map" onPress={() => router.push('/graph')} />;
}

function projectState(papers: unknown[]) {
  return {
    project: { id: PID, name: 'New project' },
    has_key: true,
    model: null,
    narration_model: null,
    preview_model: null,
    speech_provider: null,
    has_openai_key: false,
    papers,
  };
}

function emptyGraph(totalPapers: number) {
  return {
    graph: null,
    recommendations: [],
    build: null,
    status: {
      has_graph: false,
      built_at: null,
      model: null,
      graph_revision: null,
      graph_stage: null,
      graph_completeness: null,
      graph_needs_enrichment: false,
      total_papers: totalPapers,
      retrievable_papers: totalPapers,
      stale_papers: [],
      removed_papers: [],
      missing_text_papers: [],
      semantic_scholar_enabled: false,
      semantic_scholar_papers: 0,
      semantic_scholar_stale_papers: [],
      retrieval_candidates: {},
      retrieval_errors: {},
    },
  };
}

function builtGraph(build: GraphBuildJob | null = null): GraphResponse {
  const base = emptyGraph(1);
  return {
    ...base,
    build,
    graph: {
      built_at: '2026-09-19T00:00:00Z',
      revision: 'graph-r1',
      model: 'test',
      stage: 'enriched',
      completeness: {
        total_papers: 1,
        ready_papers: 1,
        metadata_papers: 1,
        full_text_papers: 1,
        failed_papers: 0,
        analyzed_papers: 1,
        metadata_only_edges: 0,
        full_text_edges: 0,
      },
      nodes: [{
        id: 'known-paper', kind: 'project', slug: 'known-paper', title: 'Known Paper',
        authors: ['A. Author'], venue: '', year: 2026, arxiv_id: null, doi: null, url: null,
        group: 'Unsorted', list_status: 'unread', cited_by_project_count: 0,
        significant_cited_by_count: 0, cites_count: 0,
      }],
      edges: [],
    },
    status: { ...base.status, has_graph: true, graph_stage: 'enriched' },
  } as GraphResponse;
}

const RUNNING_BUILD = {
  status: 'running',
  phase: 'extraction',
  total: 1,
  ready: 1,
  done: 0,
  current_slug: 'known-paper',
  current_title: 'Known Paper',
  per_paper: { 'known-paper': { status: 'extracting', error: null } },
  retrieval_candidates: {},
  graph_stage: 'enriched',
  graph_completeness: builtGraph().graph?.completeness ?? null,
  graph_revision: 'graph-r1',
  graph_updated_at: '2026-09-19T00:00:00Z',
  graph: null,
  recommendations: null,
  error: null,
  started_at: '2026-09-19T00:00:00Z',
  finished_at: null,
} as GraphBuildJob;

const RUNNING_DISCOVERY = {
  status: 'running',
  phase: 'searching',
  finds: [],
  skip_requested: false,
  skips: 0,
} as unknown as DiscoveryJob;

beforeEach(async () => {
  client.clear();
  client = createTestQueryClient();
  await setBaseUrl('https://api.test');
  await AsyncStorage.setItem('rc.activeProject', PID);
  jest.mocked(api.listProjects).mockResolvedValue({
    projects: [
      { id: PID, name: 'New project', created_at: null, favorite: false, paper_count: 0, read_count: 0 },
    ],
  });
  jest.mocked(api.getRecentSessions).mockResolvedValue({ sessions: [] });
  jest.mocked(api.getDiscovery).mockResolvedValue({ job: null, goals: '', result: null });
  jest.mocked(api.getGraphRecommendations).mockResolvedValue([]);
  jest.mocked(api.getNeighbourhood).mockResolvedValue({
    last_swept: null,
    age_seconds: null,
    monitored: 0,
    total_papers: 0,
    unmonitored: 0,
    time_stale: false,
    ever_swept: false,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty-library Discover CTA opens Map and exposes the real query on-ramp', async () => {
  jest.mocked(api.getProjectState).mockResolvedValue(projectState([]) as never);
  // An empty project has no graph to recover, so the on-ramp must not disappear just because
  // this independent read fails (the pre-fix Map would replace the whole screen with its error).
  jest.mocked(api.getGraph).mockRejectedValue(new Error('Graph service unavailable'));
  const rendered = renderRouter(
    { _layout: TestLayout, index: LibraryScreen, graph: GraphScreen },
    { initialUrl: '/' },
  );

  const entry = await screen.findByText('Discover papers');
  await fireEventAsync.press(entry);

  await waitFor(() => expect(rendered.getPathname()).toBe('/graph'));
  expect(await screen.findByPlaceholderText('Type a topic or question')).toBeTruthy();
  expect(screen.getByText('What would you like to explore? Describe a topic, question, or method — we’ll scan scholarly sources for relevant papers.')).toBeTruthy();
  expect(screen.queryByText('Build map')).toBeNull();
  expect(screen.queryByLabelText('Search papers')).toBeNull();
});

test('a project with a paper but no derived graph offers both Build map and exploration', async () => {
  jest.mocked(api.getProjectState).mockResolvedValue(projectState([{
    slug: 'known-paper',
    title: 'Known Paper',
    group: 'Unsorted',
    list_status: 'unread',
    cites: [],
    retrieved: true,
    has_notes: false,
    session_state: null,
    arxiv_id: '',
  }]) as never);
  jest.mocked(api.getGraph).mockResolvedValue(emptyGraph(1) as never);
  renderRouter({ _layout: TestLayout, graph: GraphScreen }, { initialUrl: '/graph' });

  expect(await screen.findByText('Build map')).toBeTruthy();
  expect(screen.getByText('No map yet')).toBeTruthy();
  expect(screen.getByPlaceholderText('Type a topic or question')).toBeTruthy();
});

test('a built project renders one Map surface with the graph above the unified paper list', async () => {
  jest.mocked(api.getProjectState).mockResolvedValue(projectState([{
    slug: 'known-paper',
    title: 'Known Paper',
    group: 'Unsorted',
    list_status: 'unread',
    cites: [],
    retrieved: true,
    has_notes: false,
    session_state: null,
    arxiv_id: '',
  }]) as never);
  jest.mocked(api.getGraph).mockResolvedValue(builtGraph());
  jest.mocked(api.getGraphRecommendations).mockResolvedValue([{
    id: 'ext:title:next paper', kind: 'external', slug: null, title: 'Next Paper',
    authors: ['B. Author'], venue: '', year: 2025, arxiv_id: null, doi: null, url: null,
    group: null, list_status: null, cited_by_project_count: 1,
    significant_cited_by_count: 0, cites_count: 0, recommend_score: 3,
    recommend_reasons: ['Connected to Known Paper'], betweenness_centrality: 0,
  }]);
  // A saved result normally collapses the query to its summary. The explore token from an old
  // /discover link or Add-paper entry must reopen the actual editor on arrival.
  jest.mocked(api.getDiscovery).mockResolvedValue({
    job: null,
    goals: 'Saved goal',
    result: {
      goals: 'Saved goal', model: 'test', queries: [], candidate_count: 0, top_n: 5,
      suggestions: [], in_library: [], generated_at: '2026-09-19T00:00:00Z',
    },
  } as never);

  renderRouter(
    { _layout: TestLayout, graph: GraphScreen },
    { initialUrl: '/graph?explore=add-sheet' },
  );

  expect(await screen.findByTestId('combined-map-canvas')).toBeTruthy();
  // DR-052 step 4: with a map, the ONE search box above it is the query editor. The explore
  // entry opens that box; the list below keeps the saved query as a summary, with no second
  // editor of its own.
  expect(await screen.findByPlaceholderText(MAP_SEARCH_PLACEHOLDER)).toBeTruthy();
  expect(screen.queryByPlaceholderText('Type a topic or question')).toBeNull();
  expect(screen.getByText('Saved goal')).toBeTruthy();
  expect(await screen.findByText('Next Paper')).toBeTruthy();
  expect(screen.getByText('Project graph')).toBeTruthy();
  expect(screen.queryByLabelText('Recommendations')).toBeNull();
});

test('map build and paid discovery remain visible with independent controls', async () => {
  jest.mocked(api.getProjectState).mockResolvedValue(projectState([{
    slug: 'known-paper',
    title: 'Known Paper',
    group: 'Unsorted',
    list_status: 'unread',
    cites: [],
    retrieved: true,
    has_notes: false,
    session_state: null,
    arxiv_id: '',
  }]) as never);
  jest.mocked(api.getGraph).mockResolvedValue(builtGraph(RUNNING_BUILD));
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({ build: RUNNING_BUILD });
  jest.mocked(api.getDiscovery).mockResolvedValue({
    job: RUNNING_DISCOVERY,
    goals: 'Find complementary work',
    result: null,
  });

  renderRouter({ _layout: TestLayout, graph: GraphScreen }, { initialUrl: '/graph' });

  expect(await screen.findByLabelText(/Map build in progress/)).toBeTruthy();
  expect(await screen.findByLabelText('Stop discovery search')).toBeTruthy();
  expect(screen.getByLabelText('Skip discovery step')).toBeTruthy();
});

test('the explore landing stops following layout changes after the reader scrolls', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  jest.mocked(api.getProjectState).mockResolvedValue(projectState([{
    slug: 'known-paper',
    title: 'Known Paper',
    group: 'Unsorted',
    list_status: 'unread',
    cites: [],
    retrieved: true,
    has_notes: false,
    session_state: null,
    arxiv_id: '',
  }]) as never);
  // No map yet: there is no search box, so the landing is still the list's own editor below
  // "Build map". With a map the entry opens the box instead (tested further down).
  jest.mocked(api.getGraph).mockResolvedValue(emptyGraph(1));

  renderRouter(
    { _layout: TestLayout, graph: GraphScreen },
    { initialUrl: '/graph?explore=add-sheet' },
  );

  const section = await screen.findByTestId('map-discover-section');
  fireEvent(section, 'layout', {
    nativeEvent: { layout: { x: 0, y: 700, width: 400, height: 500 } },
  });
  act(() => { jest.runOnlyPendingTimers(); });
  // Positive control: before interaction, a changing layout still follows the requested landing.
  expect(scrollTo).toHaveBeenCalledWith({ y: 692, animated: false });

  fireEvent(screen.getByTestId('combined-map-scroll'), 'scrollBeginDrag');
  scrollTo.mockClear();
  fireEvent(section, 'layout', {
    nativeEvent: { layout: { x: 0, y: 850, width: 400, height: 650 } },
  });
  // renderRouter installs fake timers; without advancing them this negative assertion would be
  // vacuous because the original requestAnimationFrame re-scroll would still be queued.
  act(() => { jest.runOnlyPendingTimers(); });

  expect(scrollTo).not.toHaveBeenCalled();
});

test('adding the first result keeps the rest of the paid search visible for this Map visit', async () => {
  const addedPaper = {
    slug: 'first-result',
    title: 'First Result',
    group: 'Unsorted',
    list_status: 'unread',
    cites: [],
    retrieved: false,
    has_notes: false,
    session_state: null,
    arxiv_id: '',
  };
  let currentPapers: unknown[] = [];
  jest.mocked(api.getProjectState).mockImplementation(
    async () => projectState(currentPapers) as never,
  );
  jest.mocked(api.getGraph).mockResolvedValue(emptyGraph(0) as never);
  jest.mocked(api.getDiscovery).mockResolvedValue({
    job: null,
    goals: 'Find useful work',
    result: {
      goals: 'Find useful work',
      model: 'test-model',
      queries: [],
      candidate_count: 2,
      top_n: 5,
      suggestions: [
        suggestion('first', 'First Result'),
        suggestion('second', 'Second Result'),
      ],
      in_library: [],
      generated_at: '2026-09-09T00:00:00Z',
    },
  } as never);
  jest.mocked(api.addPaper).mockImplementation(async () => {
    currentPapers = [addedPaper];
    return { paper: addedPaper } as never;
  });
  const rendered = renderRouter(
    { _layout: TabsTestLayout, index: ReturnToMap, graph: GraphScreen },
    { initialUrl: '/graph' },
  );

  await screen.findByLabelText('Add First Result to library');
  expect(screen.getByText('Second Result')).toBeTruthy();

  // Real bottom tabs blur but retain GraphScreen. The second review found that the first latch
  // was cleared here and never re-armed because neither pid nor emptiness changed on return.
  await act(async () => { router.navigate('/'); });
  await waitFor(() => expect(rendered.getPathname()).toBe('/'));
  await fireEventAsync.press(screen.getByText('Return to Map'));
  await waitFor(() => expect(rendered.getPathname()).toBe('/graph'));

  const addFirst = await screen.findByLabelText('Add First Result to library');
  await fireEventAsync.press(addFirst);

  await waitFor(() => expect(api.addPaper).toHaveBeenCalled());
  await waitFor(() => expect(jest.mocked(api.getProjectState).mock.calls.length).toBeGreaterThan(1));
  await waitFor(() => {
    expect(client.getQueryData<{ papers: unknown[] }>(keys.projectState(PID))?.papers)
      .toHaveLength(1);
  });
  act(() => { jest.advanceTimersByTime(20); });
  // Positive assertions after the paper-bearing state has landed: without the visit latch the
  // entire subtree is now "No map yet / Build map", which loses result two and the footer.
  expect(screen.getByText('Second Result')).toBeTruthy();
  expect(screen.getByText('Go to library · 1 added')).toBeTruthy();
  expect(screen.queryByText('Build map')).toBeNull();

  await fireEventAsync.press(screen.getByText('Go to library · 1 added'));
  await waitFor(() => expect(rendered.getPathname()).toBe('/'));
  await fireEventAsync.press(screen.getByText('Return to Map'));
  await waitFor(() => expect(rendered.getPathname()).toBe('/graph'));
  expect(await screen.findByText('Build map')).toBeTruthy();
  expect(screen.getByText('Second Result')).toBeTruthy();
});


// ---- DR-052 step 4: one search box ----------------------------------------------------------

const KNOWN = {
  slug: 'known-paper', title: 'Known Paper', group: 'Unsorted', list_status: 'unread',
  cites: [], retrieved: true, has_notes: false, session_state: null, arxiv_id: '',
};

function twoNodeGraph(): GraphResponse {
  const base = builtGraph();
  return {
    ...base,
    graph: {
      ...base.graph!,
      nodes: [
        ...base.graph!.nodes,
        {
          ...base.graph!.nodes[0], id: 'ext:hybrid', kind: 'external', slug: null,
          title: 'Hybrid Bonding for Stacked DRAM', authors: ['C. Writer'], year: 2024,
        },
      ],
    },
  } as GraphResponse;
}

test('typing narrows the map, and Search runs Discover once with that text', async () => {
  jest.mocked(api.getProjectState).mockResolvedValue(projectState([KNOWN]) as never);
  jest.mocked(api.getGraph).mockResolvedValue(twoNodeGraph());
  jest.mocked(api.startDiscovery).mockResolvedValue({ job: RUNNING_DISCOVERY } as never);

  renderRouter({ _layout: TestLayout, graph: GraphScreen }, { initialUrl: '/graph' });
  await screen.findByTestId('combined-map-canvas');
  // Closed by default: an idle map is not narrowed and offers no paid action.
  expect(screen.queryByPlaceholderText(MAP_SEARCH_PLACEHOLDER)).toBeNull();

  await fireEventAsync.press(screen.getByLabelText('Search the map and explore papers'));
  const box = await screen.findByPlaceholderText(MAP_SEARCH_PLACEHOLDER);
  expect(screen.queryByText('Search for papers')).toBeNull();

  await fireEventAsync.changeText(box, 'hybrid bonding stacked DRAM for AI workloads');
  // A topic, not a title fragment: it still finds the one map paper about it.
  expect(await screen.findByText('1 on the map')).toBeTruthy();
  // The default Significant view is not what a search shows, and the pill must not claim it.
  expect(screen.getByText('All matches')).toBeTruthy();
  expect(screen.queryByText('Significant')).toBeNull();
  expect(api.startDiscovery).not.toHaveBeenCalled();

  await fireEventAsync.press(screen.getByText('Search for papers'));
  await waitFor(() => expect(api.startDiscovery).toHaveBeenCalledTimes(1));
  expect(jest.mocked(api.startDiscovery).mock.calls[0]).toEqual(
    expect.arrayContaining(['hybrid bonding stacked DRAM for AI workloads']),
  );
  // The map build's poll, the discovery poll and re-renders must not buy a second search.
  act(() => { jest.runOnlyPendingTimers(); });
  expect(api.startDiscovery).toHaveBeenCalledTimes(1);
});

test('the keyboard Search key submits the same way as the button', async () => {
  jest.mocked(api.getProjectState).mockResolvedValue(projectState([KNOWN]) as never);
  jest.mocked(api.getGraph).mockResolvedValue(twoNodeGraph());
  jest.mocked(api.startDiscovery).mockResolvedValue({ job: RUNNING_DISCOVERY } as never);

  renderRouter({ _layout: TestLayout, graph: GraphScreen }, { initialUrl: '/graph' });
  await screen.findByTestId('combined-map-canvas');
  await fireEventAsync.press(screen.getByLabelText('Search the map and explore papers'));
  const box = await screen.findByPlaceholderText(MAP_SEARCH_PLACEHOLDER);
  await fireEventAsync.changeText(box, 'stacked dram');
  await fireEventAsync(box, 'submitEditing');
  await waitFor(() => expect(api.startDiscovery).toHaveBeenCalledTimes(1));
});

test('a search that matches nothing on the map says so and still offers the wider search', async () => {
  jest.mocked(api.getProjectState).mockResolvedValue(projectState([KNOWN]) as never);
  jest.mocked(api.getGraph).mockResolvedValue(twoNodeGraph());

  renderRouter({ _layout: TestLayout, graph: GraphScreen }, { initialUrl: '/graph' });
  await screen.findByTestId('combined-map-canvas');
  await fireEventAsync.press(screen.getByLabelText('Search the map and explore papers'));
  await fireEventAsync.changeText(
    await screen.findByPlaceholderText(MAP_SEARCH_PLACEHOLDER), 'protein folding',
  );
  expect(await screen.findByText(/Nothing on the map matches this search/)).toBeTruthy();
  expect(screen.getByText('0 on the map')).toBeTruthy();
  expect(screen.getByText('Search for papers')).toBeTruthy();
});

test('Edit on the saved search hands its text back to the one box', async () => {
  jest.mocked(api.getProjectState).mockResolvedValue(projectState([KNOWN]) as never);
  jest.mocked(api.getGraph).mockResolvedValue(twoNodeGraph());
  jest.mocked(api.getDiscovery).mockResolvedValue({
    job: null,
    goals: 'stacked dram',
    result: {
      goals: 'stacked dram', model: 'test', queries: [], candidate_count: 0, top_n: 5,
      suggestions: [], in_library: [], generated_at: '2026-09-19T00:00:00Z',
    },
  } as never);

  renderRouter({ _layout: TestLayout, graph: GraphScreen }, { initialUrl: '/graph' });
  await screen.findByTestId('combined-map-canvas');
  expect(screen.queryByPlaceholderText(MAP_SEARCH_PLACEHOLDER)).toBeNull();

  await fireEventAsync.press(await screen.findByLabelText('Edit your search'));
  const box = await screen.findByPlaceholderText(MAP_SEARCH_PLACEHOLDER);
  expect(box.props.value).toBe('stacked dram');
  expect(screen.queryByPlaceholderText('Type a topic or question')).toBeNull();
});
