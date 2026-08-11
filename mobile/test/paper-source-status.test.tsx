import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from './queryClient';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null,
  Chat: () => null,
  InputToolbar: () => null,
  MessageText: () => null,
}));

import {
  applyPaperUpdateToActiveSession,
  CanonicalTitleSheet,
  ComposeFirst,
  hasStartedDiscussion,
  OverflowMenu,
  RenamePaperSheet,
  shouldSuggestCanonicalTitle,
} from '@/app/paper/[slug]';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { keys } from '@/api/queries';
import type { Paper, RetrievalJob, Session } from '@/api/types';

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.getLatestRetrievalJob).mockResolvedValue({ job: null });
  jest.mocked(api.getOpeningDraft).mockResolvedValue({
    prompt: 'Give me a balanced first read.',
    model: null,
    title: 'Rough Ttle',
    templates: {
      balanced: 'Give me a balanced first read.',
      background: 'Explain the background.',
      technical: 'Focus on methods.',
      detailed: 'Walk through everything.',
    },
  });
});

function wrapper(children: React.ReactNode) {
  const client = createTestQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const doneJob: RetrievalJob = {
  id: 'retrieval-1',
  slug: 'rough',
  status: 'done',
  error: null,
  phase: 'done',
  detail: 'Rough Ttle',
  candidates: [],
  items: [],
  retrieved: true,
  matched_title: 'The Canonical Title',
  arxiv_id: '2401.00001',
  source: 'https://arxiv.org/abs/2401.00001',
  analysis_job_id: null,
  analysis_error: null,
  enrichment: null,
};

test('explicit Fetch updates durable source status without starting the discussion', async () => {
  jest.mocked(api.startRetrievalJob).mockResolvedValue({ job: doneJob });
  const stream = {
    streaming: false,
    items: [],
    run: jest.fn(),
    stop: jest.fn(),
  };
  await renderAsync(
    wrapper(
      <ComposeFirst
        pid="project"
        slug="rough"
        title="Rough Ttle"
        stream={stream as never}
        chatStartPath="/chat/start"
        sessionState={null}
        selectedModel={null}
        retrieved={false}
      />,
    ),
  );

  expect(await screen.findByText('Full text not fetched')).toBeTruthy();
  await fireEventAsync.press(screen.getByText('Fetch paper'));

  await waitFor(() => expect(api.startRetrievalJob).toHaveBeenCalledWith(
    'project',
    'rough',
    undefined,
  ));
  expect(await screen.findByText('Full text ready')).toBeTruthy();
  expect(screen.getByText('The Canonical Title')).toBeTruthy();
  expect(stream.run).not.toHaveBeenCalled();
});

test('compose-first Keep mine persists the resolver-title decision', async () => {
  jest.mocked(api.startRetrievalJob).mockResolvedValue({ job: doneJob });
  const keptPaper: Paper = {
    slug: 'rough',
    title: 'Rough Ttle',
    group: 'Unsorted',
    list_status: 'unread',
    cites: [],
    retrieved: true,
    has_notes: false,
    session_state: null,
    arxiv_id: '2401.00001',
    title_confirmed: true,
  };
  jest.mocked(api.updatePaper).mockResolvedValue({ paper: keptPaper });
  const stream = { streaming: false, items: [], run: jest.fn(), stop: jest.fn() };
  await renderAsync(
    wrapper(
      <ComposeFirst
        pid="project"
        slug="rough"
        title="Rough Ttle"
        stream={stream as never}
        chatStartPath="/chat/start"
        sessionState={null}
        selectedModel={null}
        retrieved={false}
      />,
    ),
  );

  await fireEventAsync.press(await screen.findByText('Fetch paper'));
  await fireEventAsync.press(await screen.findByText('Keep mine'));

  await waitFor(() => expect(api.updatePaper).toHaveBeenCalledWith(
    'project', 'rough', undefined, true,
  ));
  expect(screen.queryByText('Keep mine')).toBeNull();
});

test('first-read enrichment uses the existing retrieval status surface', async () => {
  const warmingJob: RetrievalJob = {
    ...doneJob,
    enrichment: {
      status: 'running',
      step: 'Reading first page… · Mapping references… · Finding figures…',
    },
  };
  jest.mocked(api.getLatestRetrievalJob).mockResolvedValueOnce({ job: warmingJob });
  jest.mocked(api.getRetrievalJob).mockResolvedValue({ job: warmingJob });
  const stream = { streaming: false, items: [], run: jest.fn(), stop: jest.fn() };

  await renderAsync(
    wrapper(
      <ComposeFirst
        pid="project"
        slug="rough"
        title="Rough Ttle"
        stream={stream as never}
        chatStartPath="/chat/start"
        sessionState={null}
        selectedModel={null}
        retrieved={false}
      />,
    ),
  );

  expect(await screen.findByText(
    'Reading first page… · Mapping references… · Finding figures…',
  )).toBeTruthy();
});

test('Start reading automatically fetches before it starts the opening turn', async () => {
  jest.mocked(api.startRetrievalJob).mockResolvedValue({ job: doneJob });
  const stream = {
    streaming: false,
    items: [],
    run: jest.fn(async () => undefined),
    stop: jest.fn(),
  };
  await renderAsync(
    wrapper(
      <ComposeFirst
        pid="project"
        slug="rough"
        title="Rough Ttle"
        stream={stream as never}
        chatStartPath="/chat/start"
        sessionState={null}
        selectedModel={null}
        retrieved={false}
      />,
    ),
  );

  await fireEventAsync.press(await screen.findByText('Fetch & start reading'));

  await waitFor(() => expect(api.startRetrievalJob).toHaveBeenCalled());
  await waitFor(() => expect(stream.run).toHaveBeenCalledWith(
    '/chat/start',
    expect.objectContaining({
      slug: 'rough',
      prompt: 'Give me a balanced first read.',
    }),
    undefined,
    expect.any(Function),
  ));
});

test('known-paper navigation starts the durable analysis without another tap', async () => {
  jest.mocked(api.startRetrievalJob).mockResolvedValue({ job: doneJob });
  const stream = {
    streaming: false,
    items: [],
    run: jest.fn(async () => undefined),
    stop: jest.fn(),
  };
  await renderAsync(
    wrapper(
      <ComposeFirst
        pid="project"
        slug="rough"
        title="Rough Ttle"
        stream={stream as never}
        chatStartPath="/chat/start"
        initialSource="2401.00001"
        autoStart
        sessionState={null}
        selectedModel={null}
        retrieved={false}
      />,
    ),
  );

  await waitFor(() => expect(api.startRetrievalJob).toHaveBeenCalledWith(
    'project',
    'rough',
    { arxiv_id: '2401.00001' },
  ));
  await waitFor(() => expect(stream.run).toHaveBeenCalledWith(
    '/chat/start',
    expect.objectContaining({ slug: 'rough', prompt: 'Give me a balanced first read.' }),
    undefined,
    expect.any(Function),
  ));
});

test('a failed fetch exposes native PDF upload recovery', async () => {
  const failedJob: RetrievalJob = {
    ...doneJob,
    id: 'failed',
    status: 'error',
    phase: 'resolving',
    error: 'No arXiv match.',
    retrieved: false,
    matched_title: null,
  };
  jest.mocked(api.getLatestRetrievalJob).mockResolvedValueOnce({ job: failedJob });
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
    canceled: false,
    assets: [{
      uri: 'file:///paper.pdf',
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 123,
      lastModified: 0,
      file: undefined,
    }],
  });
  jest.mocked(api.uploadPaper).mockResolvedValueOnce({
    job: { ...doneJob, id: 'upload', matched_title: null, source: 'upload:paper.pdf' },
  });
  const stream = { streaming: false, items: [], run: jest.fn(), stop: jest.fn() };
  await renderAsync(
    wrapper(
      <ComposeFirst
        pid="project"
        slug="rough"
        title="Rough Ttle"
        stream={stream as never}
        chatStartPath="/chat/start"
        sessionState={null}
        selectedModel={null}
        retrieved={false}
      />,
    ),
  );

  expect(await screen.findByText('No arXiv match.')).toBeTruthy();
  await fireEventAsync.press(screen.getByText('Upload PDF'));

  await waitFor(() => expect(api.uploadPaper).toHaveBeenCalledWith(
    'project',
    'rough',
    {
      uri: 'file:///paper.pdf',
      name: 'paper.pdf',
      mimeType: 'application/pdf',
    },
  ));
  expect(await screen.findByText('Full text ready')).toBeTruthy();
});

