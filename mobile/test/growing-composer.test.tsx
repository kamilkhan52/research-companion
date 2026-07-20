import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { GrowingComposer } from '@/components/chat/GrowingComposer';

test('grows with multiline content, caps at four-ish lines, and resets when cleared', () => {
  const onChangeText = jest.fn();
  const view = render(
    <GrowingComposer
      text="A growing draft"
      textInputProps={{ placeholder: 'Reply', onChangeText, style: { minHeight: 34 } }}
    />,
  );
  const input = screen.getByPlaceholderText('Reply');

  fireEvent(input, 'contentSizeChange', {
    nativeEvent: { contentSize: { width: 240, height: 76 } },
  });
  expect(StyleSheet.flatten(input.props.style).height).toBe(76);
  expect(input.props.scrollEnabled).toBe(false);

  fireEvent(input, 'contentSizeChange', {
    nativeEvent: { contentSize: { width: 240, height: 180 } },
  });
  expect(StyleSheet.flatten(input.props.style).height).toBe(120);
  expect(input.props.scrollEnabled).toBe(true);

  view.rerender(
    <GrowingComposer
      text=""
      textInputProps={{ placeholder: 'Reply', onChangeText, style: { minHeight: 34 } }}
    />,
  );
  expect(StyleSheet.flatten(screen.getByPlaceholderText('Reply').props.style).height).toBe(34);
});
