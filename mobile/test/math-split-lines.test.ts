// DR-098 — over-wide display equations wrap at their own connectives instead of clipping into
// a scroll strip (Kamil: "We want all equations to be fully readable… multiple lines are all
// acceptable, but it should work reliably").
//
// Round 2 (Kamil re-tested and failed it): breaking ONCE at the top level is not enough — the
// line the break produces can still be far wider than the column. These tests therefore assert
// the property he actually asked for — every line FITS — by rendering each line with the app's
// own MathJax and measuring it, rather than asserting a particular set of break points.

import { SPLIT_TIER, fitMathBlock, splitTexForLines, texToSvg } from '@/lib/math';

// His phone: 412dp wide, the transcript column inset by space.xl either side, display math at
// fontSize 17 (ex ≈ 0.45em).
const COLUMN_PX = 364;
const EX_PX = 17 * 0.45;

function widthPx(tex: string): number {
  const rendered = texToSvg(tex, true);
  // A null render means MathJax REJECTED the TeX — an unbalanced `\left` is the way a split can
  // produce that — and the app would fall back to plain text. Never silently pass it.
  if (!rendered) throw new Error(`MathJax rejected: ${tex}`);
  return rendered.widthEx * EX_PX;
}

/** What MathBlock does: split, then re-split any line that is still too wide at the next tier. */
function layout(tex: string, tier: number = SPLIT_TIER.ARROW, depth = 0): string[] {
  const width = widthPx(tex);
  if (fitMathBlock(width, 10, COLUMN_PX).scroll === false) return [tex];
  const split = depth > 6 ? null : splitTexForLines(tex, tier, Math.ceil(width / COLUMN_PX));
  if (!split) return [tex]; // atomic: the scroll strip keeps it readable by swiping
  return split.pieces.flatMap((piece) => layout(piece, split.tier + 1, depth + 1));
}

// The equation that raised the issue in round 1, verbatim from the Pushing-up transcript.
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

// The two that were still cut off in round 2, verbatim from the HBF transcript.
const BANDWIDTH = `BW_{\\mathrm{effective}}
=
\\min
\\left(
BW_{\\mathrm{interface}},
BW_{\\mathrm{array}},
BW_{\\mathrm{controller}},
BW_{\\mathrm{power}},
BW_{\\mathrm{thermal}},
BW_{\\mathrm{workload}}
\\right).`;

const DELTA_HBF = `\\Delta_{\\mathrm{HBF}}
=
\\underbrace{f\\Delta t_{\\mathrm{media}}}_{\\text{critical-path I/O}}
-
\\underbrace{C_{\\mathrm{move}}}_{\\text{movement/control}}
-
\\underbrace{C_{\\mathrm{pkg}}}_{\\text{near-tier opportunity}}
-
\\underbrace{C_{\\mathrm{var}}}_{\\text{throttle/variability}}
-
\\underbrace{C_{\\mathrm{life}}}_{\\text{endurance/capacity}} .`;

test.each([
  ['the DDR4 dataflow chain', DDR4],
  ['the effective-bandwidth minimum', BANDWIDTH],
  ['the HBF advantage decomposition', DELTA_HBF],
])('%s lays out with every line inside the column', (_name, tex) => {
  const lines = layout(tex);
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    // widthPx throws on a line MathJax cannot render, so balance is asserted here too.
    expect(widthPx(line)).toBeLessThanOrEqual(COLUMN_PX / 0.9); // 0.9 = the shrink floor
  }
});

test('a still-too-wide line re-splits at the tier below the one that produced it', () => {
  const first = splitTexForLines(BANDWIDTH)!;
  expect(first.tier).toBe(SPLIT_TIER.RELATION);
  expect(first.pieces).toHaveLength(2);
  // Round 1 stopped here, and this remainder is ~540px in a 364px column — the "cut off" line.
  expect(widthPx(first.pieces[1])).toBeGreaterThan(COLUMN_PX);
  const second = splitTexForLines(first.pieces[1], first.tier + 1, 2)!;
  expect(second.tier).toBe(SPLIT_TIER.ARGUMENT);
  expect(second.pieces).toHaveLength(2);
});

