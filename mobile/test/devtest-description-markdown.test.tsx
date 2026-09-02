// DR-120 — Kamil, 2026-09-02, reading a DevTest item's description on his phone: "The title
// reads fine but the description seems like an unformatted plain text jumble with links etc not
// formatted. Please look into that so it's nicely formatted."
//
// That description is a ledger EVIDENCE cell, the densest markdown in the file: bold, PR links,
// backticked paths. It was the one body of text in the card rendered as raw `<Text>` — an agent
// reply three elements below it already went through `<Markdown>`.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { markdownToPlain } from '@/lib/markdownPlain';
import { DevTestBubble } from '@/components/DevTestBubble';
import type { DevTestItem } from '@/api/endpoints';

jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));
jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn(),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn().mockResolvedValue({ entries: [] }),
  createDevTestItem: jest.fn(),
}));

import * as api from '@/api/endpoints';

// A real evidence cell's shape, shortened: bold, a PR link, a backticked path.
const EVIDENCE =
  '**Shipped in [#471](https://github.com/kamilkhan52/research-companion/pull/471)**, in two '
  + 'halves. Server (`app/routers/devtest.py`): `/api/devtest/items` now carries `last_activity`.';

const ITEMS: DevTestItem[] = [
  { id: 'DR-A', state: 'open', raised: '2026-09-02', title: 'Alpha thing',
    how_to_test: EVIDENCE, feedback_count: 0 },
];

beforeEach(() => jest.clearAllMocks());

async function openCard() {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());
  fireEvent.press(screen.getByLabelText(/DR-A.*Tap to leave a pass/i));
  return screen;
}

test('the collapsed preview shows the prose, not the syntax', async () => {
  const screen = await openCard();
  // The first thing he sees. `**`, the URL and the backticks are all gone; the words are not.
  screen.getByText(/^Shipped in #471, in two halves\./);
  expect(screen.queryByText(/\*\*Shipped in/)).toBeNull();
  expect(screen.queryByText(/github\.com/)).toBeNull();
});

test('expanding renders the description through Markdown, not as raw text', async () => {
  const screen = await openCard();
  fireEvent.press(screen.getByTestId('devtest-item-details'));
  // Markdown splits the cell into styled runs, so the raw source no longer appears as one
  // string anywhere — while the link's LABEL, which the raw render showed in brackets with its
  // URL trailing, is now its own tappable run.
  expect(screen.queryByText(EVIDENCE)).toBeNull();
  screen.getByTestId('devtest-item-details-body');
  screen.getByText('#471');
  screen.getByText('app/routers/devtest.py');
});

test('the expanded description is not wrapped in the toggle, so its links stay tappable', async () => {
  // The reason the toggle became its own small "Hide details" row: a Pressable ancestor
  // swallows the taps on the links `<Markdown>` just made tappable, which would have shipped a
  // formatted description whose links did nothing.
  const screen = await openCard();
  fireEvent.press(screen.getByTestId('devtest-item-details'));
  const body = screen.getByTestId('devtest-item-details-body');
  const toggle = screen.getByTestId('devtest-item-details');
  const hasAncestor = (node: typeof body, target: typeof toggle) => {
    for (let n = node.parent; n; n = n.parent) if (n === target) return true;
    return false;
  };
  expect(hasAncestor(body, toggle)).toBe(false);
});

test('a card with no description shows no toggle at all', async () => {
  jest.mocked(api.getDevTestItems).mockResolvedValue({
    items: [{ ...ITEMS[0], how_to_test: '' }],
  });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());
  fireEvent.press(screen.getByLabelText(/DR-A.*Tap to leave a pass/i));
  expect(screen.queryByTestId('devtest-item-details')).toBeNull();
});

// ---------- the stripper itself ----------

test('markdownToPlain keeps the words and drops the syntax', () => {
  expect(markdownToPlain('**bold** and *italic* and `code`')).toBe('bold and italic and code');
  expect(markdownToPlain('see [#471](https://example.com/pull/471) for it'))
    .toBe('see #471 for it');
  expect(markdownToPlain('![a figure](shot.png) follows')).toBe('a figure follows');
  expect(markdownToPlain('## Heading\n\ntext')).toBe('Heading text');
  expect(markdownToPlain('> quoted\n> lines')).toBe('quoted lines');
  expect(markdownToPlain('- one\n- two\n\n1. three')).toBe('one two three');
  expect(markdownToPlain('a <https://example.com> link')).toBe('a https://example.com link');
});

test('markdownToPlain leaves the identifiers this ledger is full of alone', () => {
  // The reason underscore emphasis is bounded rather than global: `how_to_test`, `_ROW_RE` and
  // `last_activity_kind` are ordinary words in these cells, and a naive `_…_` strip mangles them
  // into `howto_test`-shaped nonsense exactly where he is trying to read a field name.
  expect(markdownToPlain('the how_to_test field and _ROW_RE and last_activity_kind'))
    .toBe('the how_to_test field and _ROW_RE and last_activity_kind');
  // Genuine underscore emphasis, standing alone, still goes.
  expect(markdownToPlain('this is _emphatic_ prose')).toBe('this is emphatic prose');
});

test('markdownToPlain leaves maths as written', () => {
  // A half-stripped equation reads worse than its source, and `Markdown.tsx` renders these via
  // MathView rather than as text anyway.
  expect(markdownToPlain('the bound \\(O(n \\log n)\\) holds'))
    .toBe('the bound \\(O(n \\log n)\\) holds');
});

test('markdownToPlain is total on the shapes that break naive strippers', () => {
  expect(markdownToPlain('')).toBe('');
  expect(markdownToPlain('an *unclosed emphasis run')).toBe('an *unclosed emphasis run');
  expect(markdownToPlain('a `dangling backtick')).toBe('a `dangling backtick');
  expect(markdownToPlain('[label with no target]')).toBe('[label with no target]');
  expect(markdownToPlain('```\ncode\n```')).toBe('code');
});
