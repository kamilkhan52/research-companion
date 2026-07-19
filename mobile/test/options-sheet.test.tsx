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
