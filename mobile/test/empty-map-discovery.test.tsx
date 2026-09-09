// DR-052 staged surface merge — before Discover can leave the tab bar, a fresh project's Map
// must be a real query-driven first-paper on-ramp. These tests bind both halves of the contract:
// an actually empty project gets the shared Discover experience, while a paper-bearing project
// with no derived graph keeps the existing Build map recovery path.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEventAsync, waitFor } from '@testing-library/react-native';
import { router, Slot, Tabs, useRouter } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';

import GraphScreen from '@/app/(tabs)/graph';
import LibraryScreen from '@/app/(tabs)/index';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { keys } from '@/api/queries';
import type { PaperSuggestion } from '@/api/types';
import { GraphSettingsProvider } from '@/store/graphSettings';
import { ProjectProvider } from '@/store/project';
import { ReadingSettingsProvider } from '@/store/readingSettings';
import { Button } from '@/ui';
import { createTestQueryClient } from './queryClient';

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

test('a project with a paper but no derived graph still offers Build map', async () => {
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
  expect(screen.queryByPlaceholderText('Type a topic or question')).toBeNull();
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
  expect(screen.queryByText('Second Result')).toBeNull();
});
