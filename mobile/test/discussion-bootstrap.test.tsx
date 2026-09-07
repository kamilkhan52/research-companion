import { act, fireEvent, renderAsync, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReaderBriefing } from '@/hooks/useReaderBriefing';

const mockBack = jest.fn();
const mockPush = jest.fn();
let mockParams: { slug: string; thread?: string } = { slug: 'rough' };

jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));

jest.mock('@/store/project', () => ({
  useActiveProject: () => ({ activePid: 'project', ready: true, setActivePid: jest.fn() }),
}));

jest.mock('@/store/listening', () => ({
  useListeningMode: () => ({ listeningMode: false, setListeningMode: jest.fn() }),
}));

jest.mock('@/audio/AudioProvider', () => ({
  useAudio: () => ({
    cancelPrep: jest.fn(),
    enqueueJob: jest.fn(),
    playPreview: jest.fn(),
  }),
}));

jest.mock('@/audio/identity', () => {
  const actual = jest.requireActual('@/audio/identity');
  return { ...actual, useListeningHandoffRecovery: jest.fn() };
});

jest.mock('@/audio/usePreviewCues', () => ({ usePreviewCues: jest.fn() }));
jest.mock('@/hooks/useReduceMotion', () => ({ useReduceMotion: () => true }));

const mockStream = {
  streaming: false,
  items: [],
  previewJobIds: [],
  previewParentJobId: null,
  resume: jest.fn(async () => undefined),
  run: jest.fn(),
  stop: jest.fn(),
};
jest.mock('@/hooks/useStreamingTurn', () => ({ useStreamingTurn: () => mockStream }));

const emptyReader = (): ReaderBriefing => ({
  offer: null,
  offerOpen: false,
  openOffer: jest.fn(),
  closeOffer: jest.fn(),
  job: null,
  selected: new Set(),
  toggle: jest.fn(),
  start: jest.fn(async () => undefined),
  dismissJob: jest.fn(),
  cancel: jest.fn(async () => undefined),
  fetching: {},
  fetchCandidate: jest.fn(async () => undefined),
  starting: false,
  error: null,
});
let mockReader = emptyReader();
jest.mock('@/hooks/useReaderBriefing', () => ({
  useReaderBriefing: () => mockReader,
}));

jest.mock('@/components/TopBar', () => {
  const { View: MockView } = require('react-native');
  return {
    TopBar: ({ floating, right }: { floating?: boolean; right?: React.ReactNode }) => (
      <MockView testID={floating ? 'floating-top-bar' : 'in-flow-top-bar'}>{right}</MockView>
    ),
  };
});

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null,
  Chat: () => null,
  InputToolbar: () => null,
  MessageText: () => null,
}));

import DiscussionScreen from '@/app/paper/[slug]';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { keys } from '@/api/queries';
import type { ProjectState, Session } from '@/api/types';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { ReadingSettingsProvider } from '@/store/readingSettings';
import { createTestQueryClient } from './queryClient';

const projectState = (sessionState: Session['state']): ProjectState => ({
  project: { id: 'project', name: 'Project' },
  has_key: true,
  model: null,
  narration_model: null,
  preview_model: null,
  speech_provider: null,
  has_openai_key: false,
  papers: [{
    slug: 'rough',
    title: 'Rough Paper',
    group: '',
    list_status: 'unread',
    cites: [],
    retrieved: false,
    has_notes: false,
    session_state: sessionState,
    arxiv_id: '',
  }],
});

const emptySession: Session = {
  paper: projectState(null).papers[0],
  state: null,
  reading_mode: 'balanced',
  transcript: [],
  accepted_drafts: [],
  threads: [],
};

