import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from './queryClient';
import { fireEvent, fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { setBaseUrl } from '@/api/config';
import type { Review } from '@/api/types';
import { NotesReviewSheet } from '@/components/NotesReviewSheet';

jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: ({ children }: { children: React.ReactNode }) => children,
}));

const review: Review = {
  slug: 'awq',
  title: 'AWQ',
  summary: 'Add AWQ notes',
  notes_block: 'Key idea: activation-aware quantization.',
  synthesis_current: 'old synthesis',
  synthesis_proposed: 'New synthesis paragraph.',
  plan: 'Fold in the 40% result; the related-work section adds nothing new.',
  proposal_revision: 'rev-1',
};

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.getReview).mockResolvedValue(review);
  jest.mocked(api.getNotes).mockResolvedValue({
    target: 'awq',
    title: 'AWQ',
    markdown: 'Key idea: ordinary quantization.',
  });
});

function render(
  onCommitted = jest.fn(),
  onClose = jest.fn(),
  extras: Partial<React.ComponentProps<typeof NotesReviewSheet>> = {},
) {
  const client = createTestQueryClient();
  return renderAsync(
    <QueryClientProvider client={client}>
      <NotesReviewSheet
        visible
        pid="proj"
        slug="awq"
        onClose={onClose}
        onCommitted={onCommitted}
        {...extras}
      />
    </QueryClientProvider>,
  );
}

test('renders the proposed notes and synthesis for review', async () => {
  await render();
  await waitFor(() => expect(screen.getByText('AWQ')).toBeTruthy());
  expect(screen.getByText(/activation-aware quantization/)).toBeTruthy();
  expect(screen.getByText('New synthesis paragraph.')).toBeTruthy();
  expect(screen.getAllByLabelText('Added line').length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText('Removed line').length).toBeGreaterThan(0);
  expect(screen.getByText('What this paper contributes on its own.')).toBeTruthy();
  // DR-057: the section is named in the reader's own vocabulary — it IS the Project Notes.
  expect(screen.getByText('Project Notes')).toBeTruthy();
  // DR-058: the editor's change plan sits above the diff as the intent to judge it against.
  expect(screen.getByText('Change plan')).toBeTruthy();
  expect(screen.getByText(/Fold in the 40% result/)).toBeTruthy();
  expect(screen.getByText(
    'The proposed rewrite of your Project Notes — the synthesis across everything read so far.',
  )).toBeTruthy();
  expect(screen.getByText(/Nothing joins the project until you approve/)).toBeTruthy();
});

test('keeps approve, request edits, and cancel in the review sheet', async () => {
  const onRequestEdits = jest.fn().mockResolvedValue(undefined);
  const onClose = jest.fn();
  await render(jest.fn(), onClose, { onRequestEdits });
  await waitFor(() => expect(screen.getByText('AWQ')).toBeTruthy());

  expect(screen.getByText('Approve & commit')).toBeTruthy();
  expect(screen.getByText('Cancel')).toBeTruthy();
  expect(screen.getByText('FINISH REVIEW')).toBeTruthy();
  await fireEventAsync.press(screen.getByText('Request edits'));
  expect(screen.getByPlaceholderText('Tell the analyst what to revise…')).toBeTruthy();
  fireEvent.changeText(screen.getByPlaceholderText('Tell the analyst what to revise…'), 'Keep the caveat.');
  await fireEventAsync.press(screen.getByText('Send edit request'));

  expect(onRequestEdits).toHaveBeenCalledWith('Keep the caveat.');
  expect(onClose).not.toHaveBeenCalled();
});

test('shows the real request phase and counts drafted words', async () => {
  await render(jest.fn(), jest.fn(), {
    onRequestEdits: jest.fn(),
    requesting: true,
    requestActivity: 'Checking the cited evidence…',
    requestItems: [{ kind: 'text', text: 'Three precise words' }],
  });
  await waitFor(() => expect(screen.getByText('Checking the cited evidence…')).toBeTruthy());
  expect(screen.getByText('3 words drafted')).toBeTruthy();
  expect(screen.queryByText(/characters drafted/)).toBeNull();
});

test('an unedited approve sends the reviewed payload with the revision token', async () => {
  jest.mocked(api.approve).mockResolvedValue({ result: {}, paper: {} });
  const onCommitted = jest.fn();
  await render(onCommitted);
  await waitFor(() => expect(screen.getByText('AWQ')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Approve & commit'));
  await waitFor(() =>
    expect(api.approve).toHaveBeenCalledWith('proj', 'awq', {
      notes_block: review.notes_block,
      synthesis: review.synthesis_proposed,
      summary: review.summary,
      proposal_revision: 'rev-1',
    }));
  expect(onCommitted).toHaveBeenCalled();
});

test('editing the notes sends the edited text on approve', async () => {
  jest.mocked(api.approve).mockResolvedValue({ result: {}, paper: {} });
  await render();
  await waitFor(() => expect(screen.getByText('AWQ')).toBeTruthy());
  await fireEventAsync.press(screen.getByLabelText('Edit'));
  fireEvent.changeText(screen.getByDisplayValue(review.notes_block), 'Edited notes.');
  await fireEventAsync.press(screen.getByText('Approve & commit'));
  await waitFor(() =>
    expect(api.approve).toHaveBeenCalledWith('proj', 'awq', expect.objectContaining({
      notes_block: 'Edited notes.',
      proposal_revision: 'rev-1',
    })));
});

test('a 409 stale approval surfaces a reload message', async () => {
  jest.mocked(api.approve).mockRejectedValue(new ApiError(409, 'stale'));
  await render();
  await waitFor(() => expect(screen.getByText('AWQ')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Approve & commit'));
  await waitFor(() => expect(screen.getByText(/proposal changed since you opened/)).toBeTruthy());
});
