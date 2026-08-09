import { figureNumbersInText, planFigurePlacement } from '@/lib/figures';
import type { PaperFigure } from '@/api/types';

const fig = (number: number | null, id = `f${number}`): PaperFigure => ({
  id,
  number,
  caption: `Figure ${number}: a caption.`,
  alt: '',
  src: `https://arxiv.org/html/x/fig${number}.png`,
  asset: `0${number}-F${number}.png`,
});

describe('figureNumbersInText', () => {
  test('matches Figure/Fig./Fig N forms', () => {
    expect(figureNumbersInText('As Figure 3 shows, and Fig. 5, plus Fig 7.')).toEqual([3, 5, 7]);
  });

  test('a subfigure letter resolves to its parent number', () => {
    expect(figureNumbersInText('see Fig 3a and Figure 4b')).toEqual([3, 4]);
  });

  test('plural and range clauses yield each explicit number', () => {
    expect(figureNumbersInText('Figures 2 and 3 compare; Figs. 5, 6 and 8; Figures 1–2.')).toEqual(
      [2, 3, 5, 6, 8, 1],
    );
  });

  test('de-duplicates within a run, first appearance order', () => {
    expect(figureNumbersInText('Figure 3 … later Figure 3 again … then Figure 1')).toEqual([3, 1]);
  });

  test('does not match figure-like words', () => {
    expect(figureNumbersInText('we configure 3 nodes; a figment of 4')).toEqual([]);
  });
});

describe('planFigurePlacement', () => {
  test('attaches a figure to the first block that mentions it', () => {
    const texts = ['Intro with no figures.', 'Now Figure 1 shows the setup.', 'And Figure 2 later.'];
    const plan = planFigurePlacement(texts, [fig(1), fig(2)]);
    expect(plan[0]).toEqual([]);
    expect(plan[1].map((f) => f.number)).toEqual([1]);
    expect(plan[2].map((f) => f.number)).toEqual([2]);
  });

  test('at most one card per figure per message (first mention wins)', () => {
    const texts = ['Figure 1 here.', 'Figure 1 again here.'];
    const plan = planFigurePlacement(texts, [fig(1)]);
    expect(plan[0].map((f) => f.number)).toEqual([1]);
    expect(plan[1]).toEqual([]);
  });

  test('null (non-paragraph) blocks never carry cards', () => {
    const plan = planFigurePlacement([null, 'Figure 1.'], [fig(1)]);
    expect(plan[0]).toEqual([]);
    expect(plan[1].map((f) => f.number)).toEqual([1]);
  });

  test('a mentioned number with no matching manifest figure is skipped', () => {
    const plan = planFigurePlacement(['Figure 9 is not in the manifest.'], [fig(1)]);
    expect(plan[0]).toEqual([]);
  });

  test('unreferenced manifest figures are never carded', () => {
    const plan = planFigurePlacement(['No figure mentions at all.'], [fig(1), fig(2)]);
    expect(plan).toEqual([[]]);
  });
});
