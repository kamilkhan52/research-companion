import { useCallback, useEffect, useState } from 'react';
import {
  TextInput,
  type TextInputProps,
} from 'react-native';

const MIN_HEIGHT = 34;
const MAX_HEIGHT = 120;

export interface GrowingComposerProps {
  text?: string;
  textInputProps?: Partial<TextInputProps>;
}

/** Native multiline composer that grows to four-ish lines, then scrolls internally.
 *
 * The chat package's Composer wraps its TextInput in a `flex: 1` View. On Android that
 * wrapper keeps the toolbar at its original single-line height even when a controlled height
 * is supplied through `textInputProps`. Rendering the native input directly lets its measured
 * content height participate in the toolbar's cross-axis layout.
 */
export function GrowingComposer({ text = '', textInputProps }: GrowingComposerProps) {
  const [height, setHeight] = useState(MIN_HEIGHT);
  const {
    style,
    onContentSizeChange,
    scrollEnabled: _scrollEnabled,
    ...inputProps
  } = textInputProps ?? {};

  useEffect(() => {
    if (!text) setHeight(MIN_HEIGHT);
  }, [text]);

  const handleContentSizeChange = useCallback<
    NonNullable<TextInputProps['onContentSizeChange']>
  >((event) => {
    const measured = event.nativeEvent.contentSize.height;
    setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, measured)));
    onContentSizeChange?.(event);
  }, [onContentSizeChange]);

  const placeholder = inputProps.placeholder ?? 'Reply';
  return (
    <TextInput
      {...inputProps}
      testID={inputProps.testID ?? placeholder}
      accessibilityLabel={inputProps.accessibilityLabel ?? placeholder}
      value={text}
      multiline
      scrollEnabled={height >= MAX_HEIGHT}
      enablesReturnKeyAutomatically
      underlineColorAndroid="transparent"
      onContentSizeChange={handleContentSizeChange}
      style={[style, { height }]}
    />
  );
}