test('paper rename sheet preserves the stable slug in the API call', async () => {
  jest.mocked(api.updatePaper).mockResolvedValue({
    paper: {
      slug: 'stable',
      title: 'Corrected Title',
      group: 'Unsorted',
      list_status: 'unread',
      cites: [],
      retrieved: true,
      has_notes: false,
      session_state: null,
      arxiv_id: '',
    },
  });
  const onRenamed = jest.fn();
  await renderAsync(
    <RenamePaperSheet
      visible
      pid="project"
      slug="stable"
      title="Rough Title"
      onClose={() => {}}
      onRenamed={onRenamed}
    />,
  );

  await fireEventAsync.changeText(screen.getByPlaceholderText('Paper title'), 'Corrected Title');
  await fireEventAsync.press(screen.getByText('Save name'));

  await waitFor(() =>
    expect(api.updatePaper).toHaveBeenCalledWith('project', 'stable', 'Corrected Title'),
  );
  expect(onRenamed).toHaveBeenCalledTimes(1);
});

test('paper rename keeps raw controlled input verbatim until backend normalization', async () => {
  const updated: Paper = {
    slug: 'stable',
    title: 'Corrected Paper Title',
    group: 'Unsorted',
    list_status: 'unread',
    cites: [],
    retrieved: true,
    has_notes: false,
    session_state: null,
    arxiv_id: '',
  };
  jest.mocked(api.updatePaper).mockResolvedValue({ paper: updated });
  await renderAsync(
    <RenamePaperSheet
      visible
      pid="project"
      slug="stable"
      title="Rough Title"
      onClose={() => {}}
      onRenamed={() => {}}
    />,
  );

  const raw = '  Corrected   Paper Title  ';
  await fireEventAsync.changeText(screen.getByPlaceholderText('Paper title'), raw);
  expect(screen.getByPlaceholderText('Paper title').props.value).toBe(raw);
  await fireEventAsync.press(screen.getByText('Save name'));

  await waitFor(() => expect(api.updatePaper).toHaveBeenCalledWith('project', 'stable', raw));
});

