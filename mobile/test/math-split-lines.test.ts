// DR-098 — over-wide display equations wrap at their own top-level connectives instead of
// clipping into a scroll strip (Kamil: "We want all equations to be fully readable…
// multiple lines are all acceptable, but it should work reliably").

import { splitTexForLines } from '@/lib/math';

// The equation that raised the issue, verbatim from the Pushing-up transcript.
const DDR4 = `\\text{DDR4}
\\rightarrow
\\text{wide burst-oriented MCU}
\\rightarrow
\\begin{cases}
\\text{dequantization and weight stream}\\\\
\\text{KV-cache stream}\\\\
\\text{embedding stream}
\\end{cases}
\\rightarrow
\\text{VPU/SPU fused dataflow}.`;

test('the DDR4 dataflow chain splits at its three top-level arrows', () => {
  const pieces = splitTexForLines(DDR4);
  expect(pieces).toHaveLength(4);
  expect(pieces![0]).toBe('\\text{DDR4}');
  // Continuation lines lead with their connective — the display-math convention.
  expect(pieces![1].startsWith('\\rightarrow')).toBe(true);
  expect(pieces![2]).toContain('\\begin{cases}');
  expect(pieces![3].startsWith('\\rightarrow')).toBe(true);
  expect(pieces![3]).toContain('VPU/SPU');
});

test('connectives inside cases/environments and text braces never split', () => {
  // The \\\\ separators and text inside the cases body are all below top level.
  const pieces = splitTexForLines(DDR4);
  expect(pieces![2]).toContain('KV-cache stream');
  expect(pieces![2]).toContain('embedding stream');
  expect(splitTexForLines('\\begin{cases} a = 1 \\\\ b = 2 \\end{cases}')).toBeNull();
  expect(splitTexForLines('\\text{a = b and c = d}')).toBeNull();
});

test('a left/right delimited group is atomic', () => {
  expect(splitTexForLines('\\left( a = b \\right)')).toBeNull();
});

test('top-level equals chains split when arrows are absent', () => {
  const pieces = splitTexForLines('f(x) = \\sum_i a_i x^i = g(x) + h(x)');
  expect(pieces).toHaveLength(3);
  expect(pieces![1].startsWith('=')).toBe(true);
});

test('arrows take precedence over relations so chain steps stay whole', () => {
  const pieces = splitTexForLines('a = b \\rightarrow c = d');
  expect(pieces).toHaveLength(2);
  expect(pieces![0]).toBe('a = b');
  expect(pieces![1]).toBe('\\rightarrow c = d');
});

test('connective-free content has no split and stays single-line', () => {
  expect(splitTexForLines('\\frac{a}{b}')).toBeNull(); // nothing to split at
  expect(splitTexForLines('a very long equation')).toBeNull();
});

test('short chains do split as a function — the caller only invokes it on over-wide math', () => {
  expect(splitTexForLines('x = 1')).toEqual(['x', '= 1']);
});

test('escaped braces are symbols, not delimiters', () => {
  const pieces = splitTexForLines('\\{ a \\} \\rightarrow \\{ b \\}');
  expect(pieces).toHaveLength(2);
});
