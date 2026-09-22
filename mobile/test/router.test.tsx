import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from './queryClient';
import { act, fireEventAsync, waitFor } from '@testing-library/react-native';
import { Slot, useLocalSearchParams } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import { StyleSheet, Text } from 'react-native';

import LibraryScreen from '@/app/(tabs)/index';
import DiscoverRedirect from '@/app/(tabs)/discover';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { keys } from '@/api/queries';
import { ProjectProvider } from '@/store/project';
import { LIBRARY_TITLE_KEY, ReadingSettingsProvider } from '@/store/readingSettings';

const client = createTestQueryClient();

afterEach(() => AsyncStorage.clear());

function TestLayout() {
  return (
    <QueryClientProvider client={client}>
      <ProjectProvider>
        <ReadingSettingsProvider>
          <Slot />
        </ReadingSettingsProvider>
      </ProjectProvider>
    </QueryClientProvider>
  );
}

function MapExploreRoute() {
  const { explore } = useLocalSearchParams<{ explore?: string }>();
  return <Text>Map explore {explore}</Text>;
}

test('an old Discover route redirects to the Map query surface', async () => {
  const rendered = renderRouter(
    { _layout: () => <Slot />, discover: DiscoverRedirect, graph: MapExploreRoute },
    { initialUrl: '/discover' },
  );

  await waitFor(() => expect(rendered.getPathname()).toBe('/graph'));
  expect(await screen.findByText('Map explore discover-route')).toBeTruthy();
});

test('renders an in-memory app route and navigates from the existing Library screen', async () => {
  const rendered = renderRouter(
    {
      _layout: TestLayout,
      index: LibraryScreen,
      settings: () => <Text>Settings route</Text>,
    },
    { initialUrl: '/' },
  );

  await waitFor(() => expect(screen.getByText('Connect to your server')).toBeTruthy());
  expect(screen.getByTestId('library-title-header')).toBeTruthy();
  expect(screen.getByTestId(
    'library-title-edge-fade',
    { includeHiddenElements: true },
  )).toBeTruthy();
  await fireEventAsync.press(screen.getByText('Open Settings'));

  await waitFor(() => expect(rendered.getPathname()).toBe('/settings'));
  expect(screen.getByText('Settings route')).toBeTruthy();
});

test('a persisted hidden-title preference removes the whole Library header', async () => {
  await setBaseUrl('');
  await AsyncStorage.setItem(LIBRARY_TITLE_KEY, 'false');

  renderRouter({ _layout: TestLayout, index: LibraryScreen }, { initialUrl: '/' });

  // Guard on loaded page content before asserting absence; otherwise a route that never mounted
  // would satisfy both checks.
  await waitFor(() => expect(screen.getByText('Connect to your server')).toBeTruthy());
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByTestId('library-title-header')).toBeNull();
  expect(screen.queryByText('Seminar')).toBeNull();
  expect(screen.queryByTestId(
    'library-title-edge-fade',
    { includeHiddenElements: true },
  )).toBeNull();
});

test('the active project pill opens Add paper and links onward to Map exploration', async () => {
  client.clear();
  await setBaseUrl('api.test');
  jest.mocked(api.listProjects).mockResolvedValueOnce({
    projects: [
      { id: 'add-entry', name: 'Systems', created_at: null, favorite: false, paper_count: 1, read_count: 0 },
    ],
  });
  jest.mocked(api.getProjectState).mockResolvedValueOnce({
    project: { id: 'add-entry', name: 'Systems' },
    has_key: true,
    model: null,
    narration_model: null,
    preview_model: null,
    speech_provider: null,
    has_openai_key: false,
    papers: [{
      slug: 'existing',
      title: 'Existing Paper',
      group: 'Unsorted',
      list_status: 'unread',
      cites: [],
      retrieved: false,
      has_notes: false,
      session_state: null,
      arxiv_id: '',
    }],
  });
  jest.mocked(api.getRecentSessions).mockResolvedValueOnce({ sessions: [] });
  const rendered = renderRouter(
    {
      _layout: TestLayout,
      index: LibraryScreen,
      graph: MapExploreRoute,
    },
    { initialUrl: '/' },
  );

  const add = await screen.findByLabelText('Add paper to Systems');
  await fireEventAsync.press(add);
  await waitFor(() => expect(screen.getByText('Add a paper')).toBeTruthy());
  expect(screen.getByLabelText('Upload a PDF from this device')).toBeTruthy();

  await fireEventAsync.press(screen.getByLabelText('Explore papers on Map'));
  await waitFor(() => expect(rendered.getPathname()).toBe('/graph'));
  expect(await screen.findByText(/Map explore \d+/)).toBeTruthy();
});

