import { renderAsync, screen } from '@testing-library/react-native';

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
