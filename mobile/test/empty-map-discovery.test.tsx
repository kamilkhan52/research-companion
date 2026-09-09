// DR-052 staged surface merge — before Discover can leave the tab bar, a fresh project's Map
// must be a real query-driven first-paper on-ramp. These tests bind both halves of the contract:
// an actually empty project gets the shared Discover experience, while a paper-bearing project
// with no derived graph keeps the existing Build map recovery path.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, waitFor } from '@testing-library/react-native';
import { Slot } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';

import GraphScreen from '@/app/(tabs)/graph';
import LibraryScreen from '@/app/(tabs)/index';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { GraphSettingsProvider } from '@/store/graphSettings';
import { ProjectProvider } from '@/store/project';
import { ReadingSettingsProvider } from '@/store/readingSettings';
import { createTestQueryClient } from './queryClient';

const PID = 'first-project';

function TestLayout() {
  return (
    <QueryClientProvider client={createTestQueryClient()}>
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
