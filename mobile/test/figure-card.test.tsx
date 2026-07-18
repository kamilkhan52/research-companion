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

describe('figure cards in the discussion', () => {
  test('cards the referenced figure after its paragraph', async () => {
    await renderAsync(
      <Markdown
        text={'The pipeline is complex.\n\nAs Figure 1 shows, the stages compose.'}
        figureContext={context([figure(1, 'Figure 1: the pipeline.')])}
      />,
    );
    expect(screen.getByText('Figure 1: the pipeline.')).toBeTruthy();
    expect(screen.getByText('from arXiv HTML')).toBeTruthy();
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
