import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from './queryClient';
import { fireEvent, renderAsync, screen, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { MoveToProjectSheet } from '@/components/MoveToProjectSheet';

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.moveProject).mockClear();
});

function render(
  onDone = jest.fn(),
  onClose = jest.fn(),
  operation: 'move' | 'copy' = 'move',
) {
  const client = createTestQueryClient();
  return renderAsync(
    <QueryClientProvider client={client}>
      <MoveToProjectSheet
        visible
        pid="source"
        destPid="dest"
        destName="Quantization"
        slugs={['awq', 'smooth']}
        notesEligible
        operation={operation}
        onClose={onClose}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );
}

test('confirming a move posts to the destination and reports the new pid', async () => {
  const onDone = jest.fn();
  await render(onDone);
  expect(screen.getByText(/Move to .Quantization./)).toBeTruthy();

  fireEvent.press(screen.getByText('Move papers'));  // remove-from-source defaults on
  await waitFor(() =>
    expect(api.moveProject).toHaveBeenCalledWith('source', {
      dest_pid: 'dest',
      slugs: ['awq', 'smooth'],
      remove_from_source: true,
      draft_destination_notes: true,
      cleanup_source_notes: false,
    }),
  );
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
    new_pid: 'dest',
  })));
});

test('copy is explicit and keeps the source project', async () => {
  const onDone = jest.fn();
  await render(onDone, jest.fn(), 'copy');
  expect(screen.getByText(/Copy to .Quantization./)).toBeTruthy();
  expect(screen.queryByText('Remove from this project')).toBeNull();

  fireEvent.press(screen.getByText('Copy papers'));
  await waitFor(() =>
    expect(api.moveProject).toHaveBeenCalledWith('source', {
      dest_pid: 'dest',
      slugs: ['awq', 'smooth'],
      remove_from_source: false,
      draft_destination_notes: true,
      cleanup_source_notes: false,
    }),
  );
});

test('a pre-R8.3 response still reports the committed move as successful', async () => {
  jest.mocked(api.moveProject).mockResolvedValueOnce({
    new_pid: 'dest',
    name: 'Quantization',
    moved: 2,
    removed: true,
  });
  const onDone = jest.fn();
  await render(onDone);

  fireEvent.press(screen.getByText('Move papers'));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
    new_pid: 'dest',
  })));
  expect(screen.queryByText('Could not move the papers.')).toBeNull();
});
