import { QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';

import NotesScreen from '@/app/notes/[target]';
import { ApiError } from '@/api/client';
import { setBaseUrl } from '@/api/config';
import * as api from '@/api/endpoints';
import type { NotesJob, ProjectState } from '@/api/types';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { createTestQueryClient } from './queryClient';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ target: 'flint' }),
  useRouter: () => ({ back: jest.fn(), canGoBack: () => true, push: jest.fn() }),
}));

jest.mock('@/store/project', () => ({
  useActiveProject: () => ({ activePid: 'project' }),
}));

jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: ({ children }: { children: React.ReactNode }) => children,
}));

const retainedProposal: NotesJob = {
  id: 'stale-job',
  target: 'flint',
  instruction: 'Fold the discussion into these notes',
  kind: 'discussion_update',
  summary: 'Update Flint notes',
  base_revision: 'empty-revision',
  relocation_index: null,
  relocation_total: null,
  relocation_title: null,
  status: 'done',
  items: [],
  result: '## Notes\n\nOlder generated proposal with unique detail.',
  error: null,
  started_at: '2026-09-10T03:39:52Z',
  finished_at: '2026-09-10T03:40:16Z',
};

const projectState = {
  project: { id: 'project', name: 'Project' },
  papers: [{
    slug: 'flint',
    title: 'FLINT',
    group: '',
    list_status: 'read',
    cites: [],
    retrieved: true,
    has_notes: true,
    session_state: 'completed',
    arxiv_id: '',
  }],
} as unknown as ProjectState;

async function renderConflictScreen() {
  const client = createTestQueryClient();
  const view = await renderAsync(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <NotesScreen />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText('Older generated proposal with unique detail.')).toBeTruthy());
  return view;
}

beforeEach(async () => {
  jest.clearAllMocks();
  await setBaseUrl('https://api.test');
  jest.mocked(api.getProjectState).mockResolvedValue(projectState);
  jest.mocked(api.getNotes).mockResolvedValue({
    target: 'flint',
    title: 'FLINT',
    markdown: '## Notes\n\nNewer committed notes from Finish Reading.',
  });
  jest.mocked(api.getLatestNotesJob).mockResolvedValue({ job: retainedProposal });
  jest.mocked(api.saveNotes).mockRejectedValue(new ApiError(
    409,
    'These notes changed after the AI proposal was prepared.',
    { code: 'notes_revision_conflict' },
  ));
  jest.mocked(api.discardNotesJob).mockResolvedValue({
    ok: true,
    next_job: null,
    next_error: null,
  });
});

test('a stale approval replaces the active commit action with conflict recovery', async () => {
  await renderConflictScreen();

  await fireEventAsync.press(screen.getByText('Approve & commit'));

  await waitFor(() => expect(screen.getByText('Proposal out of date')).toBeTruthy());
  expect(screen.queryByText('Approve & commit')).toBeNull();
  expect(screen.getByText(/newer committed notes are safe/i)).toBeTruthy();
  expect(screen.getByText('Older generated proposal with unique detail.')).toBeTruthy();
  expect(screen.getByText('Refresh comparison')).toBeTruthy();
  expect(screen.getByText('Edit current notes')).toBeTruthy();
  expect(screen.getByText('Discard old proposal')).toBeTruthy();
});

test('a stale edit-first save keeps its draft visible with the refusal', async () => {
  await renderConflictScreen();

  await fireEventAsync.press(screen.getByText('Edit before committing'));
  await fireEventAsync.changeText(
    screen.getByDisplayValue('## Notes\n\nOlder generated proposal with unique detail.'),
    '## Notes\n\nReader-edited proposal with unique detail.',
  );
  await fireEventAsync.press(screen.getByText('Save'));

  await waitFor(() => expect(screen.getByText(
    'These notes changed after the AI proposal was prepared.',
  )).toBeTruthy());
  expect(screen.getByDisplayValue('## Notes\n\nReader-edited proposal with unique detail.')).toBeTruthy();
  expect(screen.getByText('Save')).toBeTruthy();
  expect(screen.getByText('Cancel')).toBeTruthy();
  expect(screen.queryByText('Proposal out of date')).toBeNull();
  expect(api.discardNotesJob).not.toHaveBeenCalled();
});

test('discard remains explicit after a stale approval', async () => {
  await renderConflictScreen();
  await fireEventAsync.press(screen.getByText('Approve & commit'));
  await waitFor(() => expect(screen.getByText('Proposal out of date')).toBeTruthy());

  await fireEventAsync.press(screen.getByText('Discard old proposal'));

  await waitFor(() => expect(api.discardNotesJob).toHaveBeenCalledWith('project', 'stale-job'));
  await waitFor(() => expect(screen.queryByText('Older generated proposal with unique detail.')).toBeNull());
});

test('editing the current document does not silently discard the old proposal', async () => {
  await renderConflictScreen();
  await fireEventAsync.press(screen.getByText('Approve & commit'));
  await waitFor(() => expect(screen.getByText('Proposal out of date')).toBeTruthy());

  await fireEventAsync.press(screen.getByText('Edit current notes'));

  expect(screen.getByDisplayValue('## Notes\n\nNewer committed notes from Finish Reading.')).toBeTruthy();
  expect(api.discardNotesJob).not.toHaveBeenCalled();
  await fireEventAsync.press(screen.getByText('Cancel'));
  await waitFor(() => expect(screen.getByText('Proposal out of date')).toBeTruthy());
  expect(screen.getByText('Older generated proposal with unique detail.')).toBeTruthy();
});

test('an unrelated project-busy 409 does not masquerade as a stale proposal', async () => {
  jest.mocked(api.saveNotes).mockRejectedValueOnce(new ApiError(
    409,
    'This project is being moved or split — wait, then save notes.',
  ));
  await renderConflictScreen();

  await fireEventAsync.press(screen.getByText('Approve & commit'));

  await waitFor(() => expect(screen.getByText(/project is being moved or split/i)).toBeTruthy());
  expect(screen.queryByText('Proposal out of date')).toBeNull();
  expect(screen.getByText('Approve & commit')).toBeTruthy();
});
