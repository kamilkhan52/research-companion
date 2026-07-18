import { act, fireEvent, renderAsync, screen } from '@testing-library/react-native';

import { BottomSheet } from '@/components/BottomSheet';
import { Text } from '@/ui';

test('controlled visibility presents and dismisses sheet content', async () => {
  const onClose = jest.fn();
  const view = await renderAsync(
    <BottomSheet visible={false} onClose={onClose}>
      <Text>Sheet content</Text>
    </BottomSheet>,
  );
  expect(screen.queryByText('Sheet content')).toBeNull();

  await view.rerenderAsync(
    <BottomSheet visible onClose={onClose}>
      <Text>Sheet content</Text>
    </BottomSheet>,
  );
  expect(screen.getByText('Sheet content')).toBeTruthy();

  await view.rerenderAsync(
    <BottomSheet visible={false} onClose={onClose}>
      <Text>Sheet content</Text>
    </BottomSheet>,
  );
  expect(screen.queryByText('Sheet content')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

test('gesture/backdrop dismissal updates the controlled owner', async () => {
  const onClose = jest.fn();
  await renderAsync(
    <BottomSheet visible onClose={onClose}>
      <Text>Sheet content</Text>
    </BottomSheet>,
  );

  fireEvent.press(screen.getByLabelText('Dismiss test bottom sheet'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('a reopen during an owner-driven close survives the stale dismiss callback', async () => {
  const mock = require('@gorhom/bottom-sheet') as {
    __setDeferDismiss: (value: boolean) => void;
    __flushDismisses: () => void;
  };
  mock.__setDeferDismiss(true);
  const onClose = jest.fn();
  const view = await renderAsync(
    <BottomSheet visible onClose={onClose}>
      <Text>Sheet content</Text>
    </BottomSheet>,
  );

  await view.rerenderAsync(
    <BottomSheet visible={false} onClose={onClose}>
      <Text>Sheet content</Text>
    </BottomSheet>,
  );
  await view.rerenderAsync(
    <BottomSheet visible onClose={onClose}>
      <Text>Sheet content</Text>
    </BottomSheet>,
  );
  await act(async () => mock.__flushDismisses());

  expect(screen.getByText('Sheet content')).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  mock.__setDeferDismiss(false);
});
