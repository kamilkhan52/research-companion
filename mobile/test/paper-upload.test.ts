import { File as ExpoFile } from 'expo-file-system';

import { setBaseUrl } from '@/api/config';

const api = jest.requireActual<typeof import('@/api/endpoints')>('@/api/endpoints');

const mockNativeFile = {
  name: 'picked.pdf',
  type: 'application/pdf',
  bytes: jest.fn(async () => new Uint8Array([37, 80, 68, 70])),
};

const originalFormData = global.FormData;

class MockNativeFormData {
  parts: [string, unknown][] = [];

  append(name: string, value: unknown) {
    this.parts.push([name, value]);
  }

  entries() {
    return this.parts.values();
  }
}

jest.mock('expo-file-system', () => ({
  File: jest.fn(() => mockNativeFile),
}));

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(ExpoFile).mockClear();
  global.FormData = MockNativeFormData as unknown as typeof FormData;
  global.fetch = jest.fn(async (_url, init) => {
    const parts = Array.from((init?.body as FormData).entries());
    expect(parts[0]).toEqual(['slug', 'paper']);
    // Bind this test to Expo's side of the contract: the current multipart encoder accepts a
    // Blob or a file-like object with bytes(), and explicitly rejects the old URI descriptor.
    expect(parts[1]?.[0]).toBe('file');
    expect(parts[1]?.[1]).toBe(mockNativeFile);
    expect(typeof (parts[1]?.[1] as unknown as { bytes?: unknown }).bytes).toBe('function');
    return new Response(JSON.stringify({ job: { id: 'upload-1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as jest.Mock;
});

afterAll(() => {
  global.FormData = originalFormData;
});

test('PDF upload gives Expo fetch a filesystem-backed multipart part', async () => {
  await api.uploadPaper('project', 'paper', {
    uri: 'file:///cache/picked.pdf',
    name: 'picked.pdf',
    mimeType: 'application/pdf',
  });

  expect(ExpoFile).toHaveBeenCalledWith('file:///cache/picked.pdf');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
