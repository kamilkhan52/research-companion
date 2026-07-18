// Render-time figure resolution (R.10). The canonical response text is the durable record of
// which figures a turn references ("Figure 3 shows…"); we resolve cards against the paper's
// CURRENT manifest at render time, so a manifest that lands after a turn was written still
// cards that older turn on the next render. Pure + deterministic — unit-tested, no imports
// from React or the network.

import type { PaperFigure } from '@/api/types';

// "Figure 3", "Fig. 3", "Fig 3a" (subfigure letter → parent), and plural clauses like
// "Figures 2 and 3", "Figs. 1, 2 and 4", "Figures 1–2". The prefix matches Fig/Figs/Figure/
// Figures with an optional dot; the trailing group is a number-list the caller mines for
// every integer it contains. \b keeps "configure"/"figment" from matching.
const FIGURE_RE =
  /\bFig(?:ure)?s?\.?\s*(\d+[a-z]?(?:\s*(?:,|&|and|to|–|—|-)\s*\d+[a-z]?)*)/gi;

/** Figure numbers referenced in a run of text, in first-appearance order, de-duplicated.
 *  A subfigure letter ("3a") resolves to its parent number (3); a plural/range clause yields
 *  each explicit integer in it ("2 and 3" → [2, 3]). */
export function figureNumbersInText(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  FIGURE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIGURE_RE.exec(text)) !== null) {
    for (const raw of m[1].match(/\d+/g) ?? []) {
      const n = parseInt(raw, 10);
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}

/** Given each block's plain text (null for non-paragraph blocks) and the paper's manifest
 *  figures, decide which figures to card after which block: a figure is carded after the
 *  FIRST block whose text references its number, at most once per message (first mention
 *  wins). Figures never mentioned in the text are not carded; a mentioned number with no
 *  matching manifest figure is skipped. Returns one PaperFigure[] per input block. */
export function planFigurePlacement(
  blockTexts: (string | null)[],
  figures: PaperFigure[],
): PaperFigure[][] {
  const byNumber = new Map<number, PaperFigure>();
  for (const fig of figures) {
    if (fig.number != null && !byNumber.has(fig.number)) byNumber.set(fig.number, fig);
  }
  const carded = new Set<number>();
  return blockTexts.map((text) => {
    if (!text || byNumber.size === carded.size) return [];
    const cards: PaperFigure[] = [];
    for (const n of figureNumbersInText(text)) {
      if (carded.has(n)) continue;
      const fig = byNumber.get(n);
      if (fig) {
        carded.add(n);
        cards.push(fig);
      }
    }
    return cards;
  });
}