test('splitting inside a \\left…\\right group rebalances both halves', () => {
  const split = splitTexForLines('\\min\\left(a_{one}, b_{two}, c_{three}\\right)',
    SPLIT_TIER.ARGUMENT, 2)!;
  expect(split.pieces[0].endsWith('\\right.')).toBe(true);
  expect(split.pieces[1].startsWith('\\left.')).toBe(true);
  // The point of the rebalancing: MathJax renders both halves instead of rejecting them.
  for (const piece of split.pieces) expect(texToSvg(piece, true)).not.toBeNull();
});

test('an argument list is thinned to the number of lines the width actually needs', () => {
  const args = '\\min\\left(a, b, c, d, e, f\\right)';
  expect(splitTexForLines(args, SPLIT_TIER.ARGUMENT, 2)!.pieces).toHaveLength(2);
  expect(splitTexForLines(args, SPLIT_TIER.ARGUMENT, 3)!.pieces).toHaveLength(3);
  // Unthinned (target 0) keeps every comma: one argument per line.
  expect(splitTexForLines(args, SPLIT_TIER.ARGUMENT, 0)!.pieces).toHaveLength(6);
});

test('top-level sums break at their operators, and a sign is never an operator', () => {
  const split = splitTexForLines('A_{one} + B_{two} - C_{three}', SPLIT_TIER.OPERATOR)!;
  expect(split.tier).toBe(SPLIT_TIER.OPERATOR);
  expect(split.pieces).toEqual(['A_{one}', '+ B_{two}', '- C_{three}']);
  // A leading or post-operator minus is a SIGN: breaking there would leave an empty line.
  expect(splitTexForLines('-x = -y', SPLIT_TIER.OPERATOR)).toBeNull();
  // …and the sign stays attached when a real operator elsewhere does produce the break.
  expect(splitTexForLines('-x = -y + z', SPLIT_TIER.OPERATOR)!.pieces)
    .toEqual(['-x = -y', '+ z']);
});

test('the DDR4 chain still prefers arrows over the relations and operators below them', () => {
  const split = splitTexForLines(DDR4)!;
  expect(split.tier).toBe(SPLIT_TIER.ARROW);
  expect(split.pieces).toHaveLength(4);
  expect(split.pieces[0]).toBe('\\text{DDR4}');
  // Continuation lines lead with their connective — the display-math convention.
  expect(split.pieces[1].startsWith('\\rightarrow')).toBe(true);
  expect(split.pieces[2]).toContain('\\begin{cases}');
  expect(split.pieces[3]).toContain('VPU/SPU');
});

test('connectives inside cases/environments and text braces never split', () => {
  const split = splitTexForLines(DDR4)!;
  expect(split.pieces[2]).toContain('KV-cache stream');
  expect(split.pieces[2]).toContain('embedding stream');
  expect(splitTexForLines('\\begin{cases} a = 1 \\\\ b = 2 \\end{cases}')).toBeNull();
  expect(splitTexForLines('\\text{a = b and c = d}')).toBeNull();
  // A comma inside \text{…} is prose, not an argument separator.
  expect(splitTexForLines('\\left(\\text{one, two}\\right)', SPLIT_TIER.ARGUMENT)).toBeNull();
});

test('a relation enclosed by a delimiter is not top level', () => {
  expect(splitTexForLines('\\left( a = b \\right)')).toBeNull();
  expect(splitTexForLines('f(a = b)')).toBeNull();
  // …but the parentheses of an ordinary function call still leave the outer relation top level.
  const split = splitTexForLines('f(x) = \\sum_i a_i x^i = g(x) + h(x)')!;
  expect(split.pieces).toHaveLength(3);
  expect(split.pieces[1].startsWith('=')).toBe(true);
});

test('content with nothing to break at stays single-line at every tier', () => {
  expect(splitTexForLines('\\frac{a}{b}')).toBeNull();
  expect(splitTexForLines('a very long equation')).toBeNull();
  // Past the last tier there is nothing left to try — the recursion's floor.
  expect(splitTexForLines('a = b', SPLIT_TIER.ARGUMENT + 1)).toBeNull();
});
