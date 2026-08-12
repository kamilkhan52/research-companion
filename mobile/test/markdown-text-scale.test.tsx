// DR-068 — Kamil: "using a font size... plus and minus signs besides current font size, and
// instant apply." `textScale` multiplies the density-resolved base fontSize/lineHeight; omitted
// (or 1) everywhere except the Discussion transcript, so notes/review surfaces render exactly
// as before — the existing markdown-rendering.test.tsx suite (no textScale prop) staying green
// unmodified is itself part of that guarantee.

import { renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { Markdown } from '@/components/Markdown';
import { InlineMath } from '@/components/MathView';

// Same convention as markdown-math.test.tsx: pin the deterministic plain-text fallback (SVG
// availability varies by environment) so the math-scaling assertions below are stable.
jest.mock('@/lib/math', () => ({
  ...jest.requireActual('@/lib/math'),
  getSvgXml: () => null,
}));

// Plain-text spans render as bare, unstyled RNText nested inside the styled `<Text variant=…>`
// that carries the actual fontSize (RN's own text-style inheritance, not reflected on the leaf
// node's own props) — walk up to the nearest ancestor whose OWN style actually sets fontSize.
function fontSize(text: string): number | undefined {
  let node: ReactTestInstance | null = screen.getByText(text);
  while (node) {
    const flat = StyleSheet.flatten(node.props.style) as { fontSize?: number };
    if (flat?.fontSize != null) return flat.fontSize;
    node = node.parent;
  }
  return undefined;
}

test('the default (no textScale prop) renders at the ordinary base size', async () => {
  await renderAsync(<Markdown text="A plain paragraph." />);
  // 17 is serifBody's Comfortable-density base (mobile/src/ui/index.tsx) — this pins the
  // baseline the scaled tests below multiply against.
  expect(fontSize('A plain paragraph.')).toBe(17);
});

test('textScale multiplies the paragraph, not just changes a flag', async () => {
  await renderAsync(<Markdown text="A scaled paragraph." textScale={1.2} />);
  expect(fontSize('A scaled paragraph.')).toBeCloseTo(17 * 1.2);
});

test('textScale=1 is indistinguishable from omitting the prop (no stray style object)', async () => {
  const { unmountAsync } = await renderAsync(<Markdown text="Same either way." textScale={1} />);
  expect(fontSize('Same either way.')).toBe(17);
  await unmountAsync();
});

test('headings scale too, each preserving its own relative size', async () => {
  await renderAsync(<Markdown text={'# Big heading\n\nBody.'} textScale={1.1} />);
  // Comfortable H1 base is 24 (Markdown.tsx HEADING_STYLES).
  expect(fontSize('Big heading')).toBeCloseTo(24 * 1.1);
});

test('list items scale', async () => {
  await renderAsync(<Markdown text={'- First point\n- Second point'} textScale={1.3} />);
  expect(fontSize('First point')).toBeCloseTo(17 * 1.3);
});

test('a blockquote scales using its own (serifItalic) base', async () => {
  await renderAsync(<Markdown text="> A quoted line." textScale={1.2} />);
  expect(fontSize('A quoted line.')).toBeCloseTo(17 * 1.2);
});

test('table cells scale', async () => {
  await renderAsync(
    <Markdown text={'| A | B |\n|---|---|\n| one | two |'} textScale={1.2} />,
  );
  expect(fontSize('one')).toBeCloseTo(17 * 1.2);
});

// Opus review, PR #385: a display-math block used to render at a fixed 17px regardless of
// textScale — at 1.4x, prose read at 23.8px next to a formula stuck at 16-17px, a visibly
// mismatched line for a paper-discussion app where equations are core content.
test('a display-math block scales with the surrounding prose', async () => {
  await renderAsync(
    <Markdown text={'\\[ s^* = \\arg\\min_{s} L(s) \\]'} textScale={1.4} />,
  );
  const block = screen.getByTestId('math-block');
  expect((StyleSheet.flatten(block.props.style) as { fontSize?: number }).fontSize)
    .toBeCloseTo(17 * 1.4);
});

// Inline math's SVG path sizes its own width/height off `fontSize` (an SVG has no text to
// inherit scaling through) — the jest fallback path (SVG forced off elsewhere in this suite)
// renders plain inherited text and can't distinguish the prop being wired from it being
// ignored, so this asserts the prop directly reaches InlineMath.
test('inline math is handed the scaled fontSize, not the bare default', async () => {
  const { UNSAFE_getByType } = await renderAsync(
    <Markdown text={'The value \\(x_i\\) is updated.'} textScale={1.3} />,
  );
  expect(UNSAFE_getByType(InlineMath).props.fontSize).toBeCloseTo(16 * 1.3);
});

test('fenced code blocks scale, matching the prose around them', async () => {
  await renderAsync(<Markdown text={'```\nconst x = 1;\n```'} textScale={1.3} />);
  expect(fontSize('const x = 1;')).toBeCloseTo(13 * 1.3);
});