test('canonical title confirmation never rewrites until Update title is pressed', async () => {
  jest.mocked(api.updatePaper).mockResolvedValue({
    paper: {
      slug: 'stable',
      title: 'Canonical Source Title',
      group: 'Unsorted',
      list_status: 'unread',
      cites: [],
      retrieved: true,
      has_notes: false,
      session_state: 'in_discussion',
      arxiv_id: '2401.00001',
    },
  });
  const onUpdated = jest.fn();
  await renderAsync(
    <CanonicalTitleSheet
      visible
      pid="project"
      slug="stable"
      currentTitle="Rough Ttle"
      suggestedTitle="Canonical Source Title"
      onClose={() => {}}
      onUpdated={onUpdated}
    />,
  );

  expect(screen.getByText('Rough Ttle')).toBeTruthy();
  expect(screen.getByText('Canonical Source Title')).toBeTruthy();
  expect(api.updatePaper).not.toHaveBeenCalled();

  await fireEventAsync.press(screen.getByText('Update title'));
  await waitFor(() =>
    expect(api.updatePaper).toHaveBeenCalledWith(
      'project',
      'stable',
      'Canonical Source Title',
      true,
    ),
  );
  expect(onUpdated).toHaveBeenCalledTimes(1);
});

test('Keep mine persists the title decision without renaming', async () => {
  const keptPaper: Paper = {
    slug: 'stable',
    title: 'My Deliberate Title',
    group: 'Unsorted',
    list_status: 'unread',
    cites: [],
    retrieved: true,
    has_notes: false,
    session_state: 'in_discussion',
    arxiv_id: '2401.00001',
    title_confirmed: true,
  };
  jest.mocked(api.updatePaper).mockResolvedValue({ paper: keptPaper });
  const onUpdated = jest.fn();
  await renderAsync(
    <CanonicalTitleSheet
      visible
      pid="project"
      slug="stable"
      currentTitle="My Deliberate Title"
      suggestedTitle="Canonical Source Title"
      onClose={() => {}}
      onUpdated={onUpdated}
    />,
  );

  await fireEventAsync.press(screen.getByText('Keep mine'));

  await waitFor(() => expect(api.updatePaper).toHaveBeenCalledWith(
    'project', 'stable', undefined, true,
  ));
  expect(onUpdated).toHaveBeenCalledWith(keptPaper);
});

