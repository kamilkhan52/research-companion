import { renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { TopBar } from '@/components/TopBar';

// U.21 — the TopBar title is the one single-line identity text in the app chrome; long paper
// titles must be readable (Marquee auto-scroll on overflow) rather than clipped.

const LONG = 'AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration';

test('the title renders through the marquee with an accessible label', async () => {
  await renderAsync(<TopBar title={LONG} subtitle="2023 · In discussion" />);
  expect(screen.getByText(LONG)).toBeTruthy();
  expect(screen.getByLabelText(LONG)).toBeTruthy();
  expect(screen.getByText('2023 · In discussion')).toBeTruthy();
});

test('a short title still renders (static path)', async () => {
  await renderAsync(<TopBar title="Map" />);
  expect(screen.getByText('Map')).toBeTruthy();
});

test('floating mode removes the divider and gives the identity its own capsule', async () => {
  await renderAsync(<TopBar title="A paper" subtitle="2026 · In discussion" floating />);

  expect(StyleSheet.flatten(screen.getByTestId('top-bar-floating').props.style)).toMatchObject({
    borderBottomWidth: 0,
  });
  expect(StyleSheet.flatten(screen.getByTestId('top-bar-center').props.style)).toMatchObject({
    borderWidth: 1,
    borderRadius: 999,
  });
});
