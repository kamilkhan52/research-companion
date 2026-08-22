import { fireEvent, renderAsync, screen } from '@testing-library/react-native';

import { OptionsSheet } from '@/components/chat/OptionsSheet';

test('a parent choice can reveal nested options without closing the menu', async () => {
  const onClose = jest.fn();
  const reveal = jest.fn();
  await renderAsync(
    <OptionsSheet
      visible
      onClose={onClose}
      title="Sort papers"
      options={[
        {
          key: 'date',
          title: 'Publication date',
          icon: 'calendar',
          closeOnPress: false,
          onPress: reveal,
        },
      ]}
    />,
  );

  fireEvent.press(screen.getByText('Publication date'));
  expect(reveal).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

test('a final choice closes the menu', async () => {
  const onClose = jest.fn();
  const choose = jest.fn();
  await renderAsync(
    <OptionsSheet
      visible
      onClose={onClose}
      options={[
        {
          key: 'oldest',
          title: 'Oldest first',
          icon: 'arrow-up',
          level: 1,
          onPress: choose,
        },
      ]}
    />,
  );

  fireEvent.press(screen.getByText('Oldest first'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(choose).toHaveBeenCalledTimes(1);
});

// DR-043 (Kamil, 2026-08-22): "showing nothing instead of some progress indicator or
// generation is not acceptable" — a disabled row must explain itself when tapped, not
// swallow the tap. The hint renders IN the sheet (a toast would paint under this native
// Modal's own window — the DR-078 lesson).
test('tapping a disabled row with a hint shows the reason and neither fires nor closes', async () => {
  const onClose = jest.fn();
  const action = jest.fn();
  await renderAsync(
    <OptionsSheet
      visible
      onClose={onClose}
      options={[
        {
          key: 'update-notes',
          title: 'Update Paper Notes from discussion',
          icon: 'edit-3',
          disabled: true,
          disabledHint: 'Wait for the current response to finish.',
          onPress: action,
        },
      ]}
    />,
  );

  expect(screen.queryByText('Wait for the current response to finish.')).toBeNull();
  fireEvent.press(screen.getByText('Update Paper Notes from discussion'));
  expect(screen.getByText('Wait for the current response to finish.')).toBeTruthy();
  expect(action).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test('a disabled row without a hint still swallows the tap (unchanged contract)', async () => {
  const onClose = jest.fn();
  const action = jest.fn();
  await renderAsync(
    <OptionsSheet
      visible
      onClose={onClose}
      options={[
        { key: 'x', title: 'Disabled row', icon: 'zap', disabled: true, onPress: action },
      ]}
    />,
  );

  fireEvent.press(screen.getByText('Disabled row'));
  expect(action).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
