import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { Markdown } from '@/components/Markdown';

test('renders inline links and routes taps to the handler with href + label', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <Markdown
      text={'It builds on [the Transformer](rc-paper:transformer) and **bold** stays bold.'}
      onLinkPress={onLinkPress}
    />,
  );

  // Emphasis still parses around the link.
  expect(screen.getByText('bold')).toBeTruthy();

  // Paper refs render a leading paper glyph before the name, so match on a substring.
  await fireEventAsync.press(screen.getByText(/the Transformer/));
  expect(onLinkPress).toHaveBeenCalledWith('rc-paper:transformer', 'the Transformer');
});

test('an external link passes its URL through to the handler', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <Markdown text={'See [GPT-4](https://arxiv.org/abs/2303.08774) for details.'} onLinkPress={onLinkPress} />,
  );
  await fireEventAsync.press(screen.getByText('GPT-4'));
  expect(onLinkPress).toHaveBeenCalledWith('https://arxiv.org/abs/2303.08774', 'GPT-4');
});

// DR-054 — a citation the model has no sourceable URL for arrives as `rc-search:<title>`
// instead of being left as dead unlinked text.

test('an rc-search link (name with no known URL) is tappable, passes through the marker, and renders distinctly from a plain external link', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <Markdown
      text={'This is compared against [LoongServe](rc-search:LoongServe) in the paper.'}
      onLinkPress={onLinkPress}
    />,
  );
  const node = screen.getByText(/LoongServe/);
  await fireEventAsync.press(node);
  expect(onLinkPress).toHaveBeenCalledWith('rc-search:LoongServe', 'LoongServe');
  // Opus review, PR #377: this test passed unmodified against the OLD generic-link rendering
  // too (dispatch was already correct pre-DR-054) — the underline distinguishes the new
  // dedicated branch from the plain-external-link fallback it would otherwise be
  // indistinguishable from.
  expect(StyleSheet.flatten(node.props.style).textDecorationLine).not.toBe('underline');
});

test('the malformed-link repair also catches an rc-search target written inside the brackets', async () => {
  // Same model malformation MALFORMED_LINK_RE already fixes for rc-paper: and https:.
  const onLinkPress = jest.fn();
  await renderAsync(
    <Markdown text={'[LoongServe (rc-search:LoongServe)] handles this differently.'} onLinkPress={onLinkPress} />,
  );
  await fireEventAsync.press(screen.getByText(/LoongServe/));
  expect(onLinkPress).toHaveBeenCalledWith('rc-search:LoongServe', 'LoongServe');
});

// Opus review, PR #377: a model that forgets to percent-encode a multi-word title used to
// silently break the link entirely — the href's `[^)\s]+` stops at the first space, so the
// unencoded form never tokenized as a link at all and rendered as literal bracket/paren text.
test('an UNENCODED rc-search title (spaces, no percent-encoding) still parses as one link', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <Markdown
      text={'See [Efficient Memory Management for LLM Serving](rc-search:Efficient Memory Management for LLM Serving) for more.'}
      onLinkPress={onLinkPress}
    />,
  );
  expect(screen.queryByText(/^\[Efficient/)).toBeNull();
  await fireEventAsync.press(screen.getByText(/Efficient Memory Management/));
  expect(onLinkPress).toHaveBeenCalledWith(
    'rc-search:Efficient Memory Management for LLM Serving',
    'Efficient Memory Management for LLM Serving',
  );
});

// ---- app-wide paper awareness: exact-title linkification (PaperIndexContext) ----

import { PaperIndexContext } from '@/components/Markdown';

const PAPERS = [
  { title: 'DistServe: Disaggregating Prefill and Decoding', slug: 'distserve' },
  { title: 'Short', slug: 'short' }, // under the 12-char floor — must never linkify
];

test('an exact known paper title becomes a live rc-paper link', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <PaperIndexContext.Provider value={PAPERS}>
      <Markdown
        text={'This builds on DistServe: Disaggregating Prefill and Decoding directly.'}
        onLinkPress={onLinkPress}
      />
    </PaperIndexContext.Provider>,
  );
  await fireEventAsync.press(screen.getByText(/DistServe: Disaggregating Prefill and Decoding/));
  expect(onLinkPress).toHaveBeenCalledWith(
    'rc-paper:distserve',
    'DistServe: Disaggregating Prefill and Decoding',
  );
});

test('title matching is case-insensitive but never fuzzy or short', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <PaperIndexContext.Provider value={PAPERS}>
      <Markdown
        text={'distserve: disaggregating prefill and decoding matters; Short does not.'}
        onLinkPress={onLinkPress}
      />
    </PaperIndexContext.Provider>,
  );
  await fireEventAsync.press(screen.getByText(/distserve: disaggregating prefill and decoding/));
  expect(onLinkPress).toHaveBeenCalledWith(
    'rc-paper:distserve',
    'distserve: disaggregating prefill and decoding',
  );
  // 'Short' stayed plain prose inside the surrounding text run (no standalone link node).
  expect(screen.queryByText('Short')).toBeNull();
});

test('authored link labels are not re-linkified', async () => {
  const onLinkPress = jest.fn();
  await renderAsync(
    <PaperIndexContext.Provider value={PAPERS}>
      <Markdown
        text={'See [DistServe: Disaggregating Prefill and Decoding](https://example.com/pdf).'}
        onLinkPress={onLinkPress}
      />
    </PaperIndexContext.Provider>,
  );
  await fireEventAsync.press(screen.getByText('DistServe: Disaggregating Prefill and Decoding'));
  expect(onLinkPress).toHaveBeenCalledWith(
    'https://example.com/pdf',
    'DistServe: Disaggregating Prefill and Decoding',
  );
});