const openingDraft = {
  prompt: 'Give me a balanced first read.',
  model: null,
  title: 'Rough Paper',
  templates: {
    balanced: 'Give me a balanced first read.',
    background: 'Explain the background.',
    technical: 'Focus on methods.',
    detailed: 'Walk through everything.',
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function renderPendingSession(options?: {
  state?: ProjectState;
  thread?: string;
  sessionRequest?: ReturnType<typeof deferred<Session>>;
}) {
  const client = createTestQueryClient();
  if (options?.state) client.setQueryData(keys.projectState('project'), options.state);
  mockParams = { slug: 'rough', ...(options?.thread ? { thread: options.thread } : {}) };
  const request = options?.sessionRequest ?? deferred<Session>();
  jest.mocked(api.getSession).mockImplementation(() => request.promise);

  const view = await renderAsync(
    <QueryClientProvider client={client}>
      <SafeAreaProvider initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 24, right: 0, bottom: 20, left: 0 },
      }}>
        <ThemeProvider>
          {/* DR-115: DiscussionThread calls useReadingSettings, which throws outside its
              provider. Every case here happens to stop in a loading state before the
              transcript mounts, so the omission was invisible — and would have surfaced as
              a baffling failure in whichever future test first got that far. */}
          <ReadingSettingsProvider>
            <DiscussionScreen />
          </ReadingSettingsProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </QueryClientProvider>,
  );
  return { client, request, view };
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockReader = emptyReader();
  mockParams = { slug: 'rough' };
  await setBaseUrl('https://api.test');
  jest.mocked(api.getSettings).mockResolvedValue({ model: null } as never);
  jest.mocked(api.getFavoriteModels).mockResolvedValue({ models: [] });
});

afterEach(() => jest.useRealTimers());

test('DiscussionScreen delays a known discussion skeleton and keeps its TopBar floating', async () => {
  const { view } = await renderPendingSession({ state: projectState('in_discussion') });

  expect(view.queryByTestId('discussion-loading-skeleton')).toBeNull();
  expect(view.getByTestId('floating-top-bar')).toBeTruthy();
  act(() => jest.advanceTimersByTime(499));
  expect(view.queryByTestId('discussion-loading-skeleton')).toBeNull();
  act(() => jest.advanceTimersByTime(1));
  expect(view.getByTestId('discussion-loading-skeleton')).toBeTruthy();
});

test('DiscussionScreen chooses setup geometry for a known unread paper', async () => {
  const { view } = await renderPendingSession({ state: projectState(null) });

  expect(view.getByTestId('in-flow-top-bar')).toBeTruthy();
  act(() => jest.advanceTimersByTime(500));
  expect(view.getByTestId('paper-setup-loading-skeleton')).toBeTruthy();
  expect(view.queryByTestId('discussion-loading-skeleton')).toBeNull();
});

test('DiscussionScreen does not guess on a cold deep link or an unhinted secondary thread', async () => {
  const cold = await renderPendingSession();
  act(() => jest.advanceTimersByTime(500));
  expect(cold.view.queryByTestId('discussion-loading-skeleton')).toBeNull();
  expect(cold.view.queryByTestId('paper-setup-loading-skeleton')).toBeNull();
  await cold.view.unmountAsync();

  const secondary = await renderPendingSession({
    state: projectState('in_discussion'),
    thread: 'secondary',
  });
  act(() => jest.advanceTimersByTime(500));
  expect(secondary.view.queryByTestId('discussion-loading-skeleton')).toBeNull();
  expect(secondary.view.queryByTestId('paper-setup-loading-skeleton')).toBeNull();
});

test('setup skeleton remains continuous from session resolution into the opening draft', async () => {
  const sessionRequest = deferred<Session>();
  jest.mocked(api.getOpeningDraft).mockImplementation(
    () => new Promise<Awaited<ReturnType<typeof api.getOpeningDraft>>>(() => undefined),
  );
  const { request, view } = await renderPendingSession({
    state: projectState(null),
    sessionRequest,
  });
  act(() => jest.advanceTimersByTime(500));
  expect(view.getByTestId('paper-setup-loading-skeleton')).toBeTruthy();

  await act(async () => {
    request.resolve(emptySession);
    await Promise.resolve();
  });

  await waitFor(() => expect(api.getOpeningDraft).toHaveBeenCalledWith('project', 'rough', 'main'));
  expect(view.getByTestId('paper-setup-loading-skeleton')).toBeTruthy();
  expect(view.queryByText('Reading modes')).toBeNull();
});

