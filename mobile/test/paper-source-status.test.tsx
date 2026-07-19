import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null,
  Chat: () => null,
  InputToolbar: () => null,
  MessageText: () => null,
}));

import { CanonicalTitleSheet, ComposeFirst, RenamePaperSheet } from '@/app/paper/[slug]';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { RetrievalJob } from '@/api/types';

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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
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
    ),
  );
  expect(onUpdated).toHaveBeenCalledTimes(1);
});
