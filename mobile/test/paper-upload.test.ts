import { File as ExpoFile } from 'expo-file-system';

import { setBaseUrl } from '@/api/config';
import { convertFormDataAsync } from '../node_modules/expo/src/winter/fetch/convertFormData';

const api = jest.requireActual<typeof import('@/api/endpoints')>('@/api/endpoints');

const mockNativeFile = {
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
    expect(parts[1]?.[0]).toBe('file');
    expect(parts[1]?.[1]).toMatchObject({
      name: 'picked.pdf',
      type: 'application/pdf',
      bytes: expect.any(Function),
    });

    // Exercise Expo 56's real multipart converter, not a second mock of the accepted shape.
    // This both rejects the former {uri,name,type} descriptor and pins the filename/MIME headers
    // that would otherwise silently regress to DocumentPicker's random cache name.
    const converted = await convertFormDataAsync(
      init?.body as FormData,
      '----ExpoFetchFormBoundaryTEST',
    );
    const encoded = new TextDecoder().decode(converted.body);
    expect(encoded).toContain('filename="picked.pdf"');
    expect(encoded).toContain('content-type: application/pdf');
    expect(encoded).toContain('%PDF');
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
  expect(mockNativeFile.bytes).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
