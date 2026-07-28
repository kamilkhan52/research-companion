/** Google Play's AI-Generated Content policy requires an app whose content is AI-generated to let
 *  users "report or flag offensive content to developers without needing to exit the app". These
 *  pin the parts of that sentence a regression would break: that a reason is reachable in-app,
 *  that a report actually reaches the server, and that a failure is never passed off as success. */
import { fireEvent, renderAsync, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { ReportContentSheet } from '@/components/ReportContentSheet';

// `mock`-prefixed because Jest hoists the factory above this and forbids other out-of-scope refs.
const mockToast = jest.fn();
jest.mock('@/ui/Toast', () => ({
  ...jest.requireActual('@/ui/Toast'),
  useToast: () => ({ toast: mockToast }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(api, 'reportContent').mockResolvedValue({
    report: { id: 'r1', created_at: '2026-07-28T00:00:00Z' },
  });
});

async function openSheet(onClose = jest.fn()) {
  const view = await renderAsync(
    <ReportContentSheet
      visible
      onClose={onClose}
      surface="discussion"
      projectId="quantum"
      paperSlug="attention"
      reference="transcript:12"
    />,
  );
  return { view, onClose };
}

test('a reason can be chosen and reaches the server with a pointer, not the content', async () => {
  const { view, onClose } = await openSheet();

  fireEvent.press(view.getByText('Harmful or dangerous'));

  await waitFor(() => expect(api.reportContent).toHaveBeenCalled());
  const body = jest.mocked(api.reportContent).mock.calls[0][0];
  expect(body).toEqual({
    surface: 'discussion',
    reason: 'harmful',
    project_id: 'quantum',
    paper_slug: 'attention',
    reference: 'transcript:12',
  });
  expect(onClose).toHaveBeenCalled();
  await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/Reported/)));
});

test('a failed report says so instead of thanking the reader', async () => {
  // A report the reader believes was filed, and was not, is worse than one that visibly failed:
  // they think they have been heard and nothing was recorded.
  jest.spyOn(api, 'reportContent').mockRejectedValue(new Error('Too many reports today.'));
  const { view } = await openSheet();

  fireEvent.press(view.getByText('Offensive'));

  await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Too many reports today.'));
  expect(mockToast).not.toHaveBeenCalledWith(expect.stringMatching(/Thank you/));
});

test('every reason the server accepts is offered', async () => {
  // The client must not silently narrow the vocabulary: a reason the reader cannot pick is a
  // report that never gets filed under it. Mirrors app/content_reports.REASONS.
  const { view } = await openSheet();
  for (const label of [
    'Offensive', 'Harmful or dangerous', 'Seriously misleading',
    'Sexual content', 'Violent content', 'Harassment', 'Something else',
  ]) {
    expect(view.getByText(label)).toBeTruthy();
  }
});
