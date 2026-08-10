import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ApiError } from '@/api/client';
import { setBaseUrl } from '@/api/config';
import {
  classifySpendRefusal,
  presentSpendRefusal,
  resetLabel,
  SpendRefusalHost,
} from '@/components/SpendRefusalSheet';
import { ThemeProvider } from '@/theme/ThemeProvider';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

test('formats the server UTC reset date without shifting it in western timezones', () => {
  const format = jest.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('September 1');
  expect(resetLabel('2026-09-01T00:00:00+00:00')).toBe('September 1');
  expect(format).toHaveBeenCalledWith(undefined, {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  format.mockRestore();
});

function renderHost() {
  return renderAsync(
    <ThemeProvider>
      <SpendRefusalHost />
    </ThemeProvider>,
  );
}

test('classifies all four states from the refusal response, not a plan warning', () => {
  expect(classifySpendRefusal(new ApiError(402, 'limit', {
    code: 'quota_exceeded', requested_nanousd: 10, limit_nanousd: 20,
  }))).toBe('exhausted');
  expect(classifySpendRefusal(new ApiError(402, 'large', {
    code: 'quota_exceeded', requested_nanousd: 21, limit_nanousd: 20,
  }))).toBe('too_large');
  expect(classifySpendRefusal(new ApiError(429, 'busy', {
    code: 'holds_outstanding', retryAfterSeconds: 15,
  }))).toBe('busy');
  expect(classifySpendRefusal(new ApiError(429, 'fast', {
    code: 'rate_limited', retryAfterSeconds: 10,
  }))).toBe('rate_limited');
  expect(classifySpendRefusal({ warn: true, at_capacity: true })).toBeNull();
});

test('busy refusal counts down, stays disabled, and retries only after zero', async () => {
  jest.useFakeTimers();
  const retry = jest.fn();
  await renderHost();
  act(() => {
    presentSpendRefusal(new ApiError(429, 'busy', {
      code: 'holds_outstanding', retryAfterSeconds: 2,
    }), { retry });
  });

  await waitFor(() => expect(screen.getByText('A few things are finishing.')).toBeTruthy());
  expect(screen.getByText('WORK IN PROGRESS')).toBeTruthy();
  expect(screen.getByText('Try again in 2s')).toBeDisabled();
  expect(screen.queryByText(/reset/i)).toBeNull();
  fireEvent.press(screen.getByText('Try again in 2s'));
  expect(retry).not.toHaveBeenCalled();

  act(() => jest.advanceTimersByTime(2000));
  fireEvent.press(screen.getByText('Try again'));
  expect(retry).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

test('exhausted refusal loads the authoritative reset date and links to plan usage', async () => {
  await setBaseUrl('https://api.example');
  jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: jest.fn(async () => ({ period_ends: '2026-09-01T00:00:00+00:00' })),
  } as unknown as Response);
  await renderHost();
  act(() => {
    presentSpendRefusal(new ApiError(402, 'limit', {
      code: 'quota_exceeded', requested_nanousd: 10, limit_nanousd: 20,
    }));
  });

  const expectedReset = new Date('2026-09-01T00:00:00+00:00').toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  expect(await screen.findByText("This month's allowance is used.")).toBeTruthy();
  expect(screen.getByText('MONTHLY ALLOWANCE')).toBeTruthy();
  expect(await screen.findByText(`Resets ${expectedReset}`)).toBeTruthy();
  expect(screen.getByText(/hand-editing notes/)).toBeTruthy();
  fireEvent.press(screen.getByText('View plan & usage'));
  expect(mockPush).toHaveBeenCalledWith('/plan');
});

test('too-large narration offers device voice while other work asks for a smaller action', async () => {
  await renderHost();
  act(() => {
    presentSpendRefusal(new ApiError(402, 'large', {
      code: 'quota_exceeded', requested_nanousd: 21, limit_nanousd: 20,
    }), { operation: 'narration' });
  });
  await waitFor(() => expect(screen.getByText('Use device voice')).toBeTruthy());
  expect(screen.getByText("This narration won't fit your plan.")).toBeTruthy();
  expect(screen.getByText('Device voice is included')).toBeTruthy();
  expect(screen.queryByText(/upgrade/i)).toBeNull();
  fireEvent.press(screen.getByText('Not now'));

  act(() => {
    presentSpendRefusal(new ApiError(402, 'large', {
      code: 'quota_exceeded', requested_nanousd: 21, limit_nanousd: 20,
    }), { operation: 'other' });
  });
  await waitFor(() => expect(screen.getByText('Choose a smaller action')).toBeTruthy());
  expect(screen.getByText("This action won't fit your plan.")).toBeTruthy();
});

test('tight density keeps refusal body and supporting copy above the money floor', async () => {
  await AsyncStorage.setItem('rc.layoutDensity', 'tight');
  await renderHost();
  act(() => {
    presentSpendRefusal(new ApiError(402, 'large', {
      code: 'quota_exceeded', requested_nanousd: 21, limit_nanousd: 20,
    }), { operation: 'narration' });
  });

  const body = await screen.findByText(/studio-voice version is larger/);
  expect(StyleSheet.flatten(body.props.style)).toMatchObject({ fontSize: 15, lineHeight: 23 });
  const supporting = screen.getByText('Device voice is included');
  expect(StyleSheet.flatten(supporting.props.style)).toMatchObject({ fontSize: 13, lineHeight: 18 });
});
