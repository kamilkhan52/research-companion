// The landing route for `researchcompanion://auth?code=...`.
//
// It exists because expo-router ALSO sees the sign-in callback. `AuthProvider`'s `Linking`
// listener does the actual work — exchanging the PKCE code for a session — but the router is
// handling the same URL as navigation, and with no file named `auth` here it matched nothing and
// rendered its "Unmatched Route" screen. So sign-in genuinely succeeded and then dropped the user
// on a 404, which is indistinguishable from sign-in having failed.
//
// Ten review rounds missed this because it is an integration between two subsystems that each
// behaved correctly: Jest never mounts expo-router's navigator with a deep link, so nothing in the
// suite could see it. It took a real device.
//
// This screen therefore does no auth work of its own — duplicating the exchange here would consume
// the PKCE verifier a second time and fail. It only gets the user off the callback URL.

import { router } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Screen } from '@/ui';

export default function AuthCallback() {
  useEffect(() => {
    // `replace`, not `push`: the callback URL must not stay in the history, or Back returns to a
    // spent one-time code. Deferred a frame so the navigator is mounted before we navigate — on a
    // cold start this route IS the first render.
    const timer = setTimeout(() => router.replace('/'), 0);
    return () => clearTimeout(timer);
  }, []);

  // A spinner rather than null: on a cold start from a magic link this is the first thing shown,
  // and a blank screen reads as a crash.
  return (
    <Screen edges={['top']}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    </Screen>
  );
}
