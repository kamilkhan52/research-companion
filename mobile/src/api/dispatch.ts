// DR-092 — the models the DevTest "Dispatch to Claude" picker offers. Lives in its own module,
// not in endpoints.ts, so tests that jest.mock('@/api/endpoints') still get the real array
// (a constant needs no mocking) rather than an undefined that crashes the picker. One source of
// truth on the client: the picker renders this and the type derives from it. Mirrors
// DISPATCH_MODELS in app/routers/devtest.py; the server 400s an unknown model regardless.
export const DISPATCH_MODELS = ['sonnet', 'opus', 'haiku', 'fable'] as const;
export type DispatchModel = (typeof DISPATCH_MODELS)[number];