test('a confirmed title suppresses future resolver suggestions', () => {
  const paper = { title: 'My Deliberate Title', title_confirmed: true };
  expect(shouldSuggestCanonicalTitle(paper, 'Canonical Source Title')).toBe(false);
  expect(shouldSuggestCanonicalTitle(
    { ...paper, title_confirmed: false },
    'Canonical Source Title',
  )).toBe(true);
  expect(shouldSuggestCanonicalTitle(
    { ...paper, title_confirmed: false },
    'My deliberate title!',
  )).toBe(false);
});

test('title updates preserve the active thread session while refetching its exact key', async () => {
  const client = createTestQueryClient();
  const paper: Paper = {
    slug: 'stable',
    title: 'Rough Title',
    group: 'Unsorted',
    list_status: 'unread',
    cites: [],
    retrieved: true,
    has_notes: false,
    session_state: 'in_discussion',
    arxiv_id: '',
  };
  const activeSession: Session = {
    paper,
    state: 'in_discussion',
    reading_mode: 'balanced',
    transcript: [{ role: 'user', text: 'Keep this live thread' }],
    accepted_drafts: [],
    thread_id: 'thread-live',
    threads: [],
  };
  const mainSession: Session = { ...activeSession, transcript: [], thread_id: 'main' };
  client.setQueryData(keys.session('project', 'stable'), mainSession);
  client.setQueryData(keys.session('project', 'stable', 'thread-live'), activeSession);

  await applyPaperUpdateToActiveSession(
    client,
    'project',
    'stable',
    'thread-live',
    { ...paper, title: 'Canonical Title', title_confirmed: true },
  );

  const preserved = client.getQueryData<Session>(
    keys.session('project', 'stable', 'thread-live'),
  );
  expect(preserved).toMatchObject({
    thread_id: 'thread-live',
    state: 'in_discussion',
    transcript: [{ role: 'user', text: 'Keep this live thread' }],
    paper: { title: 'Canonical Title', title_confirmed: true },
  });
  expect(client.getQueryData<Session>(keys.session('project', 'stable'))?.paper.title)
    .toBe('Rough Title');
  expect(client.getQueryState(keys.session('project', 'stable', 'thread-live'))?.isInvalidated)
    .toBe(true);
  expect(client.getQueryState(keys.session('project', 'stable'))?.isInvalidated)
    .toBe(false);
});

test('durable discussion state never falls back to ComposeFirst on an empty refetch', () => {
  expect(hasStartedDiscussion('in_discussion', 0, 'main')).toBe(true);
  expect(hasStartedDiscussion('notes_drafted', 0, 'main')).toBe(true);
  expect(hasStartedDiscussion(null, 0, 'main')).toBe(false);
  expect(hasStartedDiscussion('retrieving', 0, 'main')).toBe(false);
  expect(hasStartedDiscussion(null, 0, 'thread-live')).toBe(true);
});

test('paper overflow menu retains the destructive delete action', async () => {
  const onDelete = jest.fn();
  await renderAsync(
    <OverflowMenu
      listeningMode={false}
      onToggleListening={() => {}}
      hasNotes={false}
      onViewNotes={() => {}}
      onRelatedWorks={() => {}}
      onGraph={() => {}}
      paperUrl={null}
      showFinishReading={false}
      finishReadingDisabled={false}
      onFinishReading={() => {}}
      showUpdateNotes={false}
      updateNotesDisabled={false}
      onUpdateNotes={() => {}}
      showContinue={false}
      onContinue={() => {}}
      modelLabel="Default"
      onPickModel={() => {}}
      showReadingMode={false}
      readingModeLabel="Balanced"
      onPickReadingMode={() => {}}
      onRename={() => {}}
      onDelete={onDelete}
      showThreads={false}
      threadCount={0}
      onThreads={() => {}}
    />,
  );

  await fireEventAsync.press(screen.getByLabelText('More actions'));
  await fireEventAsync.press(await screen.findByText('Delete from project'));
  expect(onDelete).toHaveBeenCalledTimes(1);
});
