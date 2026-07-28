import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { startAccountDeletion } from '@/api/endpoints';
import { useAuth } from '@/auth/AuthProvider';
import { ACCOUNT_DELETION_QUERY_KEY } from '@/components/AccountDeletionGuard';
import { TopBar } from '@/components/TopBar';
import { useTheme, useThemedStyles, type DensityMode } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';
import { Button, Card, Icon, Screen, Text } from '@/ui';

export default function DeleteAccountScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { email, refreshSession } = useAuth();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmation === 'DELETE';

  async function submit() {
    if (!confirmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // The backend accepts deletion only with a token minted in the last five minutes.
      await refreshSession();
      const result = await startAccountDeletion();
      // AccountDeletionGuard observes this key and immediately replaces the ordinary app with the
      // durable progress surface. No other protected request can race after the tombstone.
      queryClient.setQueryData(ACCOUNT_DELETION_QUERY_KEY, result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Account deletion could not be started.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen edges={['top']}>
      <TopBar title="Delete account" onBack={() => router.back()} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Card style={styles.warning}>
            <Icon name="alert-triangle" size={26} color={t.danger} />
            <Text variant="title" style={{ marginTop: space.md }}>
              This can’t be undone
            </Text>
            <Text color={t.muted} style={{ marginTop: space.sm }}>
              Permanently delete {email ? `${email} and all` : 'your account and all'} research
              data connected to it.
            </Text>
          </Card>

          <View style={styles.list}>
            <DeletionItem text="Projects, papers, discussions, and notes" />
            <DeletionItem text="Generated narrations and account settings" />
            <DeletionItem text="Your Paradigm sign-in identity" />
          </View>

          <Text variant="heading" style={{ marginTop: space.xl }}>
            Type DELETE to confirm
          </Text>
          <TextInput
            value={confirmation}
            onChangeText={setConfirmation}
            placeholder="DELETE"
            placeholderTextColor={t.muted}
            autoCapitalize="characters"
            autoCorrect={false}
            accessibilityLabel="Type DELETE to confirm account deletion"
            style={styles.input}
          />
          {error ? (
            <Text variant="caption" color={t.danger} style={{ marginTop: space.md }}>
              {error}
            </Text>
          ) : null}
          <Button
            title="Permanently delete account"
            variant="danger"
            icon="trash-2"
            disabled={!confirmed}
            loading={submitting}
            onPress={() => { void submit(); }}
            style={{ marginTop: space.lg }}
          />
          <Text variant="caption" color={t.muted} style={{ marginTop: space.md, textAlign: 'center' }}>
            Deletion runs safely in the background. Once it starts, it cannot be cancelled.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function DeletionItem({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <Icon name="x-circle" size={18} color={t.danger} />
      <Text style={{ flex: 1 }}>{text}</Text>
    </View>
  );
}

const makeStyles = (t: ThemePalette, density: DensityMode) => StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: space.xxl * 2,
  },
  warning: {
    backgroundColor: t.dangerWash,
    borderColor: t.danger,
  },
  list: {
    gap: density === 'tight' ? space.sm : space.md,
    marginTop: space.xl,
  },
  input: {
    marginTop: space.sm,
    height: density === 'tight' ? 48 : 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.elevated,
    color: t.text,
    fontFamily: fonts.bodySemiBold,
    fontSize: 16,
    letterSpacing: 1.5,
    paddingHorizontal: space.md,
  },
});
