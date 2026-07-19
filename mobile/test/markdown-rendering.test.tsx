import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import { Markdown, splitAnnotatableSentences } from '@/components/Markdown';
import { themes } from '@/theme/tokens';

// U.15 — rendering defects Kamil hit on device with a long analysis response (the AWQ
// briefing): glued headings, links inside bold spans, pipe tables, and ordered-list numbering.

describe('glued headings', () => {
  test('a heading with no space after the hashes still renders as a heading', async () => {
    await renderAsync(<Markdown text={'###AWQ: Adoption and Follow-ups\n\nBody text.'} />);
    expect(screen.getByText('AWQ: Adoption and Follow-ups')).toBeTruthy();
    expect(screen.queryByText(/###/)).toBeNull();
  });

  test('a single glued hash stays prose', async () => {
    await renderAsync(<Markdown text={'#include is not a heading.'} />);
    expect(screen.getByText('#include is not a heading.')).toBeTruthy();
  });

  test('glued hashes inside a fenced block keep their literal content', async () => {
    await renderAsync(<Markdown text={'```\n##define X\n```'} />);
    expect(screen.getByText('##define X')).toBeTruthy();
  });
});

describe('links inside emphasis', () => {
  test('a link inside a bold span is tappable, not literal bracket text', async () => {
    const onLinkPress = jest.fn();
    await renderAsync(
      <Markdown
        text={'**[SmoothQuant](https://arxiv.org/abs/2211.10438) (Xiao et al., ICML 2023)** was the precursor.'}
        onLinkPress={onLinkPress}
      />,
    );
    expect(screen.queryByText(/\[SmoothQuant\]/)).toBeNull();
    await fireEventAsync.press(screen.getByText('SmoothQuant'));
    expect(onLinkPress).toHaveBeenCalledWith('https://arxiv.org/abs/2211.10438', 'SmoothQuant');
    // The parenthetical after the link stays inside the bold span as text.
    expect(screen.getByText(/\(Xiao et al\., ICML 2023\)/)).toBeTruthy();
  });

  test('a link inside an italic span is tappable', async () => {
    const onLinkPress = jest.fn();
    await renderAsync(
      <Markdown text={'*see [KIVI](https://arxiv.org/abs/2402.02750) for details*'} onLinkPress={onLinkPress} />,
    );
    await fireEventAsync.press(screen.getByText('KIVI'));
    expect(onLinkPress).toHaveBeenCalledWith('https://arxiv.org/abs/2402.02750', 'KIVI');
  });

  test('plain bold text renders exactly as before', async () => {
    await renderAsync(<Markdown text={'**HuggingFace Transformers** ships AWQ.'} />);
    expect(screen.getByText('HuggingFace Transformers')).toBeTruthy();
  });
});

describe('pipe tables', () => {
  const table = [
    '| Work | Relevance to our project |',
    '|------|--------------------------|',
    '| [SmoothQuant](https://arxiv.org/abs/2211.10438) | Precursor to AWQ |',
    '| GPTQ | Primary alternative |',
  ].join('\n');

  test('a GFM table renders header and body cells, not paragraph soup', async () => {
    await renderAsync(<Markdown text={table} />);
    expect(screen.getByTestId('md-table')).toBeTruthy();
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.getByText('Relevance to our project')).toBeTruthy();
    expect(screen.getByText('Precursor to AWQ')).toBeTruthy();
    expect(screen.getByText('GPTQ')).toBeTruthy();
    expect(screen.queryByText(/------/)).toBeNull();
  });

  test('a link inside a table cell is tappable', async () => {
    const onLinkPress = jest.fn();
    await renderAsync(<Markdown text={table} onLinkPress={onLinkPress} />);
    await fireEventAsync.press(screen.getByText('SmoothQuant'));
    expect(onLinkPress).toHaveBeenCalledWith('https://arxiv.org/abs/2211.10438', 'SmoothQuant');
  });

  // U.15b (device) — a 2-column table could not be panned inside the inverted chat list;
  // narrow tables now fit the screen outright, and only wide ones scroll.
  test('a narrow table fits the screen instead of scrolling', async () => {
    await renderAsync(<Markdown text={table} />);
    expect(screen.getByTestId('md-table').props.horizontal).toBeUndefined();
  });

  test('a wide table pans horizontally, with nested scrolling enabled for Android', async () => {
    const wide = [
      '| A | B | C | D | E |',
      '|---|---|---|---|---|',
      '| one | two | three | four | five |',
    ].join('\n');
    await renderAsync(<Markdown text={wide} />);
    const scroller = screen.getByTestId('md-table');
    expect(scroller.props.horizontal).toBe(true);
    expect(scroller.props.nestedScrollEnabled).toBe(true);
    expect(screen.getByText('five')).toBeTruthy();
  });

  test('a prose line with a stray pipe is not a table', async () => {
    await renderAsync(<Markdown text={'either A | B works.\n\nNext paragraph.'} />);
    expect(screen.queryByTestId('md-table')).toBeNull();
    expect(screen.getByText('either A | B works.')).toBeTruthy();
  });
});

describe('ordered list numbering', () => {
  test('blank-line-separated numbered items keep their source numbers', async () => {
    const text = '1. First point, a full paragraph.\n\n2. Second point.\n\n3. Third point.';
    await renderAsync(<Markdown text={text} />);
    expect(screen.getByText('1.')).toBeTruthy();
    expect(screen.getByText('2.')).toBeTruthy();
    expect(screen.getByText('3.')).toBeTruthy();
  });

  test('lazy numbering (all "1.") auto-increments per CommonMark', async () => {
    const text = '1. alpha\n1. beta\n1. gamma';
    await renderAsync(<Markdown text={text} />);
    expect(screen.getByText('2.')).toBeTruthy();
    expect(screen.getByText('3.')).toBeTruthy();
  });

  test('explicit contiguous numbering is preserved', async () => {
    const text = '1. alpha\n2. beta\n3. gamma';
    await renderAsync(<Markdown text={text} />);
    expect(screen.getByText('1.')).toBeTruthy();
    expect(screen.getByText('2.')).toBeTruthy();
    expect(screen.getByText('3.')).toBeTruthy();
  });

  test('double-digit ordinals render in full', async () => {
    const text = '9. ninth\n10. tenth';
    await renderAsync(<Markdown text={text} />);
    expect(screen.getByText('10.')).toBeTruthy();
  });
});

describe('sentence annotation render path', () => {
  test('splits committed prose on the same tolerant sentence boundary as preview cues', () => {
    expect(splitAnnotatableSentences(
      'First claim. “Second claim?” Final fragment without punctuation',
    )).toEqual([
      'First claim.',
      '“Second claim?”',
      'Final fragment without punctuation',
    ]);
  });

  test('is fully opt-in for ordinary Markdown surfaces', async () => {
    await renderAsync(<Markdown text="First claim. Second claim." />);
    expect(screen.queryByTestId('md-sentence-0')).toBeNull();
  });

  test('renders tappable sentence spans with selected and annotated states', async () => {
    const onSentencePress = jest.fn();
    await renderAsync(
      <Markdown
        text="First claim. Second claim."
        sentenceAnnotations={{
          active: true,
          onSentencePress,
          stateForSentence: (quote) => (
            quote === 'Second claim.'
              ? { selected: true, annotated: true, commentCount: 2 }
              : undefined
          ),
        }}
      />,
    );

    await fireEventAsync.press(screen.getByTestId('md-sentence-1'));
    expect(onSentencePress).toHaveBeenCalledWith('Second claim.');
    expect(screen.getByLabelText('2 attached comments')).toBeTruthy();
    expect(screen.getByTestId('md-sentence-1')).toHaveStyle({
      backgroundColor: themes.dim.violetWash,
      borderLeftColor: themes.dim.violet,
      borderLeftWidth: 2,
      textDecorationColor: themes.dim.violet,
      textDecorationLine: 'underline',
    });
  });

  test('sentence tap wins over link navigation while annotation mode is active', async () => {
    const onSentencePress = jest.fn();
    const onLinkPress = jest.fn();
    await renderAsync(
      <Markdown
        text="[Linked paper](https://example.com) matters."
        onLinkPress={onLinkPress}
        sentenceAnnotations={{ active: true, onSentencePress }}
      />,
    );

    await fireEventAsync.press(screen.getByTestId('md-sentence-0'));
    expect(onSentencePress).toHaveBeenCalledWith('Linked paper matters.');
    expect(onLinkPress).not.toHaveBeenCalled();
  });
});
