// The Library's "Continue reading" hero can be dismissed. Two properties are easy to get wrong
// and are what this pins:
//
//   * the dismissal PERSISTS — a tab switch remounts the screen, and a dismissal held in
//     component state would come back, which reads as the button not working;
//   * it is scoped to ONE session, not a global "hidden" flag — otherwise a single tap either
//     kills the feature forever, or keeps suppressing the hero after the reader has moved on to
//     a different paper.

import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useContinueCardDismissal } from '@/hooks/useContinueCardDismissal';

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('nothing is dismissed to begin with', async () => {
  const { result } = renderHook(() => useContinueCardDismissal());
  await waitFor(() => expect(result.current.loaded).toBe(true));

  expect(result.current.isDismissed('proj', 'paper-a')).toBe(false);
});

test('dismissing hides that session and nothing else', async () => {
  const { result } = renderHook(() => useContinueCardDismissal());
  await waitFor(() => expect(result.current.loaded).toBe(true));

  await act(async () => {
    result.current.dismiss('proj', 'paper-a');
  });

  expect(result.current.isDismissed('proj', 'paper-a')).toBe(true);
  // A different paper in the same project, and the same slug in another project, are other
  // sessions — the hero must still appear for them.
  expect(result.current.isDismissed('proj', 'paper-b')).toBe(false);
  expect(result.current.isDismissed('other', 'paper-a')).toBe(false);
});

test('the dismissal survives a remount', async () => {
  const first = renderHook(() => useContinueCardDismissal());
  await waitFor(() => expect(first.result.current.loaded).toBe(true));
  await act(async () => {
    first.result.current.dismiss('proj', 'paper-a');
  });
  first.unmount();

  // A fresh mount is what a tab switch does; without persistence this is where it comes back.
  const second = renderHook(() => useContinueCardDismissal());
  await waitFor(() => expect(second.result.current.loaded).toBe(true));

  expect(second.result.current.isDismissed('proj', 'paper-a')).toBe(true);
});

