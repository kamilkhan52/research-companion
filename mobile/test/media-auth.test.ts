import { setBaseUrl, setMediaCacheNamespace, setToken } from '@/api/config';

const endpoints = jest.requireActual<typeof import('@/api/endpoints')>('@/api/endpoints');

test('protected image sources keep the bearer token out of the URL', async () => {
  await setBaseUrl('https://api.example');
  await setToken('secret-jwt');
  setMediaCacheNamespace('user-a');

  const cover = endpoints.paperCoverImageSource('project one', 'paper/two');
  expect(cover).toEqual({
    uri: 'https://api.example/api/projects/project%20one/papers/paper%2Ftwo/cover.png',
    headers: { Authorization: 'Bearer secret-jwt' },
    cacheKey:
      'https://api.example/api/projects/project%20one/papers/paper%2Ftwo/cover.png::user:user-a',
  });
  expect(cover.uri).not.toContain('secret-jwt');
  expect(cover.uri).not.toContain('token=');

  const figure = endpoints.figureAssetSource(
    'project one',
    'paper/two',
    'figure three.png',
    1700000000,
  );
  expect(figure).toEqual({
    uri: 'https://api.example/api/projects/project%20one/papers/paper%2Ftwo/figures/figure%20three.png?v=1700000000',
    headers: { Authorization: 'Bearer secret-jwt' },
    cacheKey:
      'https://api.example/api/projects/project%20one/papers/paper%2Ftwo/figures/figure%20three.png?v=1700000000::user:user-a',
  });
  expect(figure.uri).not.toContain('secret-jwt');
  expect(figure.uri).not.toContain('token=');
});

test('protected image cache keys change across accounts without exposing either bearer', async () => {
  await setBaseUrl('https://api.example');
  await setToken('secret-a');
  setMediaCacheNamespace('user-a');
  const first = endpoints.paperCoverImageSource('shared-project', 'shared-paper');

  await setToken('secret-b');
  setMediaCacheNamespace('user-b');
  const second = endpoints.paperCoverImageSource('shared-project', 'shared-paper');

  expect(first.uri).toBe(second.uri);
  expect(first.cacheKey).not.toBe(second.cacheKey);
  expect(first.cacheKey).not.toContain('secret-a');
  expect(second.cacheKey).not.toContain('secret-b');
});
