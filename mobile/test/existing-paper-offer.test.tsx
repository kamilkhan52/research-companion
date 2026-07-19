import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEventAsync,
  renderAsync,
  screen,
  waitFor,
} from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import {
  ExistingPaperOfferHost,
  requestExistingPaperReuse,
} from '@/components/ExistingPaperOffer';

beforeEach(async () => {
  await setBaseUrl('https://api.test');
});

test('copy is the safe default and carries notes plus discussion work', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const { unmountAsync } = await renderAsync(
    <QueryClientProvider client={client}>
      <ExistingPaperOfferHost />
    </QueryClientProvider>,
  );

  let outcomePromise!: ReturnType<typeof requestExistingPaperReuse>;
  await act(async () => {
    outcomePromise = requestExistingPaperReuse({
      targetPid: 'current',
      targetName: 'Current project',
      candidateTitle: 'AWQ',
      canUpdateNotes: true,
      matches: [{
        project_id: 'source',
        project_name: 'Quantization',
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
  });

  await waitFor(() => expect(screen.getByText('Copy here')).toBeTruthy());
  expect(screen.getByText('Discussion history and branches')).toBeTruthy();
  await fireEventAsync.press(screen.getByText('Copy here'));

  await waitFor(() =>
    expect(api.moveProject).toHaveBeenCalledWith('source', {
      dest_pid: 'current',
      slugs: ['awq'],
      remove_from_source: false,
      draft_destination_notes: true,
      cleanup_source_notes: false,
    }),
  );
  await expect(outcomePromise).resolves.toEqual(expect.objectContaining({
    action: 'copied',
    paper: expect.objectContaining({ slug: 'awq', title: 'AWQ' }),
  }));

  await unmountAsync();
  client.clear();
});
