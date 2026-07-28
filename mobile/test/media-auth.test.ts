import { setBaseUrl, setToken } from '@/api/config';

const endpoints = jest.requireActual<typeof import('@/api/endpoints')>('@/api/endpoints');

test('protected image sources keep the bearer token out of the URL', async () => {
  await setBaseUrl('https://api.example');
  await setToken('secret-jwt');

  const cover = endpoints.paperCoverImageSource('project one', 'paper/two');
  expect(cover).toEqual({
    uri: 'https://api.example/api/projects/project%20one/papers/paper%2Ftwo/cover.png',
    headers: { Authorization: 'Bearer secret-jwt' },
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
  });
  expect(figure.uri).not.toContain('secret-jwt');
  expect(figure.uri).not.toContain('token=');
});
