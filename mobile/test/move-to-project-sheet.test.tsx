import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, renderAsync, screen, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { MoveToProjectSheet } from '@/components/MoveToProjectSheet';

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.moveProject).mockClear();
});

function render(onDone = jest.fn(), onClose = jest.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return renderAsync(
    <QueryClientProvider client={client}>
      <MoveToProjectSheet
        visible
        pid="source"
        destPid="dest"
        destName="Quantization"
        slugs={['awq', 'smooth']}
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
    }),
  );
  await waitFor(() => expect(onDone).toHaveBeenCalledWith('dest'));
});
