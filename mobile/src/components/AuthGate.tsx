// Stands between the app and its content whenever the backend demands authentication.
//
// The states are deliberately four, not two. "I don't know yet" must not render a sign-in form
// (it would flash on every cold start), and "I can't reach the server" must not render one either
// — telling someone to sign in when the real problem is a wrong server URL or a stopped backend
// sends them to fix the wrong thing, and there is no password they can type that will help.

import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { getBaseUrl } from '@/api/config';
import { useAuth } from '@/auth/AuthProvider';
import { Button, Card, Screen, Text } from '@/ui';
import { space, radius, fonts, type ThemePalette } from '@/theme/tokens';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { StyleSheet, TextInput } from 'react-native';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();

  if (status === 'unknown') {
    return (
      <Screen edges={['top']}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      </Screen>
    );
  }
  // `disabled` is a local backend with no auth configured — the normal development case, and the
  // only one where showing content without a token is correct.
  if (status === 'disabled' || status === 'signed-in') return <>{children}</>;
  return <SignIn />;
}

function SignIn() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { status, mode, error, signInWithGoogle, signInWithMagicLink, retry } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'google' | 'magic' | null>(null);

  async function run(which: 'google' | 'magic', action: () => Promise<void>) {
    setBusy(which);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }

  if (status === 'unreachable') {
    return (
      <Screen edges={['top']}>
        <View style={styles.center}>
          <Card>
            <Text variant="heading">Can't reach the server</Text>
            <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
              {getBaseUrl()
                ? `No response from ${getBaseUrl()}. Check that the backend is running, or change the server URL in Settings.`
                : 'No server URL is set yet. Add one in Settings to connect.'}
            </Text>
            <Button title="Try again" onPress={retry} style={{ marginTop: space.md }} />
          </Card>
        </View>
      </Screen>
    );
  }

  // A backend on the legacy shared-secret gate. Staging and prod refuse to boot in this mode, so
  // it only reaches a phone pointed at an old or oddly-configured local server — say so plainly
  // rather than offering a Google button that cannot work.
  if (mode !== 'supabase') {
    return (
      <Screen edges={['top']}>
        <View style={styles.center}>
          <Card>
            <Text variant="heading">Sign-in not available</Text>
            <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
              This server uses a shared access token, which this app cannot enter. Point it at a
              server using Supabase sign-in, or run the backend without authentication.
            </Text>
            <Button title="Check again" onPress={retry} style={{ marginTop: space.md }} />
          </Card>
        </View>
      </Screen>
    );
  }

  return (
    <Screen edges={['top']}>
      <View style={styles.center}>
        <Card>
          <Text variant="heading">Sign in to Paradigm</Text>
          <Text variant="caption" color={t.muted} style={{ marginTop: space.xs, marginBottom: space.lg }}>
            Your reading, notes, and audio live on your own server. Signing in tells it who you are.
          </Text>

          <Button
            title="Continue with Google"
            onPress={() => void run('google', signInWithGoogle)}
            loading={busy === 'google'}
            disabled={busy !== null}
          />

          <Text variant="caption" color={t.muted} style={{ marginTop: space.lg, marginBottom: 6 }}>
            or get a sign-in link by email
          </Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={t.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            style={styles.input}
          />
          <Button
            title="Email me a link"
            onPress={() => void run('magic', () => signInWithMagicLink(email))}
            loading={busy === 'magic'}
            disabled={busy !== null || !email.trim()}
            style={{ marginTop: space.sm }}
          />

          {error ? (
            <Text variant="caption" color={t.muted} style={{ marginTop: space.md }}>
              {error}
            </Text>
          ) : null}
        </Card>
      </View>
    </Screen>
  );
}

const makeStyles = (t: ThemePalette) =>
  StyleSheet.create({
    center: { flex: 1, justifyContent: 'center', paddingHorizontal: space.lg },
    input: {
      backgroundColor: t.elevated,
      borderWidth: 1,
      borderColor: t.line2,
      borderRadius: radius.md,
      paddingHorizontal: space.md,
      paddingVertical: 12,
      color: t.text,
      fontFamily: fonts.body,
      fontSize: 15,
    },
  });
