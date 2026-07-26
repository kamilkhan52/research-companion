// The device pass found this and the suite could not: expo-router ALSO handles
// `researchcompanion://auth?code=...` as navigation. `AuthProvider`'s Linking listener did the
// PKCE exchange correctly, so sign-in genuinely succeeded — and then the router matched no route
// named `auth` and rendered "Unmatched Route". A successful sign-in that ends on a 404 is
// indistinguishable, to the person holding the phone, from a failed one.
//
// Ten review rounds missed it because it lives between two subsystems that were each individually
// right, and nothing in the suite mounted the navigator with a deep link. This test does.

import { Text } from 'react-native';
import { router } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import { waitFor } from '@testing-library/react-native';

import AuthCallback from '@/app/auth';

test('the sign-in callback URL resolves to a route and bounces home', async () => {
  const rendered = renderRouter(
    {
      index: () => <Text>Library</Text>,
      auth: AuthCallback,
    },
    { initialUrl: '/auth?code=81a80414-84da-43a8-bbe2-685a3fab1bb1' },
  );

  // Landing anywhere other than `/auth` at first would mean the router never matched it — which is
  // exactly the "Unmatched Route" failure, just expressed as a path.
  await waitFor(() => expect(rendered.getPathname()).toBe('/'));
  expect(screen.getByText('Library')).toBeTruthy();
});

test('the callback does not stay in the history', async () => {
  // `replace`, not `push`. Otherwise Back returns the user to a spent one-time code, which cannot
  // be exchanged again and would look like sign-in breaking on the second attempt.
  const rendered = renderRouter(
    {
      index: () => <Text>Library</Text>,
      auth: AuthCallback,
    },
    { initialUrl: '/auth?code=abc' },
  );

  await waitFor(() => expect(rendered.getPathname()).toBe('/'));
  expect(router.canGoBack()).toBe(false);
});
