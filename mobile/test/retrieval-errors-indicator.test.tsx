import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import { RetrievalErrors } from '@/app/(tabs)/graph';

const build = { building: false, run: jest.fn() } as never;
const errors = { 'paper-a': 'No confident arXiv match', 'paper-b': 'PDF download failed' };

test('errors surface as a small indicator; details live in the sheet', async () => {
  await renderAsync(<RetrievalErrors errors={errors} build={build} />);

  // Compact pill, not a big card.
  expect(screen.queryByText('Papers that could not be retrieved')).toBeNull();
  await fireEventAsync.press(screen.getByText('2 not retrieved'));

  expect(screen.getByText('Papers that could not be retrieved')).toBeTruthy();
  expect(screen.getByText('No confident arXiv match')).toBeTruthy();
  expect(screen.getByText('PDF download failed')).toBeTruthy();
});

test('dismiss shrinks to a ghost icon that still opens the sheet', async () => {
  await renderAsync(<RetrievalErrors errors={errors} build={build} />);
  await fireEventAsync.press(screen.getByText('2 not retrieved'));
  await fireEventAsync.press(screen.getByText('Dismiss'));

  // Count text gone (ghost mode), but the entry point remains accessible.
  expect(screen.queryByText('2 not retrieved')).toBeNull();
  await fireEventAsync.press(
    screen.getByLabelText('2 papers could not be retrieved — show details'),
  );
  expect(screen.getByText('No confident arXiv match')).toBeTruthy();
});

test('retry closes the sheet and reruns the build', async () => {
  const run = jest.fn();
  await renderAsync(<RetrievalErrors errors={errors} build={{ building: false, run } as never} />);
  await fireEventAsync.press(screen.getByText('2 not retrieved'));
  await fireEventAsync.press(screen.getByText('Retry missing papers'));
  expect(run).toHaveBeenCalledWith(false);
});
