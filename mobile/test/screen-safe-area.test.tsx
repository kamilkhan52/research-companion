import { renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Screen, Text } from '@/ui';

// U.16 — the discussion screen opened with its title behind the Android status bar until the
// messages loaded. Screen must take its inset padding from the provider synchronously (the
// hook), not from the library's native SafeAreaView, whose Android measurement can lag a
// freshly pushed react-native-screens screen by several layout passes.

const metrics = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 42, left: 0, right: 0, bottom: 24 },
};

function paddedNode(node: unknown): { paddingTop?: number; paddingBottom?: number } | null {
  if (node == null || typeof node !== 'object') return null;
  const n = node as { props?: { style?: unknown }; children?: unknown[] };
  const style = n.props?.style ? (StyleSheet.flatten(n.props.style) as Record<string, unknown>) : null;
  if (style && style.paddingTop !== undefined) return style as { paddingTop?: number };
  for (const child of n.children ?? []) {
    const found = paddedNode(child);
    if (found) return found;
  }
  return null;
}

test('Screen pads its very first frame with the provider insets', async () => {
  await renderAsync(
    <SafeAreaProvider initialMetrics={metrics}>
      <Screen edges={['top']}>
        <Text>content</Text>
      </Screen>
    </SafeAreaProvider>,
  );
  const style = paddedNode(screen.toJSON());
  expect(style?.paddingTop).toBe(42);
  // edges=['top'] must not also pad the bottom.
  expect(style?.paddingBottom).toBe(0);
});
