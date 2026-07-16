import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  proposal_revision: 'rev-1',
};

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.getReview).mockResolvedValue(review);
});

function render(onCommitted = jest.fn(), onClose = jest.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return renderAsync(
    <QueryClientProvider client={client}>
      <NotesReviewSheet visible pid="proj" slug="awq" onClose={onClose} onCommitted={onCommitted} />
    </QueryClientProvider>,
  );
}

test('renders the proposed notes and synthesis for review', async () => {
  await render();
  await waitFor(() => expect(screen.getByText('AWQ')).toBeTruthy());
  expect(screen.getByText(/activation-aware quantization/)).toBeTruthy();
  expect(screen.getByText('New synthesis paragraph.')).toBeTruthy();
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