test('continues the latest unfinished session across projects', async () => {
  await setBaseUrl('api.test');
  jest.mocked(api.listProjects).mockResolvedValueOnce({
    projects: [
      // paper_count 1, not 0: since Kamil's 2026-07-29 call the hero is hidden entirely when the
      // ACTIVE project is empty, so a 0 here would hide the very card this test is about. The
      // resume still points at a DIFFERENT project, which is what "across projects" means.
      { id: 'current', name: 'Current', created_at: null, favorite: false, paper_count: 1, read_count: 0 },
      { id: 'three-d-dram', name: '3D DRAM', created_at: null, favorite: false, paper_count: 1, read_count: 0 },
    ],
  });
  jest.mocked(api.getProjectState).mockResolvedValueOnce({
    project: { id: 'current', name: 'Current' },
    has_key: true,
    model: null,
    narration_model: null,
    preview_model: null,
    speech_provider: null,
    has_openai_key: false,
    papers: [{
      slug: 'local-paper',
      title: 'A Paper In The Current Project',
      group: '',
      list_status: 'unread' as const,
      cites: [],
      retrieved: true,
      has_notes: false,
      session_state: null,
      arxiv_id: '',
    }],
  });
  jest.mocked(api.getRecentSessions).mockResolvedValueOnce({
    sessions: [{
      project_id: 'three-d-dram',
      project_name: '3D DRAM',
      slug: 'memory-paper',
      title: 'Memory Paper',
      kind: 'paper',
      state: 'in_discussion',
      started_at: '2026-07-05T00:00:00Z',
      updated_at: '2026-07-07T00:00:00Z',
    }],
  });
  const prefetchedSession = {
    paper: {
      slug: 'memory-paper',
      title: 'Memory Paper',
      group: '',
      list_status: 'unread' as const,
      cites: [],
      retrieved: true,
      has_notes: false,
      session_state: 'in_discussion' as const,
      arxiv_id: '',
    },
    state: 'in_discussion' as const,
    reading_mode: 'balanced' as const,
    transcript: [{ role: 'user' as const, text: 'Opening question' }],
    accepted_drafts: [],
  };
  jest.mocked(api.getSession).mockResolvedValueOnce(prefetchedSession);
  const prefetchedOpening = {
    prompt: 'Opening prompt',
    model: null,
    title: 'Memory Paper',
  };
  jest.mocked(api.getOpeningDraft).mockResolvedValueOnce(prefetchedOpening);

  function PaperRoute() {
    const { project } = useLocalSearchParams<{ project?: string }>();
    return <Text>Paper route · {project}</Text>;
  }

  const rendered = renderRouter(
    {
      _layout: TestLayout,
      index: LibraryScreen,
      'paper/[slug]': PaperRoute,
    },
    { initialUrl: '/' },
  );

  await waitFor(() => expect(screen.getByText('Memory Paper')).toBeTruthy());
  // The fade and project pill must share a stacking context, with the pill above it. The first
  // DR-137 implementation nested the fade under the higher-z title header, so it washed out the
  // project name on Android even though the pill had zIndex 2.
  const fade = screen.getByTestId('library-title-edge-fade', { includeHiddenElements: true });
  const pill = screen.getByTestId('library-project-pill-overlay');
  let fadeParent = fade.parent;
  while (fadeParent && fadeParent.props.testID !== 'library-body') fadeParent = fadeParent.parent;
  let pillParent = pill.parent;
  while (pillParent && pillParent.props.testID !== 'library-body') pillParent = pillParent.parent;
  expect(fadeParent?.props.testID).toBe('library-body');
  expect(pillParent?.props.testID).toBe('library-body');
  expect(StyleSheet.flatten(fade.props.style).zIndex).toBe(1);
  expect(StyleSheet.flatten(pill.props.style).zIndex).toBe(2);
  // Prefetch starts from the visible hero, before the user taps it — both the transcript and
  // the opening draft, the two things a resume blocks on (R.7). With no stored thread it warms
  // 'main', matching the paper screen's default resume (D39 + R12.2).
  await waitFor(() =>
    expect(api.getSession).toHaveBeenCalledWith('three-d-dram', 'memory-paper', 'main'));
  await waitFor(() =>
    expect(api.getOpeningDraft).toHaveBeenCalledWith('three-d-dram', 'memory-paper', 'main'));
  await waitFor(() => {
    expect(client.getQueryData(keys.session('three-d-dram', 'memory-paper')))
      .toEqual(prefetchedSession);
  });
  await waitFor(() => {
    expect(client.getQueryData(keys.opening('three-d-dram', 'memory-paper')))
      .toEqual(prefetchedOpening);
  });
  await fireEventAsync.press(screen.getByText('Memory Paper'));

  await waitFor(() => expect(rendered.getPathname()).toBe('/paper/memory-paper'));
  expect(screen.getByText('Paper route · three-d-dram')).toBeTruthy();
  await waitFor(() => expect(AsyncStorage.getItem('rc.activeProject')).resolves.toBe('three-d-dram'));
});

