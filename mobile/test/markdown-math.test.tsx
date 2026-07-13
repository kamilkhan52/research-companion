// Equation rendering + pseudo tool-tag cleanup in Markdown (polish plan G). SVG availability
// is forced off so these tests pin the fallback path (the pre-rebuild client's behavior);
// texToSvg itself is tested directly — MathJax is pure JS and runs under jest.

import { renderAsync, screen } from '@testing-library/react-native';

import { Markdown } from '@/components/Markdown';
import { fitMathBlock, texToPlain, texToSvg } from '@/lib/math';
import { stripPseudoToolTags } from '@/lib/toolTags';

jest.mock('@/lib/math', () => ({
  ...jest.requireActual('@/lib/math'),
  getSvgXml: () => null,
}));

test('display-math paragraphs render as a math block (fallback text)', async () => {
  await renderAsync(
    <Markdown text={'Equation follows.\n\n\\[ s^* = \\arg\\min_{s} L(s) \\]\n\nDone.'} />,
  );
  expect(screen.getByText(/s\* = arg\s?min/)).toBeTruthy();
  expect(screen.getByTestId('math-block')).toBeTruthy();
  expect(screen.queryByText(/\\arg/)).toBeNull();
});

test('standalone inline-delimited math in a quote is promoted to a scroll-capable block', async () => {
  await renderAsync(
    <Markdown text={'> \\(Q(w \\cdot s) \\cdot \\frac{x}{s} = \\Delta \\cdot \\operatorname{Round}(w)\\)'} />,
  );
  expect(screen.getByTestId('math-block')).toBeTruthy();
  expect(screen.queryByTestId('inline-math')).toBeNull();
});

test('multiple quoted equation lines each become a math block', async () => {
  await renderAsync(<Markdown text={'> \\(a = b + c\\)\n> \\(d = e + f\\)'} />);
  expect(screen.getAllByTestId('math-block')).toHaveLength(2);
  expect(screen.queryByTestId('inline-math')).toBeNull();
});

test('display math is split from surrounding prose even without blank lines', async () => {
  await renderAsync(<Markdown text={'Before.\n\\[ a + b = c \\]\nAfter.'} />);
  expect(screen.getByText('Before.')).toBeTruthy();
  expect(screen.getByTestId('math-block')).toBeTruthy();
  expect(screen.getByText('After.')).toBeTruthy();
});

test('genuinely inline math remains inline within prose', async () => {
  await renderAsync(<Markdown text={'The value \\(x_i\\) is updated.'} />);
  expect(screen.getByTestId('inline-math')).toBeTruthy();
  expect(screen.queryByTestId('math-block')).toBeNull();
});

test('inline math flows inside a paragraph and its underscores are not emphasis', async () => {
  await renderAsync(
    <Markdown text={'Here \\(\\operatorname{diag}(s)^{-1} \\cdot X\\) scales, and _real_ emphasis works.'} />,
  );
  expect(screen.getByText('diag(s)⁻¹ · X')).toBeTruthy();
  expect(screen.getByText('real')).toBeTruthy();
});

test('$$ display math is recognized', async () => {
  await renderAsync(<Markdown text={'$$ \\alpha + \\beta $$'} />);
  expect(screen.getByText('α + β')).toBeTruthy();
});

test('single-dollar inline math is accepted for compatibility', async () => {
  await renderAsync(<Markdown text={'The update $x_i = x_i + 1$ is applied.'} />);
  expect(screen.getByText('xᵢ = xᵢ + 1')).toBeTruthy();
});

test('currency dollar signs are not parsed as math delimiters', async () => {
  await renderAsync(<Markdown text={'It costs $10–$20 per hour, not $5.'} />);
  expect(screen.getByText(/\$10–\$20 per hour, not \$5\./)).toBeTruthy();
});

