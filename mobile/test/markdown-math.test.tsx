// Equation rendering + pseudo tool-tag cleanup in Markdown (polish plan G). SVG availability
// is forced off so these tests pin the fallback path (the pre-rebuild client's behavior);
// texToSvg itself is tested directly — MathJax is pure JS and runs under jest.

import { renderAsync, screen } from '@testing-library/react-native';

import { Markdown } from '@/components/Markdown';
import { texToPlain, texToSvg } from '@/lib/math';
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
  expect(screen.queryByText(/\\arg/)).toBeNull();
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

// Keep the import "used" — the mock above replaces getSvgXml but the actual texToSvg/texToPlain
// flow through unchanged.
void texToSvg;
