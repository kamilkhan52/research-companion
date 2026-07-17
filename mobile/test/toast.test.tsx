import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { Pressable, Text } from 'react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { useAddPaper } from '@/api/queries';
import { ToastProvider, useToast } from '@/ui/Toast';

const mockOffer = jest.fn();
jest.mock('@/components/InitialAnalysisOffer', () => ({
  offerInitialAnalysis: (offer: unknown) => mockOffer(offer),
}));

function Fire({ message }: { message: string }) {
  const { toast } = useToast();
  return (
    <Pressable onPress={() => toast(message)}>
      <Text>fire</Text>
    </Pressable>
  );
}

test('useToast shows the message after firing', async () => {
  const { unmountAsync } = await renderAsync(
    <ToastProvider>
      <Fire message="Hello there" />
    </ToastProvider>,
  );
  expect(screen.queryByText('Hello there')).toBeNull();
  await fireEventAsync.press(screen.getByText('fire'));
  expect(screen.getByText('Hello there')).toBeTruthy();
  await unmountAsync(); // clears the pending auto-dismiss timer
});

function AddButton() {
  const add = useAddPaper('proj');
  return (
    <Pressable onPress={() => add.mutate({ title: 'AWQ' })}>
      <Text>add</Text>
    </Pressable>
  );
}

test('adding a paper raises the initial-analysis offer (R7.8)', async () => {
  await setBaseUrl('https://api.test');
  jest
    .mocked(api.addPaper)
    .mockResolvedValue({ paper: { slug: 'awq', title: 'AWQ', arxiv_id: '2306.00978' } } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
  }

  const { unmountAsync } = await renderAsync(<AddButton />, { wrapper: Wrapper });
  await fireEventAsync.press(screen.getByText('add'));
  await waitFor(() =>
    expect(mockOffer).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 'proj', slug: 'awq', title: 'AWQ', arxivId: '2306.00978' }),
    ),
  );
  await unmountAsync();
  client.clear();
});
