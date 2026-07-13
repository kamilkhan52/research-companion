import { fireEvent, render, screen } from '@testing-library/react-native';

import { MathBlock } from '@/components/MathView';

jest.mock('@/lib/math', () => {
  const actual = jest.requireActual('@/lib/math');
  const { View } = jest.requireActual('react-native');
  const SvgStub = ({ width, height }: { width: number; height: number }) => (
    <View testID="math-svg" style={{ width, height }} />
  );
  return {
    ...actual,
    getSvgXml: () => SvgStub,
    texToSvg: (tex: string) => tex === 'incomplete'
      ? null
      : ({ svg: '<svg />', widthEx: 200, heightEx: 8, depthEx: 0 }),
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
