import { renderAsync, screen } from '@testing-library/react-native';

import { Markdown, type FigureContext } from '@/components/Markdown';
import type { PaperFigure } from '@/api/types';

const figure = (number: number, caption: string): PaperFigure => ({
  id: `F${number}`,
  number,
  caption,
  alt: '',
  src: `https://arxiv.org/html/2401.00001v1/fig${number}.png`,
  asset: `0${number}-F${number}.png`,
});

const context = (figures: PaperFigure[]): FigureContext => ({
  pid: 'proj',
  slug: 'deepstack',
  figures,
  version: 1700000000,
});

/** Every string in the rendered tree, in render order. Position is the whole claim in DR-003, and
 *  `getByText` proves only presence — the old test passed with the card on either side. */
function renderedStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((child) => renderedStrings(child, out));
  else if (node && typeof node === 'object' && 'children' in node) {
    renderedStrings((node as { children: unknown }).children, out);
  }
  return out;
}

describe('figure cards in the discussion', () => {
  test('cards the referenced figure immediately BEFORE its paragraph (DR-003)', async () => {
    await renderAsync(
      <Markdown
        text={'The pipeline is complex.\n\nAs Figure 1 shows, the stages compose.'}
        figureContext={context([figure(1, 'Figure 1: the pipeline.')])}
      />,
    );
    expect(screen.getByText('Figure 1: the pipeline.')).toBeTruthy();
    expect(screen.getByText('from arXiv HTML')).toBeTruthy();

    const strings = renderedStrings(screen.toJSON());
    const caption = strings.findIndex((s) => s.includes('Figure 1: the pipeline.'));
    const mention = strings.findIndex((s) => s.includes('the stages compose'));
    const intro = strings.findIndex((s) => s.includes('The pipeline is complex'));
    expect(caption).toBeGreaterThan(intro);   // not hoisted to the top of the message
    expect(caption).toBeLessThan(mention);    // but ahead of the sentence that references it
  });

  test('an unreferenced figure is not carded', async () => {
    await renderAsync(
      <Markdown
        text={'No figures mentioned here at all.'}
        figureContext={context([figure(2, 'Figure 2: unseen.')])}
      />,
    );
    expect(screen.queryByText('Figure 2: unseen.')).toBeNull();
    expect(screen.queryByText('from arXiv HTML')).toBeNull();
  });

  test('without a figure context the text renders unchanged (no cards)', async () => {
    await renderAsync(<Markdown text={'As Figure 1 shows, the stages compose.'} />);
    expect(screen.queryByText('from arXiv HTML')).toBeNull();
    expect(screen.getByText(/Figure 1 shows/)).toBeTruthy();
  });
});

// DR-099 — the chat text renders without waiting for figures (the manifest is a separate
// query), and each card's reserved image box pulses as a skeleton until the bytes arrive.
describe('figure image skeleton (DR-099)', () => {
  const md = 'As Figure 1 shows, the stages compose.';

  test('the skeleton fills the reserved box until the image loads', async () => {
    const { fireEvent } = require('@testing-library/react-native');
    await renderAsync(
      <Markdown text={md} figureContext={context([figure(1, 'Figure 1: the pipeline.')])} />,
    );
    expect(screen.getByTestId('figure-skeleton')).toBeTruthy();
    fireEvent(screen.getByTestId('figure-image'), 'load', { nativeEvent: { source: { width: 476, height: 244 } } });
    expect(screen.queryByTestId('figure-skeleton')).toBeNull();
  });

  test('a failed image drops the whole box — no orphaned skeleton pulsing forever', async () => {
    const { fireEvent } = require('@testing-library/react-native');
    await renderAsync(
      <Markdown text={md} figureContext={context([figure(1, 'Figure 1: the pipeline.')])} />,
    );
    fireEvent(screen.getByTestId('figure-image'), 'error', { nativeEvent: { error: 'boom' } });
    expect(screen.queryByTestId('figure-skeleton')).toBeNull();
    expect(screen.queryByTestId('figure-image')).toBeNull();
    // The graceful degrade keeps caption + source link.
    expect(screen.getByText('Figure 1: the pipeline.')).toBeTruthy();
    expect(screen.getByText('from arXiv HTML')).toBeTruthy();
  });
});
