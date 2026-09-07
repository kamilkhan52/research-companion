import { QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import * as documentPicker from 'expo-document-picker';

import * as api from '@/api/endpoints';
import { AddPaperSheet, titleFromPdfName } from '@/components/AddPaperSheet';
import { showToast } from '@/ui/Toast';
import { createTestQueryClient } from './queryClient';

const mockPush = jest.fn();
const mockReuse = jest.fn();
const mockSummaryOffer = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/ui/Toast', () => ({ showToast: jest.fn() }));
jest.mock('@/components/ExistingPaperOffer', () => ({
  requestExistingPaperReuse: (offer: unknown) => mockReuse(offer),
}));
jest.mock('@/components/PaperSummaryOffer', () => ({
  offerPaperSummary: (offer: unknown) => mockSummaryOffer(offer),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockReuse.mockReset();
  mockSummaryOffer.mockReset();
});

test('derives a provisional title from the selected PDF filename', () => {
  expect(titleFromPdfName('Attention_Is-All-You-Need.pdf')).toBe('Attention Is All You Need');
  expect(titleFromPdfName('Paper%20Title.PDF')).toBe('Paper Title');
  expect(titleFromPdfName('.pdf')).toBe('Uploaded paper');
});

test('keeps known-paper, device-PDF, and Discover entry paths together', async () => {
  const onClose = jest.fn();
  await renderAsync(
    <QueryClientProvider client={createTestQueryClient()}>
      <AddPaperSheet visible pid="project" onClose={onClose} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(screen.getByText('Add a paper')).toBeTruthy());
  expect(screen.getByLabelText('Paper title, DOI, or arXiv link')).toBeTruthy();
  expect(screen.getByLabelText('Upload a PDF from this device')).toBeTruthy();

  await fireEventAsync.press(screen.getByLabelText('Explore papers with Discover'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/discover');
});

test('a native picker failure stays recoverable in the Add paper sheet', async () => {
  jest.mocked(documentPicker.getDocumentAsync).mockRejectedValueOnce(
    new Error('Picker unavailable'),
  );

  await renderAsync(
    <QueryClientProvider client={createTestQueryClient()}>
      <AddPaperSheet visible pid="project" onClose={jest.fn()} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText('Upload a PDF from this device')).toBeTruthy());
  await fireEventAsync.press(screen.getByLabelText('Upload a PDF from this device'));

  await waitFor(() => expect(screen.getByText('Picker unavailable')).toBeTruthy());
  expect(api.addPaper).not.toHaveBeenCalled();
  expect(api.uploadPaper).not.toHaveBeenCalled();
});

test('a local PDF creates one paper, starts its upload, and opens that paper', async () => {
  jest.mocked(documentPicker.getDocumentAsync).mockResolvedValueOnce({
    canceled: false,
    assets: [{
      uri: 'file:///cache/My_Great-Paper.pdf',
      name: 'My_Great-Paper.pdf',
      mimeType: 'application/pdf',
      size: 123,
      lastModified: 1,
      file: undefined,
    }],
  });
  jest.mocked(api.addPaper).mockResolvedValueOnce({
    paper: {
      slug: 'my-great-paper',
      title: 'My Great Paper',
      group: 'Unsorted',
      list_status: 'unread',
      cites: [],
      retrieved: false,
      has_notes: false,
      session_state: null,
      arxiv_id: '',
    },
  });
  jest.mocked(api.uploadPaper).mockResolvedValueOnce({
    job: { id: 'upload-1', status: 'running' },
  } as never);
  const onClose = jest.fn();

  await renderAsync(
    <QueryClientProvider client={createTestQueryClient()}>
      <AddPaperSheet visible pid="project" onClose={onClose} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText('Upload a PDF from this device')).toBeTruthy());
  await fireEventAsync.press(screen.getByLabelText('Upload a PDF from this device'));

  await waitFor(() => expect(api.addPaper).toHaveBeenCalledWith(
    'project', 'My Great Paper', undefined, undefined, undefined, undefined,
  ));
  expect(api.uploadPaper).toHaveBeenCalledWith('project', 'my-great-paper', {
    uri: 'file:///cache/My_Great-Paper.pdf',
    name: 'My_Great-Paper.pdf',
    mimeType: 'application/pdf',
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/paper/my-great-paper');
  expect(mockSummaryOffer).not.toHaveBeenCalled();
});

test('reusing a saved duplicate never overwrites its full text with the selected PDF', async () => {
  jest.mocked(documentPicker.getDocumentAsync).mockResolvedValueOnce({
    canceled: false,
    assets: [{
      uri: 'file:///cache/Duplicate.pdf',
      name: 'Duplicate.pdf',
      mimeType: 'application/pdf',
      size: 123,
      lastModified: 1,
      file: undefined,
    }],
  });
  jest.mocked(api.findPaperMatches).mockResolvedValueOnce({
    target_project: { id: 'project', name: 'Project' },
    can_update_notes: true,
    matches: [{
      project_id: 'source',
      project_name: 'Source project',
      identity: 'title:duplicate',
      has_discussion: true,
      slug: 'saved-duplicate',
      title: 'Duplicate',
      group: 'Core',
      list_status: 'read',
      cites: [],
      retrieved: true,
      has_notes: true,
      session_state: 'committed',
      arxiv_id: '',
    }],
  });
  mockReuse.mockResolvedValueOnce({
    action: 'copied',
    paper: {
      slug: 'saved-duplicate',
      title: 'Duplicate',
      group: 'Core',
      list_status: 'read',
      cites: [],
      retrieved: true,
      has_notes: true,
      session_state: 'committed',
      arxiv_id: '',
    },
  });

  await renderAsync(
    <QueryClientProvider client={createTestQueryClient()}>
      <AddPaperSheet visible pid="project" onClose={jest.fn()} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText('Upload a PDF from this device')).toBeTruthy());
  await fireEventAsync.press(screen.getByLabelText('Upload a PDF from this device'));

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/paper/saved-duplicate'));
  expect(api.addPaper).not.toHaveBeenCalled();
  expect(api.uploadPaper).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith(
    'Reused the saved paper and kept its existing full text.',
  );
});

test('an immediate upload failure opens the one created paper for an obvious retry', async () => {
  jest.mocked(documentPicker.getDocumentAsync).mockResolvedValueOnce({
    canceled: false,
    assets: [{
      uri: 'file:///cache/Retry.pdf',
      name: 'Retry.pdf',
      mimeType: 'application/pdf',
      size: 123,
      lastModified: 1,
      file: undefined,
    }],
  });
  jest.mocked(api.addPaper).mockResolvedValueOnce({
    paper: {
      slug: 'retry',
      title: 'Retry',
      group: 'Unsorted',
      list_status: 'unread',
      cites: [],
      retrieved: false,
      has_notes: false,
      session_state: null,
      arxiv_id: '',
    },
  });
  jest.mocked(api.uploadPaper).mockRejectedValueOnce(new Error('Upload unavailable'));

  await renderAsync(
    <QueryClientProvider client={createTestQueryClient()}>
      <AddPaperSheet visible pid="project" onClose={jest.fn()} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText('Upload a PDF from this device')).toBeTruthy());
  await fireEventAsync.press(screen.getByLabelText('Upload a PDF from this device'));

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/paper/retry'));
  expect(showToast).toHaveBeenCalledWith(
    'Paper added, but upload did not start: Upload unavailable',
  );
  expect(api.addPaper).toHaveBeenCalledTimes(1);
});
