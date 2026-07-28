import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from './queryClient';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { Pressable, Text } from 'react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { useAddPaper } from '@/api/queries';
import { ToastProvider, useToast } from '@/ui/Toast';

const mockOffer = jest.fn();
const mockReuse = jest.fn(async (_offer: unknown) => ({ action: 'cancelled', paper: null }));
jest.mock('@/components/InitialAnalysisOffer', () => ({
  offerInitialAnalysis: (offer: unknown) => mockOffer(offer),
}));
jest.mock('@/components/ExistingPaperOffer', () => ({
  requestExistingPaperReuse: (offer: unknown) => mockReuse(offer),
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
  const client = createTestQueryClient();
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

test('an existing paper is offered for reuse instead of silently added again', async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.findPaperMatches).mockResolvedValueOnce({
    target_project: { id: 'proj', name: 'Current project' },
    can_update_notes: true,
    matches: [{
      project_id: 'source',
      project_name: 'Source project',
      identity: 'arxiv:2306.00978',
      has_discussion: true,
      slug: 'awq',
      title: 'AWQ',
      group: 'Core',
      list_status: 'read',
      cites: [],
      retrieved: true,
      has_notes: true,
      session_state: 'committed',
      arxiv_id: '2306.00978',
    }],
  });
  const client = createTestQueryClient();
  const { unmountAsync } = await renderAsync(
    <QueryClientProvider client={client}>
      <AddButton />
    </QueryClientProvider>,
  );

  await fireEventAsync.press(screen.getByText('add'));
  await waitFor(() =>
    expect(mockReuse).toHaveBeenCalledWith(expect.objectContaining({
      targetPid: 'proj',
      targetName: 'Current project',
      matches: [expect.objectContaining({ project_id: 'source', slug: 'awq' })],
    })),
  );
  expect(api.addPaper).not.toHaveBeenCalled();
  expect(mockOffer).not.toHaveBeenCalled();
  await unmountAsync();
  client.clear();
});
