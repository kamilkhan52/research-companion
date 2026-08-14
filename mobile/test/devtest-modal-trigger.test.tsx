// DR-078 — "Dev test bubble hides under menus." Native Modals are separate OS windows, so
// hosts like OptionsSheet render their own trigger copy inside the window. That copy must
// (a) exist only while the root DevTestBubble is mounted — the mount is the dev-mode truth —
// and (b) open the ONE root-owned sheet, not a second one.

import { act, render, waitFor } from '@testing-library/react-native';

import {
  DevTestBubble,
  DevTestFloatingTriggerIfActive,
  requestDevTestOpen,
} from '@/components/DevTestBubble';

jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));

jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn().mockResolvedValue({ items: [] }),
  recordDevTestFeedback: jest.fn(),
  getDevTestFeedback: jest.fn(),
  createDevTestItem: jest.fn(),
}));

test('the modal-layer trigger follows the root bubble mount, and opens its sheet', async () => {
  // Nothing mounted yet: the modal-layer copy renders nothing (this is also the state every
  // OptionsSheet unit test exercises, which is why they need no react-query provider).
  const trigger = render(<DevTestFloatingTriggerIfActive />);
  expect(trigger.queryByLabelText('Open device-test companion')).toBeNull();

  const root = render(<DevTestBubble />);
  await waitFor(() => {
    expect(trigger.getByLabelText('Open device-test companion')).toBeTruthy();
  });

  // The module-level opener reaches the root bubble's sheet.
  await act(async () => {
    requestDevTestOpen();
  });
  await waitFor(() => {
    expect(root.getByText('Device tests')).toBeTruthy();
  });

  root.unmount();
  await waitFor(() => {
    expect(trigger.queryByLabelText('Open device-test companion')).toBeNull();
  });
});
