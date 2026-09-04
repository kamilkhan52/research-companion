// DR-120 — Kamil, 2026-09-02, reading a DevTest item's description on his phone: "The title
// reads fine but the description seems like an unformatted plain text jumble with links etc not
// formatted. Please look into that so it's nicely formatted."
//
// That description is a ledger EVIDENCE cell, the densest markdown in the file: bold, PR links,
// backticked paths. It was the one body of text in the card rendered as raw `<Text>` — an agent
// reply three elements below it already went through `<Markdown>`.

import { StyleSheet } from 'react-native';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';

import { markdownToInlineSource, markdownToPlain, restoreEscapes } from '@/lib/markdownPlain';
import { fonts } from '@/theme/tokens';
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

test('markdownToPlain resolves the escapes a table cell is forced to write', () => {
  // A ledger row lives in a markdown TABLE, so a literal pipe must be escaped — and DR-116's
  // cell really does carry this. Left in, it is the same visible-syntax complaint DR-120 exists
  // to fix, on one of the freshest rows he opens.
  expect(markdownToPlain("guarded on `query.trim() \\|\\| filter !== 'all'` today"))
    .toBe("guarded on query.trim() || filter !== 'all' today");
  // The unescape runs LAST on purpose: earlier, `\*` would become a live emphasis marker and
  // the words on either side of it would be eaten.
  expect(markdownToPlain('a literal \\*asterisk\\* pair')).toBe('a literal *asterisk* pair');
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

// ---------- DR-128: the COLLAPSED half ----------
//
// Kamil, as a remark on DR-120: "When 'Show details' is pressed, it renders the markdown, but
// stays unrendered still when compacted (Hide details; default). Fix that and it should be all
// good." DR-120 fixed the half he has to open a card to see. The preview is clamped with
// `numberOfLines`, which only a single `<Text>` honours — but a `<Text>` NESTED inside that one
// clamps with it, so the inline faces fit inside the constraint after all. Block structure still
// flattens; three lines is not where a heading helps.

test('the collapsed preview renders the inline formatting, and still clamps to three lines', async () => {
  const screen = await openCard();
  const preview = screen.getByTestId('devtest-item-preview');
  // The constraint DR-120 shipped the flat version for. Losing it would be a worse regression
  // than the one being fixed: the whole evidence cell would push the verdict row off screen.
  expect(preview.props.numberOfLines).toBe(3);
  // Each of these is its OWN run now. Under DR-120's single flattened string an exact match on
  // any of them finds nothing, which is what makes this fail if the fix is taken back out.
  const code = within(preview).getByText('app/routers/devtest.py');
  expect(StyleSheet.flatten(code.props.style).fontFamily).toMatch(/Menlo|monospace/);
  const bold = within(preview).getByText('Shipped in #471');
  expect(StyleSheet.flatten(bold.props.style).fontFamily).toBe(fonts.bodyBold);
  const link = within(preview).getByText('#471');
  expect(StyleSheet.flatten(link.props.style).textDecorationLine).toBe('underline');
  // Formatted, not raw: the syntax and the URL are still gone, which was DR-120's own measure.
  expect(screen.queryByText(/\*\*Shipped in/)).toBeNull();
  expect(screen.queryByText(/github\.com/)).toBeNull();
});

test('the preview unparks its escapes, so no sentinel reaches the screen', async () => {
  // The escape parking has to survive inline TOKENIZING now, not just the stripping passes.
  // Unparked early, `\*` is a live emphasis marker again and eats the words on both sides of
  // it; left parked, a control character lands on his phone.
  jest.mocked(api.getDevTestItems).mockResolvedValue({
    items: [{ ...ITEMS[0], how_to_test: 'a literal \\*asterisk\\* pair and **real** bold' }],
  });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());
  fireEvent.press(screen.getByLabelText(/DR-A.*Tap to leave a pass/i));
  const preview = screen.getByTestId('devtest-item-preview');
  within(preview).getByText('a literal *asterisk* pair and ');
  expect(StyleSheet.flatten(within(preview).getByText('real').props.style).fontFamily)
    .toBe(fonts.bodyBold);
});

test('markdownToInlineSource flattens the blocks and leaves the inline syntax standing', () => {
  const src = (md: string) => restoreEscapes(markdownToInlineSource(md));
  expect(src('## Heading\n\n- **bold** and `code`')).toBe('Heading **bold** and `code`');
  // The link is the one construct the two readers part company over: the plain stripper drops
  // it here, this one keeps it whole for the tokenizer downstream.
  expect(src('see [#471](https://example.com/pull/471) for it'))
    .toBe('see [#471](https://example.com/pull/471) for it');
  // An image cannot be a text run under either reading; its alt text is all it can contribute.
  expect(src('![a figure](shot.png) follows')).toBe('a figure follows');
  expect(src('> quoted\n> lines')).toBe('quoted lines');
  expect(src('1. one\n2. two')).toBe('one two');
  expect(src('```\ncode\n```')).toBe('code');
  expect(src('a <https://example.com> link')).toBe('a https://example.com link');
  expect(src('')).toBe('');
  // Maths as written, same as the plain reader — a MathView is a View, and a View inside a
  // clamped Text is exactly what stops the clamp.
  expect(src('the bound \\(O(n \\log n)\\) holds')).toBe('the bound \\(O(n \\log n)\\) holds');
});

test('markdownToInlineSource parks its escapes for the tokenizer, not for the screen', () => {
  // Deliberately NOT a display string: the sentinel has to outlive inline tokenizing, so a
  // caller that renders this value directly puts control characters on the phone.
  const parked = markdownToInlineSource('a literal \\*asterisk\\* pair');
  expect(parked).toContain(String.fromCharCode(0));
  expect(restoreEscapes(parked)).toBe('a literal *asterisk* pair');
});