test('a cold route keeps a short flash guard after the route deadline has elapsed', async () => {
  const sessionRequest = deferred<Session>();
  const openingRequest = deferred<Awaited<ReturnType<typeof api.getOpeningDraft>>>();
  jest.mocked(api.getOpeningDraft).mockImplementation(() => openingRequest.promise);
  const { request, view } = await renderPendingSession({ sessionRequest });
  act(() => jest.advanceTimersByTime(700));
  expect(view.queryByTestId('paper-setup-loading-skeleton')).toBeNull();

  await act(async () => {
    request.resolve(emptySession);
    await Promise.resolve();
  });
  await waitFor(() => expect(api.getOpeningDraft).toHaveBeenCalledWith('project', 'rough', 'main'));
  expect(view.queryByTestId('paper-setup-loading-skeleton')).toBeNull();

  act(() => jest.advanceTimersByTime(80));
  await act(async () => {
    openingRequest.resolve(openingDraft);
    await Promise.resolve();
  });
  await waitFor(() => expect(view.getByText('Reading modes')).toBeTruthy());
  act(() => jest.advanceTimersByTime(70));
  expect(view.queryByTestId('paper-setup-loading-skeleton')).toBeNull();
});

// DR-145 — the offer is a window over the discussion, mounted beside the screen's other
// sheets rather than inside the transcript, so it can never push the response being read.
test('an earned offer renders as a window, not as a card in the transcript', async () => {
  const closeOffer = jest.fn();
  mockReader = {
    ...emptyReader(),
    offer: {
      assistantIndex: 0,
      candidates: [{ slug: 'cited', title: 'Cited paper', year: 2025, has_text: true }],
    },
    offerOpen: true,
    closeOffer,
    selected: new Set(['cited']),
  };
  const sessionRequest = deferred<Session>();
  const { request, view } = await renderPendingSession({
    state: projectState('in_discussion'),
    sessionRequest,
  });
  await act(async () => {
    request.resolve({
      ...emptySession,
      state: 'in_discussion',
      transcript: [{
        role: 'assistant',
        assistant_index: 0,
        canonical: 'An answer.',
        narration: '',
        state_signal: 'in_discussion',
        proposed_commit: null,
        delivery_mode: 'reading',
        chat_job_id: 'chat-1',
        audio_job_id: null,
        audio_error: null,
      }],
    });
    await Promise.resolve();
  });

  await waitFor(() => expect(view.getByTestId('reader-offer')).toBeTruthy());
  fireEvent.press(view.getByLabelText('Dismiss test bottom sheet'));
  expect(closeOffer).toHaveBeenCalled();
});

test('an active reading pass is only a top-bar icon until the reader opens it', async () => {
  mockReader = {
    ...emptyReader(),
    job: {
      id: 'reader-1',
      status: 'running',
      error: null,
      slug: 'rough',
      thread_id: 'main',
      assistant_index: 0,
      targets: [{ slug: 'cited', title: 'Cited paper', status: 'reading', error: null }],
      current: 'cited',
      delivery_mode: 'reading',
      briefs: [],
      waiting: false,
      stopped_reason: null,
      analysis_job_id: null,
      analysis_error: null,
      started_at: '2026-09-07T00:00:00+00:00',
      finished_at: null,
    },
  };
  const sessionRequest = deferred<Session>();
  const { request, view } = await renderPendingSession({
    state: projectState('in_discussion'),
    sessionRequest,
  });
  await act(async () => {
    request.resolve({
      ...emptySession,
      state: 'in_discussion',
      transcript: [{
        role: 'assistant',
        assistant_index: 0,
        canonical: 'An answer.',
        narration: '',
        state_signal: 'in_discussion',
        proposed_commit: null,
        delivery_mode: 'reading',
        chat_job_id: 'chat-1',
        audio_job_id: null,
        audio_error: null,
      }],
    });
    await Promise.resolve();
  });

  await waitFor(() => expect(view.getByTestId('reader-progress-indicator')).toBeTruthy());
  expect(view.getByTestId('floating-top-bar')).toBeTruthy();
  expect(view.queryByTestId('reader-progress')).toBeNull();
});
