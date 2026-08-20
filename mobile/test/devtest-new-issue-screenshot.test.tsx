// DR-088 — Kamil: "I should be able to attach screenshots when creating an issue", and a
// screenshot alone must be a valid remark. Needing a follow-up remark (with a required
// comment) for the screenshot is what produced accidental Pass verdicts on new issues.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { ItemCard, NewItemForm } from '@/components/DevTestBubble';
import type { DevTestItem } from '@/api/endpoints';

jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));

jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn().mockResolvedValue({ items: [] }),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn(),
  createDevTestItem: jest.fn().mockResolvedValue({
    item: {
      id: 'NEW-1', title: 'Fetch fails', state: 'new — untriaged',
      raised: '2026-08-20', how_to_test: '', feedback_count: 0,
    },
  }),
}));

import * as api from '@/api/endpoints';

const ITEM: DevTestItem = {
  id: 'DR-087', state: 'open', raised: '2026-08-20',
  title: 'Fetch fails on html links', how_to_test: '', feedback_count: 0,
};

test('a new issue sends the captured screen when attach is checked', async () => {
  const onDone = jest.fn();
  const { getByPlaceholderText, getByLabelText, getByText } = render(
    <NewItemForm shot="B64SHOT" route="/paper/x" onDone={onDone} />,
  );
  fireEvent.changeText(getByPlaceholderText("What's wrong / what's the idea?"), 'Fetch fails');
  fireEvent.press(getByLabelText('Attach the captured screen to this issue'));
  fireEvent.press(getByText('Create'));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(api.createDevTestItem).toHaveBeenCalledWith('Fetch fails', undefined, {
    screenshot_b64: 'B64SHOT',
    route: '/paper/x',
  });
});

test('a new issue without the toggle checked sends no screenshot', async () => {
  const onDone = jest.fn();
  const { getByPlaceholderText, getByText } = render(
    <NewItemForm shot="B64SHOT" route="/paper/x" onDone={onDone} />,
  );
  fireEvent.changeText(getByPlaceholderText("What's wrong / what's the idea?"), 'No shot');
  fireEvent.press(getByText('Create'));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(api.createDevTestItem).toHaveBeenCalledWith('No shot', undefined, undefined);
});

test('a screenshot alone is a valid remark once attached', async () => {
  const { getByText, getByLabelText, findByText } = render(
    <ItemCard item={ITEM} shot="B64SHOT" route="/paper/x" startExpanded />,
  );
  await findByText('Remark');
  // Attach the captured screen, leave the comment empty.
  fireEvent.press(getByText('Attach the captured screen'));
  fireEvent.press(getByText('Remark'));
  await waitFor(() =>
    expect(api.recordDevTestFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'remark', screenshot_b64: 'B64SHOT' }),
    ),
  );
});

test('a remark with neither comment nor screenshot is refused client-side', async () => {
  jest.mocked(api.recordDevTestFeedback).mockClear();
  const { getByText, findByText } = render(
    <ItemCard item={ITEM} shot={null} route="/paper/x" startExpanded />,
  );
  await findByText('Remark');
  fireEvent.press(getByText('Remark'));
  await new Promise((r) => setTimeout(r, 50));
  expect(api.recordDevTestFeedback).not.toHaveBeenCalled();
});
