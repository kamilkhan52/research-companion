import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import { GeneratingBar, prepLabel } from '@/components/NarrationTranscript';

// U.23 — the audio-preparation UI is the "sound coming to life" card (Figma node 64:157):
// warm stage copy, eq-bar motif, a real percent once synthesis reports segment progress,
// and the U.4 cancel affordance.

describe('prepLabel', () => {
  test('stages read warm, not mechanical', () => {
    expect(prepLabel('starting', 0, 0)).toBe('Warming up…');
    expect(prepLabel('narrating', 0, 0)).toBe('Adapting for listening…');
    expect(prepLabel('synthesizing', 2, 7)).toBe('Weaving the audio — 3 of 7');
    expect(prepLabel('synthesizing', 0, 1)).toBe('Weaving the audio…');
  });

  test('the segment counter never overshoots the total', () => {
    expect(prepLabel('synthesizing', 7, 7)).toBe('Weaving the audio — 7 of 7');
  });
});

describe('GeneratingBar', () => {
  test('determinate synthesis shows copy and a percent counter', async () => {
    await renderAsync(<GeneratingBar stage="synthesizing" done={3} total={7} />);
    expect(screen.getByText('Weaving the audio — 4 of 7')).toBeTruthy();
    expect(screen.getByText('43%')).toBeTruthy();
  });

  test('indeterminate narrating shows no counter', async () => {
    await renderAsync(<GeneratingBar stage="narrating" />);
    expect(screen.getByText('Adapting for listening…')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  test('cancel affordance fires (U.4)', async () => {
    const onCancel = jest.fn();
    await renderAsync(<GeneratingBar stage="starting" onCancel={onCancel} />);
    await fireEventAsync.press(screen.getByLabelText('Cancel audio preparation'));
    expect(onCancel).toHaveBeenCalled();
  });
});
