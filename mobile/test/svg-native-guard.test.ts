// getSvgXml() must gate on react-native-svg's NATIVE linkage, not just its JS require. On the
// pre-rebuild dev client the JS resolves but the native RNSVG* views don't exist, so rendering
// an <SvgXml> hard-crashes ("Can't find ViewManager 'RNSVGPath'"). These tests pin that gate:
// no native module -> getSvgXml() is null (caller falls back to texToPlain); native present ->
// getSvgXml() returns the SvgXml component. getSvgXml caches, so each case runs in isolation.

const SENTINEL = function SvgXml() { return null; };

// getSvgXml's require('react-native-svg') is lazy (runs on first call), so it must be invoked
// while the doMock scope is still active — inside isolateModules — not after it returns.
function callGetSvgXml(turbo: { get: (name: string) => unknown } | undefined) {
  let result: unknown;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ TurboModuleRegistry: turbo }));
    jest.doMock('react-native-svg', () => ({ SvgXml: SENTINEL }));
    result = (require('@/lib/math') as typeof import('@/lib/math')).getSvgXml();
  });
  return result;
}

afterEach(() => {
  jest.dontMock('react-native');
  jest.dontMock('react-native-svg');
});

test('native module absent -> getSvgXml returns null (no SVG render, no crash)', () => {
  expect(callGetSvgXml({ get: () => null })).toBeNull();
});

test('native module present -> getSvgXml returns the SvgXml component', () => {
  expect(callGetSvgXml({ get: (name) => (name === 'RNSVGRenderableModule' ? {} : null) })).toBe(SENTINEL);
});

test('no TurboModuleRegistry at all -> getSvgXml returns null (safe default)', () => {
  expect(callGetSvgXml(undefined)).toBeNull();
});