test('escaped and slash-separated currency are not parsed as math', async () => {
  await renderAsync(<Markdown text={'Quoted prices are \\$10 and \\$20; rates are $10/$20.'} />);
  expect(screen.getByText(/\\\$10 and \\\$20; rates are \$10\/\$20\./)).toBeTruthy();
});

test('abbreviated currency ranges are not parsed as math', async () => {
  await renderAsync(<Markdown text={'Funding rose from $5M-$8M, then from $5k–$10k.'} />);
  expect(screen.getByText(/\$5M-\$8M, then from \$5k–\$10k\./)).toBeTruthy();
});

test('leaked tool tags render as muted status lines, not markup', async () => {
  await renderAsync(
    <Markdown
      text={'Recent work:\n\n<search for="vAttention adoption 2026"> <search for="Vidur extensions">\n\nFindings follow.'}
    />,
  );
  expect(screen.getByText('Searched: vAttention adoption 2026')).toBeTruthy();
  expect(screen.getByText('Searched: Vidur extensions')).toBeTruthy();
  expect(screen.queryByText(/<search/)).toBeNull();
});

test('stripPseudoToolTags leaves code fences alone and strips orphan closers', () => {
  const fenced = 'a\n\n```xml\n<search for="keep">\n```\n\nb </search>';
  const out = stripPseudoToolTags(fenced);
  expect(out).toContain('<search for="keep">');
  expect(out).not.toContain('</search>');
  expect(stripPseudoToolTags('no tags, x < 5')).toBe('no tags, x < 5');
});

test('texToPlain approximates common TeX readably', () => {
  expect(texToPlain('\\alpha_{i} + \\beta^{2}')).toBe('αᵢ + β²');
  expect(texToPlain('\\frac{a}{b}')).toBe('(a)/(b)');
  expect(texToPlain('\\| W X \\|')).toBe('‖ W X ‖');
  expect(texToPlain('\\operatorname{diag}(s)')).toBe('diag(s)');
});

test('texToSvg produces a sized, themable SVG (real MathJax)', () => {
  const jestActual = jest.requireActual('@/lib/math') as typeof import('@/lib/math');
  const out = jestActual.texToSvg('\\arg\\min_{s} \\| Q(W \\cdot \\operatorname{diag}(s)) \\|', true);
  expect(out).not.toBeNull();
  expect(out!.svg.startsWith('<svg')).toBe(true);
  expect(out!.svg).toContain('currentColor');
  expect(out!.widthEx).toBeGreaterThan(5);
  expect(out!.heightEx).toBeGreaterThan(1);
  // Nonsense TeX degrades to null (caller falls back to texToPlain), never throws.
  expect(jestActual.texToSvg('\\undefinedmacro{', true)).toBeNull();
});

test('fitMathBlock fits, scales, or scrolls a display equation by width', () => {
  // Pre-layout (availW 0) and equations that fit render natural size, no scroll.
  expect(fitMathBlock(200, 40, 0)).toEqual({ width: 200, height: 40, scroll: false });
  expect(fitMathBlock(200, 40, 300)).toEqual({ width: 200, height: 40, scroll: false });
  // Moderately too wide → scaled to fit exactly (width == avail), height scaled, still no scroll.
  const scaled = fitMathBlock(400, 40, 300); // scale 0.75 ≥ 0.6
  expect(scaled.scroll).toBe(false);
  expect(scaled.width).toBeCloseTo(300);
  expect(scaled.height).toBeCloseTo(30);
  // Far too wide (scale < minScale) → natural size + horizontal scroll.
  expect(fitMathBlock(1000, 40, 300)).toEqual({ width: 1000, height: 40, scroll: true });
  // The minScale boundary is inclusive (scale exactly 0.6 still scales rather than scrolls).
  expect(fitMathBlock(500, 40, 300).scroll).toBe(false);
});

// Keep the import "used" — the mock above replaces getSvgXml but the actual texToSvg/texToPlain
// flow through unchanged.
void texToSvg;
