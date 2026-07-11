// SelectTextSheet: the reliable text-selection surface a long-press on an assistant answer
// opens. Verifies it shows the answer text, that the Copy/Quote actions target the whole text
// by default and the highlighted range once a selection exists, and that Quote is hidden when
// there's no composer to quote into.

import { fireEvent, render, screen } from '@testing-library/react-native';

import { SelectTextSheet } from '@/components/chat/SelectTextSheet';

const TEXT = 'Alpha beta gamma delta.';

function selectRange(start: number, end: number) {
  fireEvent(screen.getByDisplayValue(TEXT), 'selectionChange', {
    nativeEvent: { selection: { start, end } },
  });
}

test('defaults to whole-text scope; Quote passes the full text', () => {
  const onQuote = jest.fn();
  render(<SelectTextSheet visible text={TEXT} onClose={() => {}} onQuote={onQuote} />);
  expect(screen.getByText('Copy all')).toBeTruthy();
  fireEvent.press(screen.getByText('Quote all'));
  expect(onQuote).toHaveBeenCalledWith(TEXT);
});

test('a highlighted range switches scope and Quote passes just that substring', () => {
  const onQuote = jest.fn();
  render(<SelectTextSheet visible text={TEXT} onClose={() => {}} onQuote={onQuote} />);
  selectRange(6, 10); // "beta"
  expect(screen.getByText('Quote selection')).toBeTruthy();
  expect(screen.getByText('Copy selection')).toBeTruthy();
  fireEvent.press(screen.getByText('Quote selection'));
  expect(onQuote).toHaveBeenCalledWith('beta');
});

test('reopening on a different answer clears the prior selection', () => {
  const onQuote = jest.fn();
  const { rerender } = render(
    <SelectTextSheet visible text={TEXT} onClose={() => {}} onQuote={onQuote} />,
  );
  selectRange(6, 10); // "beta"
  expect(screen.getByText('Quote selection')).toBeTruthy();
  // The sheet stays mounted; the parent reuses it for a different answer.
  const OTHER = 'A completely different response.';
  rerender(<SelectTextSheet visible text={OTHER} onClose={() => {}} onQuote={onQuote} />);
  expect(screen.getByText('Quote all')).toBeTruthy();
  fireEvent.press(screen.getByText('Quote all'));
  expect(onQuote).toHaveBeenCalledWith(OTHER);
});

test('no onQuote (committed session) hides the Quote action, keeps Copy', () => {
  render(<SelectTextSheet visible text={TEXT} onClose={() => {}} />);
  expect(screen.getByText('Copy all')).toBeTruthy();
  expect(screen.queryByText('Quote all')).toBeNull();
});
