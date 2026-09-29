// DR-167 — reset a paper's fetched text. Three papers in two days were filed with ANOTHER
// paper's full text, and once a paper is retrieved the setup surface (Fetch, link, upload) is
// gone, so a wrong source had no in-app way out.
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from './queryClient';
import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null,
  Chat: () => null,
  InputToolbar: () => null,
  MessageText: () => null,
}));

import { ComposeFirst, OverflowMenu } from '@/app/paper/[slug]';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { RetrievalJob } from '@/api/types';
import { ThemeProvider } from '@/theme/ThemeProvider';

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.getLatestRetrievalJob).mockResolvedValue({ job: null });
  jest.mocked(api.getOpeningDraft).mockResolvedValue({
    prompt: 'Give me a balanced first read.',
    model: null,
    title: 'Survey',
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
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}

const stream = { streaming: false, items: [], run: jest.fn(), stop: jest.fn() };

function setup(props: Partial<React.ComponentProps<typeof ComposeFirst>> = {}) {
  return renderAsync(
    wrapper(
      <ComposeFirst
        pid="project"
        slug="survey"
        title="Monolithically Stackable 1T1C 3-D DRAM: A Technical Survey"
        stream={stream as never}
        chatStartPath="/chat/start"
        sessionState={null}
        selectedModel={null}
        retrieved={false}
        {...props}
      />,
    ),
  );
}

const MENU_PROPS = {
  listeningMode: false,
  onToggleListening: () => {},
  hasNotes: false,
  onViewNotes: () => {},
  onRelatedWorks: () => {},
  onGraph: () => {},
  paperUrl: null,
  showFinishReading: false,
  finishReadingDisabled: false,
  onFinishReading: () => {},
  showUpdateNotes: false,
  updateNotesDisabled: false,
  onUpdateNotes: () => {},
  showContinue: false,
  onContinue: () => {},
  modelLabel: 'Default',
  onPickModel: () => {},
  showReadingMode: false,
  readingModeLabel: 'Balanced',
  onPickReadingMode: () => {},
  onRename: () => {},
  onDelete: () => {},
  showClearChats: false,
  clearChatsDisabled: false,
  onClearChats: () => {},
  showThreads: false,
  threadCount: 0,
  onThreads: () => {},
};

test('a reset forgets the retrieval the setup surface was showing and opens the own-source panel', async () => {
  const retrievedJob: RetrievalJob = {
    id: 'r1', slug: 'survey', status: 'done', error: null, phase: 'done', detail: '',
    candidates: [], items: [], retrieved: true, analysis_job_id: null, analysis_error: null,
    enrichment: null,
  };
  jest.mocked(api.getLatestRetrievalJob).mockResolvedValue({ job: retrievedJob });
  const view = await setup();
  expect(await screen.findByText('Full text ready')).toBeTruthy();
  expect(screen.queryByText('Use your own source')).toBeNull();

  await view.rerenderAsync(
    wrapper(
      <ComposeFirst
        pid="project"
        slug="survey"
        title="Monolithically Stackable 1T1C 3-D DRAM: A Technical Survey"
        stream={stream as never}
        chatStartPath="/chat/start"
        sessionState={null}
        selectedModel={null}
        retrieved={false}
        sourceResetToken={1}
      />,
    ),
  );

  // The retained snapshot said retrieved=true; after the reset it is gone server-side, so the
  // surface must not keep trusting it — and the reader gets link/upload without a failed
  // fetch first.
  expect(await screen.findByText('Full text not fetched')).toBeTruthy();
  expect(screen.getByText('Use your own source')).toBeTruthy();
  expect(screen.getByText('Upload PDF')).toBeTruthy();
  expect(screen.getByText('Fetch paper')).toBeTruthy();
});

test('a refused search match says which paper was refused, above the candidates', async () => {
  const confirmation: RetrievalJob = {
    id: 'r2', slug: 'survey', status: 'done', error: null, phase: 'confirmation',
    detail: 'The closest arXiv match is “Row Hammer Effect and Floating Body Effect of Monolithic 3D Stackable 1T1C DRAM”, which does not name this paper on its first page.',
    candidates: [{ arxiv_id: '2511.00638', title: 'Row Hammer Effect and Floating Body Effect of Monolithic 3D Stackable 1T1C DRAM' }],
    items: [], retrieved: false, analysis_job_id: null, analysis_error: null, enrichment: null,
  };
  jest.mocked(api.getLatestRetrievalJob).mockResolvedValue({ job: confirmation });
  await setup();
  expect(await screen.findByText('Confirm the paper source')).toBeTruthy();
  expect(screen.getByText(/does not name this paper on its first page/)).toBeTruthy();
  expect(screen.getByText('Choose the paper you meant')).toBeTruthy();
  expect(screen.getByText('Use your own source')).toBeTruthy();
});

test('the menu offers Reset fetched text only for a paper with fetched text', async () => {
  const onResetSource = jest.fn();
  await renderAsync(
    <ThemeProvider>
      <OverflowMenu {...MENU_PROPS} showResetSource onResetSource={onResetSource} />
    </ThemeProvider>,
  );
  await fireEventAsync.press(screen.getByLabelText('More actions'));
  await fireEventAsync.press(await screen.findByText('Reset fetched text'));
  expect(onResetSource).toHaveBeenCalledTimes(1);
});

test('the menu hides Reset fetched text for a paper without text', async () => {
  await renderAsync(
    <ThemeProvider>
      <OverflowMenu {...MENU_PROPS} showResetSource={false} />
    </ThemeProvider>,
  );
  await fireEventAsync.press(screen.getByLabelText('More actions'));
  expect(screen.queryByText('Reset fetched text')).toBeNull();
});
