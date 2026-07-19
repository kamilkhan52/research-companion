import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ThemeProvider } from '@/theme/ThemeProvider';
import { Card, Text } from '@/ui';

async function renderProbe(density?: 'comfortable' | 'tight') {
  if (density) await AsyncStorage.setItem('rc.layoutDensity', density);
  await renderAsync(
    <ThemeProvider>
      <Card testID="card">
        <Text>Body copy</Text>
        <Text variant="serifTitle">A Long Paper Title</Text>
      </Card>
    </ThemeProvider>,
  );
}

test('Comfortable preserves the original shared reading rhythm', async () => {
  await renderProbe();

  expect(StyleSheet.flatten(screen.getByText('Body copy').props.style)).toMatchObject({
    fontSize: 15.5,
    lineHeight: 24,
  });
  expect(StyleSheet.flatten(screen.getByText('A Long Paper Title').props.style)).toMatchObject({
    fontSize: 20,
    lineHeight: 26,
  });
  expect(StyleSheet.flatten(screen.getByTestId('card').props.style)).toMatchObject({
    padding: 16,
  });
});

test('Tight reduces common type and card rhythm by the Figma-approved values', async () => {
  await renderProbe('tight');

  expect(StyleSheet.flatten(screen.getByText('Body copy').props.style)).toMatchObject({
    fontSize: 14,
    lineHeight: 21,
  });
  expect(StyleSheet.flatten(screen.getByText('A Long Paper Title').props.style)).toMatchObject({
    fontSize: 18,
    lineHeight: 23,
  });
  expect(StyleSheet.flatten(screen.getByTestId('card').props.style)).toMatchObject({
    padding: 12,
  });
});
