import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { InlineMath, MathBlock } from '@/components/MathView';

jest.mock('@/lib/math', () => {
  const actual = jest.requireActual('@/lib/math');
  const { View } = jest.requireActual('react-native');
  const SvgStub = ({ width, height }: { width: number; height: number }) => (
    <View testID="math-svg" style={{ width, height }} />
  );
  return {
    ...actual,
    getSvgXml: () => SvgStub,
    texToSvg: (tex: string) => {
      if (tex === 'incomplete') return null;
      // DR-098: the split test's pieces must be narrower than the whole, as they are in
      // reality — a flat width would make every stacked line "too wide" again.
      const narrowPieces = ['A', '\\rightarrow B_{\\text{long}}', '\\rightarrow C'];
      const widthEx = narrowPieces.includes(tex) ? 20 : 200;
      return { svg: '<svg />', widthEx, heightEx: 8, depthEx: 0 };
    },
  };
});

test('a very wide block owns a bounded viewport and exposes horizontal scrolling', () => {
  render(<MathBlock tex="a very long equation" />);

  const root = screen.getByTestId('math-block');
  fireEvent(root, 'layout', { nativeEvent: { layout: { width: 300, height: 60, x: 0, y: 0 } } });

  const scroller = screen.getByTestId('math-block-scroll');
  expect(scroller.props.horizontal).toBe(true);
  expect(scroller.props.showsHorizontalScrollIndicator).toBe(true);
  expect(scroller.props.style).toEqual(expect.objectContaining({ width: '100%', maxWidth: '100%' }));
  expect(root.props.style).toEqual(expect.objectContaining({ width: '100%', maxWidth: '100%' }));
  // The content stays wider than the 300px viewport; that width delta is what makes it scroll.
  expect(screen.getByTestId('math-svg').props.style.width).toBeGreaterThan(300);
});

test('a streamed equation can move from fallback text to SVG without changing hook order', () => {
  const view = render(<MathBlock tex="incomplete" />);
  expect(screen.getByTestId('math-block')).toBeTruthy();

  expect(() => view.rerender(<MathBlock tex="complete" />)).not.toThrow();
  expect(screen.getByTestId('math-svg')).toBeTruthy();
});

test('inline math remains a text glyph run even when native SVG is available', () => {
  render(
    <Text>
      Endurance is <InlineMath tex={'0.56\\times'} /> as long as the baseline.
    </Text>,
  );

  expect(screen.getByText('0.56×')).toBeTruthy();
  expect(screen.queryByTestId('math-svg')).toBeNull();
  expect(screen.getByTestId('inline-math').type).toBe('Text');
});

// DR-098 — a wide equation with top-level connectives stacks as fitted lines instead of
// falling into the scroll strip; the strip remains only for genuinely unbreakable content
// (covered by the very-wide test above, whose prose tex has no connectives).
test('a wide chain equation wraps into stacked display lines, not a scroll strip', () => {
  render(<MathBlock tex="A \rightarrow B_{\text{long}} \rightarrow C" />);

  const root = screen.getByTestId('math-block-lines');
  fireEvent(root, 'layout', { nativeEvent: { layout: { width: 300, height: 60, x: 0, y: 0 } } });
  expect(screen.queryByTestId('math-block-scroll')).toBeNull();
  // Three pieces, each its own (fitted) math block.
  expect(screen.getAllByTestId('math-block').length).toBe(3);
});
