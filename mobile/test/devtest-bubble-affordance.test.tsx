// DR-061/DR-062/DR-063 — three real gaps Kamil hit using the device-test companion himself:
// no visible affordance that a card is tappable, the wrong degraded-capture message on an old
// dev client, and a newly created item that was invisible below the verify queue.

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null, Chat: () => null, InputToolbar: () => null, MessageText: () => null,
}));

import { NativeModules } from 'react-native';
import { canScreenshot } from '@/components/DevTestBubble';

describe('canScreenshot (DR-062)', () => {
  const original = NativeModules.RNViewShot;
  afterEach(() => {
    NativeModules.RNViewShot = original;
  });

  it('is false when the JS package resolved but the native module did not link', () => {
    // This is exactly the shape a pre-rebuild dev client hits: `require()` succeeds because
    // the npm package is on disk and Metro bundles it, but the specific installed APK has no
    // native module registered for it.
    delete (NativeModules as Record<string, unknown>).RNViewShot;
    expect(canScreenshot()).toBe(false);
  });

  it('is true once the native module is actually linked', () => {
    (NativeModules as Record<string, unknown>).RNViewShot = { captureScreen: jest.fn() };
    expect(canScreenshot()).toBe(true);
  });
});
