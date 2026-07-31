/**
 * The scanning reel. Its whole job is to LOOK like continuous scanning, so the failure mode is
 * silent: a static list is a perfectly valid render and nothing throws.
 */
import { render } from '@testing-library/react-native';
import { Animated, Text } from 'react-native';

import { ScanningList } from '@/components/ScanningList';

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => <Text key={i}>{`Paper ${i}`}</Text>);

afterEach(() => jest.restoreAllMocks());

test('the reel is duplicated so the loop has no visible seam', () => {
  // Translating a single copy would leave the window empty as the last row exits. The second
  // copy is what makes the wrap invisible.
  const { getAllByText } = render(
    <ScanningList rowHeight={44} rows={2} fadeColor="#fff">{rows(6)}</ScanningList>,
  );
  expect(getAllByText('Paper 0')).toHaveLength(2);
});

test('a reel that fits the window does not scroll or duplicate', () => {
  // Two rows in a two-row window have nowhere to go; animating them would jitter for no reason.
  const loop = jest.spyOn(Animated, 'loop');
  const { getAllByText } = render(
    <ScanningList rowHeight={44} rows={2} fadeColor="#fff">{rows(2)}</ScanningList>,
  );
  expect(getAllByText('Paper 0')).toHaveLength(1);
  expect(loop).not.toHaveBeenCalled();
});

test('the animation runs on the native driver', () => {
  // It has to keep moving while the JS thread is busy with the poll cycle; on the JS driver the
  // reel visibly stutters every time a snapshot lands.
  const timing = jest.spyOn(Animated, 'timing');
  render(<ScanningList rowHeight={44} rows={2} fadeColor="#fff">{rows(6)}</ScanningList>);
  expect(timing).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ useNativeDriver: true }),
  );
});

test('the scroll distance is exactly one copy of the reel', () => {
  // Anything else drifts: the wrap point stops lining up with a row boundary and the seam shows.
  const timing = jest.spyOn(Animated, 'timing');
  render(<ScanningList rowHeight={44} rows={2} fadeColor="#fff">{rows(6)}</ScanningList>);
  expect(timing).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ toValue: -(44 * 6) }),
  );
});

test('a longer reel takes proportionally longer, so the speed stays constant', () => {
  const timing = jest.spyOn(Animated, 'timing');
  render(<ScanningList rowHeight={44} rows={2} fadeColor="#fff">{rows(6)}</ScanningList>);
  const six = timing.mock.calls.at(-1)?.[1].duration as number;
  timing.mockClear();
  render(<ScanningList rowHeight={44} rows={2} fadeColor="#fff">{rows(12)}</ScanningList>);
  const twelve = timing.mock.calls.at(-1)?.[1].duration as number;
  expect(twelve).toBeCloseTo(six * 2, 5);
});

test('pausing stops the reel rather than merely hiding it', () => {
  const loop = jest.spyOn(Animated, 'loop');
  render(
    <ScanningList rowHeight={44} rows={2} fadeColor="#fff" paused>{rows(6)}</ScanningList>,
  );
  expect(loop).not.toHaveBeenCalled();
});

test('an empty reel renders nothing at all', () => {
  const { toJSON } = render(
    <ScanningList rowHeight={44} rows={2} fadeColor="#fff">{[]}</ScanningList>,
  );
  expect(toJSON()).toBeNull();
});
