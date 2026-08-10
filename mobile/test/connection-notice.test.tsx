import { renderAsync, screen } from '@testing-library/react-native';

import { ConnectionNotice } from '@/components/ConnectionNotice';

test('the reconnect notice is quiet status with no stale dismissal control', async () => {
  await renderAsync(<ConnectionNotice message="Reconnecting… Your response is safe." />);

  expect(screen.getByLabelText('Reconnecting… Your response is safe.')).toBeTruthy();
  expect(screen.queryByText('Dismiss')).toBeNull();
  expect(screen.queryByText(/lost|offline|failed/i)).toBeNull();
});
