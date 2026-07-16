import { fireEvent, fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

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

const editable: PromptStatus = {
  ...status,
  key: 'discover_scoring',
  label: 'Discovery scoring',
  value: 'rank the papers',
  managed: false,
  valid: true,
  error: null,
  is_overridden: true,
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

test('tapping a prompt reveals its text; no editor when not editable', async () => {
  await renderAsync(
    <PromptStatusPanel
      prompts={[editable]}
      loading={false}
      error={false}
      refreshing={false}
      onRefresh={jest.fn()}
    />,
  );
  expect(screen.queryByText('rank the papers')).toBeNull();
  await fireEventAsync.press(screen.getByLabelText('Discovery scoring, expand'));
  expect(screen.getByText('rank the papers')).toBeTruthy();
  // Read-only surface: viewing shows content but never an Edit affordance or a textbox.
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('editable mode saves an edited prompt through onSave', async () => {
  const onSave = jest.fn(async () => undefined);
  await renderAsync(
    <PromptStatusPanel
      prompts={[editable]}
      loading={false}
      error={false}
      refreshing={false}
      onRefresh={jest.fn()}
      editable
      onSave={onSave}
      onReset={jest.fn()}
    />,
  );
  await fireEventAsync.press(screen.getByLabelText('Discovery scoring, expand'));
  await fireEventAsync.press(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.changeText(screen.getByDisplayValue('rank the papers'), 'rank harder');
  await fireEventAsync.press(screen.getByRole('button', { name: 'Save override' }));
  expect(onSave).toHaveBeenCalledWith('discover_scoring', 'rank harder');
});

test('a managed prompt is not editable even in editable mode', async () => {
  await renderAsync(
    <PromptStatusPanel
      prompts={[{ ...editable, managed: true }]}
      loading={false}
      error={false}
      refreshing={false}
      onRefresh={jest.fn()}
      editable
      onSave={jest.fn()}
    />,
  );
  await fireEventAsync.press(screen.getByLabelText('Discovery scoring, expand'));
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.getByText('Managed prompt — edit its Markdown file directly.')).toBeTruthy();
});