test('dismissing the resume hero does not also open the paper', async () => {
  // The whole card is a Pressable that navigates, so the X sits INSIDE the navigation target.
  // Without stopPropagation it dismisses and then opens the very paper it dismissed — and the
  // sibling external-link button already needed the same guard, so this is a live pattern, not a
  // hypothetical.
  await setBaseUrl('api.test');
  jest.mocked(api.listProjects).mockResolvedValueOnce({
    projects: [
      { id: 'current', name: 'Current', created_at: null, favorite: false, paper_count: 1, read_count: 0 },
    ],
  });
  jest.mocked(api.getProjectState).mockResolvedValueOnce({
    project: { id: 'current', name: 'Current' },
    has_key: true,
    model: null,
    narration_model: null,
    preview_model: null,
    speech_provider: null,
    has_openai_key: false,
    papers: [{
      slug: 'memory-paper',
      title: 'Memory Paper',
      group: '',
      list_status: 'unread' as const,
      cites: [],
      retrieved: true,
      has_notes: false,
      session_state: 'in_discussion' as const,
      arxiv_id: '',
    }],
  });
  jest.mocked(api.getRecentSessions).mockResolvedValueOnce({
    sessions: [{
      project_id: 'current',
      project_name: 'Current',
      slug: 'memory-paper',
      title: 'Memory Paper',
      kind: 'paper',
      state: 'in_discussion',
      started_at: '2026-07-05T00:00:00Z',
      updated_at: '2026-07-07T00:00:00Z',
    }],
  });

  function PaperRoute() {
    return <Text>Paper route</Text>;
  }
  const rendered = renderRouter(
    { _layout: TestLayout, index: LibraryScreen, 'paper/[slug]': PaperRoute },
    { initialUrl: '/' },
  );

  await waitFor(() => expect(screen.getByText('Continue reading')).toBeTruthy());
  await fireEventAsync.press(screen.getByLabelText('Dismiss continue reading'));

  // The card goes...
  await waitFor(() => expect(screen.queryByText('Continue reading')).toBeNull());
  // ...and we are still on the Library, not in the paper it pointed at.
  expect(rendered.getPathname()).toBe('/');
});

test('an empty project shows no resume hero, even with an unfinished session elsewhere', async () => {
  // Kamil's 2026-07-29 call, and the deliberate counterpart to the test above: someone sitting in
  // a project with no papers wants to ADD papers. A card inviting them back into a different
  // project is precisely the thing competing with that, so the empty-project rule outranks
  // cross-project resume — the resume is still there the moment the project has a paper.
  await setBaseUrl('api.test');
  jest.mocked(api.listProjects).mockResolvedValueOnce({
    projects: [
      { id: 'current', name: 'Current', created_at: null, favorite: false, paper_count: 0, read_count: 0 },
      { id: 'three-d-dram', name: '3D DRAM', created_at: null, favorite: false, paper_count: 1, read_count: 0 },
    ],
  });
  jest.mocked(api.getProjectState).mockResolvedValueOnce({
    project: { id: 'current', name: 'Current' },
    has_key: true,
    model: null,
    narration_model: null,
    preview_model: null,
    speech_provider: null,
    has_openai_key: false,
    papers: [],                       // the whole point: the ACTIVE project is empty
  });
  jest.mocked(api.getRecentSessions).mockResolvedValueOnce({
    sessions: [{
      project_id: 'three-d-dram',
      project_name: '3D DRAM',
      slug: 'memory-paper',
      title: 'Memory Paper',
      kind: 'paper',
      state: 'in_discussion',
      started_at: '2026-07-05T00:00:00Z',
      updated_at: '2026-07-07T00:00:00Z',
    }],
  });

  renderRouter({ _layout: TestLayout, index: LibraryScreen }, { initialUrl: '/' });

  // Guard FIRST on something the loaded empty project actually renders. Without it both absence
  // assertions below would pass simply because the screen had not finished loading yet — the
  // standard way an absence test goes vacuous.
  await waitFor(() => expect(screen.getByText('Add your first papers')).toBeTruthy());

  expect(screen.queryByText('Memory Paper')).toBeNull();
  expect(screen.queryByText('Continue reading')).toBeNull();
});
