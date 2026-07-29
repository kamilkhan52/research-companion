import { fireEvent, fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import type { ReadingMode } from '@/api/types';
import {
  PaperSummaryRetrySheet,
  type PaperSummaryRetryConfig,
} from '@/components/PaperSummaryRetrySheet';

const templates: Record<ReadingMode, string> = {
  balanced: 'Balanced opening',
  background: 'Background opening',
  technical: 'Technical opening',
  detailed: 'Detailed opening',
};

function render(onRetry = jest.fn<void, [PaperSummaryRetryConfig]>()) {
  return renderAsync(
    <PaperSummaryRetrySheet
      visible
      onClose={() => {}}
      currentPrompt={templates.balanced}
      templates={templates}
      currentMode="balanced"
      selectedModel={null}
      defaultModelLabel="Default Model"
      favorites={[{ id: 'provider/pro', label: 'Pro' }]}
      onRetry={onRetry}
    />,
  );
}

test('shows explanatory copy only for the selected prompt type', async () => {
  await render();

  expect(screen.getByText(/clear overview with context/)).toBeTruthy();
  expect(screen.queryByText(/Skip the basics/)).toBeNull();

  await fireEventAsync.press(screen.getByText('Technical'));

  expect(screen.queryByText(/clear overview with context/)).toBeNull();
  expect(screen.getByText(/Skip the basics/)).toBeTruthy();
});

test('keeps model choices tucked away until Change and sends the selected preset', async () => {
  const onRetry = jest.fn<void, [PaperSummaryRetryConfig]>();
  await render(onRetry);

  expect(screen.queryByText('Project default')).toBeNull();
  await fireEventAsync.press(screen.getByLabelText(/Model for retried paper summary.*Change/));
  await fireEventAsync.press(screen.getByText('Pro'));
  await fireEventAsync.press(screen.getByText('Technical'));
  await fireEventAsync.press(screen.getByRole('button', { name: 'Retry paper summary' }));

  expect(onRetry).toHaveBeenCalledWith({
    prompt: templates.technical,
    mode: 'technical',
    model: 'provider/pro',
  });
});

test('custom retry exposes a keyboard-aware prompt field and uses balanced mode', async () => {
  const onRetry = jest.fn<void, [PaperSummaryRetryConfig]>();
  await render(onRetry);

  await fireEventAsync.press(screen.getByText('Customize prompt'));
  fireEvent.changeText(screen.getByLabelText('Custom opening prompt'), 'Start with the proof.');
  await fireEventAsync.press(screen.getByRole('button', { name: 'Retry paper summary' }));

  expect(onRetry).toHaveBeenCalledWith({
    prompt: 'Start with the proof.',
    mode: 'balanced',
    model: undefined,
  });
});
