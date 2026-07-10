import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

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

  await fireEventAsync.press(screen.getByText('the Transformer'));
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
  await fireEventAsync.press(screen.getByText('DistServe: Disaggregating Prefill and Decoding'));
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
  await fireEventAsync.press(screen.getByText('distserve: disaggregating prefill and decoding'));
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
