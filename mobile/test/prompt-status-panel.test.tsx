import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import type { PromptStatus } from '@/api/types';
import { PromptStatusPanel } from '@/components/PromptStatusPanel';

const status: PromptStatus = {
  key: 'analysis_system',
  label: 'Analysis system prompt',
  description: 'Governs analysis.',
  storage: 'override',
  scope: 'global',
  relative_path: 'Analysis/System.md',
  value: 'prompt body',
  placeholders: [],
  required_literals: ['###CANONICAL###'],
  is_overridden: true,
  managed: true,
  source: 'last_valid',
  effective_source: 'last_valid',
  path: '/Users/researcher/Vault/Prompts/Analysis/System.md',
  valid: false,
  error: 'Missing protocol literal ###CANONICAL###',
  modified_at: '2026-07-05T12:00:00+00:00',
  effective_hash: '0123456789abcdef',
};

test('shows exact prompt status and refreshes without exposing an editor', async () => {
  const onRefresh = jest.fn();
  await renderAsync(
    <PromptStatusPanel
      prompts={[status]}
      loading={false}
      error={false}
      refreshing={false}
      onRefresh={onRefresh}
    />,
  );

  expect(screen.getByText('/Users/researcher/Vault/Prompts/Analysis/System.md')).toBeTruthy();
  expect(screen.getByLabelText('Analysis system prompt: invalid')).toBeTruthy();
  expect(screen.getByText('Missing protocol literal ###CANONICAL###')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();

  await fireEventAsync.press(screen.getByRole('button', { name: 'Refresh prompt status' }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});
