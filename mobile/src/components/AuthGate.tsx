// Stands between the app and its content whenever the backend demands authentication.
//
// The states are deliberately four, not two. "I don't know yet" must not render a sign-in form
// (it would flash on every cold start), and "I can't reach the server" must not render one either
// — telling someone to sign in when the real problem is a wrong server URL or a stopped backend
// sends them to fix the wrong thing, and there is no password they can type that will help.

import * as Linking from 'expo-linking';
import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { getBaseUrl, setBaseUrl } from '@/api/config';
import { useAuth } from '@/auth/AuthProvider';
import { Button, Icon, IconButton, Screen, Text, type IconName } from '@/ui';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';

type AuthFlow = 'welcome' | 'sign-in' | 'create-account' | 'check-inbox';
type EntryFlow = Extract<AuthFlow, 'sign-in' | 'create-account'>;

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();

  if (status === 'unknown') {
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={common.centered}>
          <ActivityIndicator />
        </View>
      </Screen>
    );
  }
  // `disabled` is a local backend with no auth configured — the normal development case, and the
  // only one where showing content without a token is correct.
  if (status === 'disabled' || status === 'signed-in') return <>{children}</>;
  return <SignedOutExperience />;
}

function SignedOutExperience() {
  const { status, mode } = useAuth();
  const [flow, setFlow] = useState<AuthFlow>('welcome');
  const [entryFlow, setEntryFlow] = useState<EntryFlow>('sign-in');
  // Available from EVERY gate state, not only `unreachable`. Settings lives behind this gate, so a
  // user pointed at the wrong-but-reachable server — a legacy token-mode backend, say, or simply
  // someone else's — could otherwise see a screen with no way forward and no way to Settings.
  const [changingServer, setChangingServer] = useState(false);
  const [sentEmail, setSentEmail] = useState('');

  if (status === 'unreachable' || changingServer) {
    return (
      <ServerUrlRecovery
        onCancel={changingServer ? () => setChangingServer(false) : undefined}
      />
    );
  }

  // A backend on the legacy shared-secret gate. Staging and prod refuse to boot in this mode, so
  // it only reaches a phone pointed at an old or oddly-configured local server — say so plainly
  // rather than offering a Google button that cannot work.
  if (mode !== 'supabase') {
    return <UnsupportedServer onChangeServer={() => setChangingServer(true)} />;
  }

  if (flow === 'welcome') {
    return (
      <Welcome
        onChangeServer={() => setChangingServer(true)}
        onCreate={() => {
          setEntryFlow('create-account');
          setFlow('create-account');
        }}
        onSignIn={() => {
          setEntryFlow('sign-in');
          setFlow('sign-in');
        }}
      />
    );
  }

  if (flow === 'check-inbox') {
    return (
      <CheckInbox
        email={sentEmail}
        onDifferentEmail={() => setFlow(entryFlow)}
        onChangeServer={() => setChangingServer(true)}
      />
    );
  }

  return (
    <EmailEntry
      mode={flow}
      onBack={() => setFlow('welcome')}
      onChangeMode={(next) => {
        setEntryFlow(next);
        setFlow(next);
      }}
      onEmailSent={(email) => {
        setSentEmail(email);
        setFlow('check-inbox');
      }}
    />
  );
}

function Welcome({
  onChangeServer,
  onCreate,
  onSignIn,
}: {
  onChangeServer: () => void;
  onCreate: () => void;
  onSignIn: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { error } = useAuth();
  return (
    <AuthCanvas>
      <View style={styles.welcomeContent}>
        <IconButton
          name="settings"
          accessibilityLabel="Server settings"
          onPress={onChangeServer}
          style={styles.welcomeServerButton}
        />
        <Brand />
        <View style={styles.welcomeCopy}>
          <Text variant="editorial" style={styles.heroTitle}>
            Understand a field,{'\n'}not just a paper.
          </Text>
          <Text variant="body" color={t.muted} style={styles.heroSubtitle}>
            Discover, read, and connect the research that matters.
          </Text>
        </View>
        <ResearchConstellation />
        <View style={styles.welcomeActions}>
          {error ? (
            <View style={styles.welcomeError}>
              <Icon name="alert-circle" size={18} color={t.danger} />
              <View style={common.flex}>
                <Text variant="label" color={t.danger}>
                  That sign-in link couldn’t be used
                </Text>
                <Text variant="caption" color={t.muted} style={{ marginTop: 2 }}>
                  {error} Request a new link below.
                </Text>
              </View>
            </View>
          ) : null}
          <Button title="Get started" onPress={onCreate} />
          <Button
            title="I already have an account"
            variant="ghost"
            onPress={onSignIn}
            style={{ marginTop: space.md }}
          />
        </View>
      </View>
    </AuthCanvas>
  );
}

function EmailEntry({
  mode,
  onBack,
  onChangeMode,
  onEmailSent,
}: {
  mode: EntryFlow;
  onBack: () => void;
  onChangeMode: (mode: EntryFlow) => void;
  onEmailSent: (email: string) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { error, signInWithGoogle, signInWithMagicLink } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'google' | 'magic' | null>(null);
  const creating = mode === 'create-account';

  async function runGoogle() {
    setBusy('google');
    try {
      await signInWithGoogle();
    } finally {
      setBusy(null);
    }
  }

  async function sendLink() {
    const address = email.trim();
    if (!address) return;
    setBusy('magic');
    try {
      if (await signInWithMagicLink(address)) onEmailSent(address);
    } finally {
      setBusy(null);
    }
  }

  return (
    <AuthCanvas>
      <IconButton
        name="chevron-left"
        accessibilityLabel="Back"
        onPress={onBack}
        style={{ marginBottom: space.xl }}
      />

      <Text variant="editorial" style={styles.pageTitle}>
        {creating ? 'Create your account' : 'Welcome back'}
      </Text>
      <Text variant="body" color={t.muted} style={styles.pageSubtitle}>
        {creating
          ? 'Start your research journey with Paradigm.'
          : 'Sign in with a secure email link—no password to remember.'}
      </Text>

      <Text variant="label" color={t.text} style={styles.fieldLabel}>
        Email
      </Text>
      <View style={styles.inputShell}>
        <View style={styles.inputIcon}>
          <Icon name="at-sign" size={15} color={t.mint} />
        </View>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="name@example.com"
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          returnKeyType="send"
          onSubmitEditing={() => void sendLink()}
          style={styles.input}
        />
      </View>

      <Button
        title={creating ? 'Create account' : 'Email me a sign-in link'}
        icon="at-sign"
        onPress={() => void sendLink()}
        loading={busy === 'magic'}
        disabled={busy !== null || !email.trim()}
        style={{ marginTop: space.lg }}
      />

      <View style={styles.orRow}>
        <View style={styles.orLine} />
        <Text variant="caption">or</Text>
        <View style={styles.orLine} />
      </View>

      <GoogleSignInButton
        onPress={() => void runGoogle()}
        loading={busy === 'google'}
        disabled={busy !== null}
      />

      <Pressable
        accessibilityRole="button"
        onPress={() => onChangeMode(creating ? 'sign-in' : 'create-account')}
        style={styles.switchMode}>
        <Text variant="caption" color={t.muted}>
          {creating ? 'Already have an account? ' : 'New to Paradigm? '}
          <Text variant="caption" color={t.mint}>
            {creating ? 'Sign in' : 'Create account'}
          </Text>
        </Text>
      </Pressable>

      {error ? (
        <Text variant="caption" color={t.danger} style={styles.error}>
          {error}
        </Text>
      ) : null}
    </AuthCanvas>
  );
}

function GoogleSignInButton({
  onPress,
  loading,
  disabled,
}: {
  onPress: () => void;
  loading: boolean;
  disabled: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const isDisabled = loading || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Continue with Google"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.googleButton,
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
      ]}>
      <View style={styles.googleButtonContent}>
        <View style={styles.googleLogoBackground}>
          <Image
            testID="google-sign-in-logo"
            source={require('../../assets/brand/google-g-logo.png')}
            resizeMode="contain"
            style={styles.googleLogo}
          />
        </View>
        <Text style={[styles.googleButtonText, { color: t.googleButtonText }]}>
          Continue with Google
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator
          size="small"
          color={t.googleButtonText}
          style={styles.googleButtonSpinner}
        />
      ) : null}
    </Pressable>
  );
}

function CheckInbox({
  email,
  onDifferentEmail,
  onChangeServer,
}: {
  email: string;
  onDifferentEmail: () => void;
  onChangeServer: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { error, retry, signInWithMagicLink } = useAuth();
  const [resending, setResending] = useState(false);
  const [mailError, setMailError] = useState<string | null>(null);

  async function resend() {
    setResending(true);
    try {
      await signInWithMagicLink(email);
    } finally {
      setResending(false);
    }
  }

  async function openEmail() {
    setMailError(null);
    try {
      await Linking.openURL('mailto:');
    } catch {
      setMailError('Could not open an email app on this device.');
    }
  }

  return (
    <AuthCanvas>
      <IconButton
        name="chevron-left"
        accessibilityLabel="Back"
        onPress={onDifferentEmail}
        style={{ marginBottom: space.xl }}
      />
      <Text variant="editorial" style={styles.pageTitle}>
        Check your inbox
      </Text>
      <Text variant="body" color={t.muted} style={styles.pageSubtitle}>
        We sent a secure sign-in link to
      </Text>

      <View style={styles.mailIllustration}>
        <Icon name="mail" size={48} color={t.mint} />
        <View style={styles.mailCheck}>
          <Icon name="check" size={14} color={t.mintInk} />
        </View>
      </View>
      <Text variant="heading" style={styles.sentEmail}>
        {email}
      </Text>
      <Text variant="body" color={t.muted} style={styles.inboxInstruction}>
        Open the link in the email to verify your account and continue.
      </Text>

      <Button
        title="Open email app"
        icon="mail"
        onPress={() => void openEmail()}
        style={{ marginTop: space.xl }}
      />

      <View style={styles.actionList}>
        <ActionRow
          icon="refresh-cw"
          title={resending ? 'Sending…' : 'Resend email'}
          subtitle="Send a fresh sign-in link"
          onPress={() => void resend()}
          disabled={resending}
        />
        <ActionRow
          icon="edit-2"
          title="Use a different email"
          subtitle="Change the address"
          onPress={onDifferentEmail}
        />
        <ActionRow
          icon="external-link"
          title="Change server"
          subtitle="Use another Paradigm server"
          onPress={onChangeServer}
          last
        />
      </View>

      <InfoCard
        icon="shield"
        title="Secure and private"
        body="Links expire quickly and can only be used once."
        accent={t.mint}
      />

      {error || mailError ? (
        <Text variant="caption" color={t.danger} style={styles.error}>
          {mailError ?? error}
        </Text>
      ) : null}

      <Pressable accessibilityRole="button" onPress={retry} style={styles.serverLink}>
        <Text variant="caption" color={t.muted}>
          Already verified?{' '}
          <Text variant="caption" color={t.mint}>
            Check again
          </Text>
        </Text>
      </Pressable>
    </AuthCanvas>
  );
}

function UnsupportedServer({ onChangeServer }: { onChangeServer: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { retry } = useAuth();
  return (
    <AuthCanvas>
      <View style={styles.centerCard}>
        <View style={styles.stateIcon}>
          <Icon name="server" size={28} color={t.mint} />
        </View>
        <Text variant="editorial" style={{ textAlign: 'center' }}>
          Sign-in not available
        </Text>
        <Text variant="body" color={t.muted} style={styles.stateBody}>
          This server uses a shared access token, which this app cannot enter. Point it at a server
          using Supabase sign-in, or run the backend without authentication.
        </Text>
        <Button title="Check again" onPress={retry} />
        <Button
          title="Change server"
          variant="ghost"
          onPress={onChangeServer}
          style={{ marginTop: space.md }}
        />
      </View>
    </AuthCanvas>
  );
}

/** Shown when the backend cannot be reached: the reason, plus the one setting that can fix it. */
function ServerUrlRecovery({ onCancel }: { onCancel?: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { retry } = useAuth();
  const [url, setUrl] = useState(getBaseUrl());
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await setBaseUrl(url);
      retry();
    } finally {
      setSaving(false);
    }
  }

  return (
    <AuthCanvas>
      <View style={styles.centerCard}>
        {onCancel ? (
          <IconButton
            name="chevron-left"
            accessibilityLabel="Back"
            onPress={onCancel}
            style={{ alignSelf: 'flex-start', marginBottom: space.xl }}
          />
        ) : null}
        <View style={styles.stateIcon}>
          <Icon name="wifi-off" size={28} color={t.mint} />
        </View>
        <Text variant="editorial" style={{ textAlign: 'center' }}>
          Can’t reach the server
        </Text>
        <Text variant="body" color={t.muted} style={styles.stateBody}>
          {getBaseUrl()
            ? `No response from ${getBaseUrl()}. Check the backend is running, or correct the address below.`
            : 'No server address is set yet. Enter one to connect.'}
        </Text>
        <View style={styles.inputShell}>
          <View style={styles.inputIcon}>
            <Icon name="server" size={15} color={t.mint} />
          </View>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="https://…"
            placeholderTextColor={t.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
          />
        </View>
        <Button
          title="Save & connect"
          onPress={() => void save()}
          loading={saving}
          disabled={!url.trim()}
          style={{ marginTop: space.lg }}
        />
        <Button
          title="Try again"
          variant="ghost"
          onPress={retry}
          style={{ marginTop: space.md }}
        />
      </View>
    </AuthCanvas>
  );
}

function AuthCanvas({ children }: { children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Screen edges={['top', 'bottom']} style={styles.canvas}>
      <View pointerEvents="none" style={styles.warmGlow} />
      <View pointerEvents="none" style={styles.mintGlow} />
      <KeyboardAvoidingView
        style={common.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Brand() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.brand}>
      <Text
        variant="serifTitle"
        color={t.mint}
        style={{ fontSize: 31, lineHeight: 36, fontFamily: fonts.serifSemiBold }}>
        P
      </Text>
      <Text variant="title" color={t.mint} style={{ fontFamily: fonts.bodyBold }}>
        Paradigm
      </Text>
    </View>
  );
}

function ResearchConstellation() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessibilityLabel="Connected research papers" style={styles.constellation}>
      <ConstellationLine x={58} y={42} width={111} rotate={25} />
      <ConstellationLine x={151} y={38} width={104} rotate={48} />
      <ConstellationLine x={63} y={104} width={104} rotate={-22} />
      <ConstellationLine x={156} y={104} width={115} rotate={14} />
      <ConstellationLine x={149} y={65} width={92} rotate={90} />
      <ConstellationNode x={132} y={60} size={58} iconSize={23} />
      <ConstellationNode x={38} y={31} size={38} iconSize={15} />
      <ConstellationNode x={246} y={93} size={43} iconSize={17} />
      <ConstellationNode x={146} y={11} size={32} iconSize={13} />
      <ConstellationNode x={149} y={145} size={30} iconSize={12} />
      <View style={[styles.constellationDot, { left: 10, top: 96 }]} />
      <View
        style={[
          styles.constellationDot,
          { left: 277, top: 41, backgroundColor: t.violet },
        ]}
      />
      <View style={[styles.constellationDot, { left: 90, top: 162 }]} />
    </View>
  );
}

function ConstellationLine({
  x,
  y,
  width,
  rotate,
}: {
  x: number;
  y: number;
  width: number;
  rotate: number;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[
        styles.constellationLine,
        { left: x, top: y, width, transform: [{ rotate: `${rotate}deg` }] },
      ]}
    />
  );
}

function ConstellationNode({
  x,
  y,
  size,
  iconSize,
}: {
  x: number;
  y: number;
  size: number;
  iconSize: number;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[
        styles.constellationNode,
        { left: x, top: y, width: size, height: size, borderRadius: size / 2 },
      ]}>
      <Icon name="file-text" size={iconSize} color={t.mint} />
    </View>
  );
}

function InfoCard({
  icon,
  title,
  body,
  accent,
}: {
  icon: IconName;
  title: string;
  body: string;
  accent: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.infoCard}>
      <View style={[styles.infoAccent, { backgroundColor: accent }]} />
      <Icon name={icon} size={19} color={accent} />
      <View style={common.flex}>
        <Text variant="heading" color={accent}>
          {title}
        </Text>
        <Text variant="caption" color={t.muted} style={{ marginTop: space.xs }}>
          {body}
        </Text>
      </View>
    </View>
  );
}

function ActionRow({
  icon,
  title,
  subtitle,
  onPress,
  disabled,
  last,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  onPress: () => void;
  disabled?: boolean;
  last?: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionRow,
        !last && styles.actionDivider,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}>
      <View style={styles.actionIcon}>
        <Icon name={icon} size={17} color={t.mint} />
      </View>
      <View style={common.flex}>
        <Text variant="heading">{title}</Text>
        <Text variant="caption" color={t.muted}>
          {subtitle}
        </Text>
      </View>
      <Icon name="chevron-right" size={19} color={t.muted} />
    </Pressable>
  );
}

const common = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

const makeStyles = (t: ThemePalette) =>
  StyleSheet.create({
    canvas: { overflow: 'hidden' },
    warmGlow: {
      position: 'absolute',
      width: 280,
      height: 280,
      borderRadius: 140,
      left: -110,
      top: 18,
      backgroundColor: t.bgGlow,
      opacity: 0.72,
    },
    mintGlow: {
      position: 'absolute',
      width: 250,
      height: 250,
      borderRadius: 125,
      right: -115,
      top: 270,
      backgroundColor: t.mintWash,
      opacity: 0.42,
    },
    scrollContent: {
      flexGrow: 1,
      paddingHorizontal: space.xl,
      paddingTop: space.lg,
      paddingBottom: space.xxl,
    },
    welcomeContent: { flex: 1, paddingTop: 54 },
    welcomeServerButton: { position: 'absolute', right: 0, top: 0 },
    brand: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.sm,
    },
    welcomeCopy: { marginTop: space.xxl, alignItems: 'center' },
    heroTitle: {
      fontSize: 34,
      lineHeight: 40,
      textAlign: 'center',
      fontFamily: fonts.serifMedium,
    },
    heroSubtitle: {
      marginTop: space.lg,
      textAlign: 'center',
      maxWidth: 305,
      alignSelf: 'center',
    },
    constellation: {
      width: 305,
      height: 185,
      alignSelf: 'center',
      marginTop: space.xxl,
      position: 'relative',
    },
    constellationLine: {
      position: 'absolute',
      height: 1.5,
      borderRadius: 1,
      backgroundColor: t.mint,
      opacity: 0.42,
    },
    constellationNode: {
      position: 'absolute',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1.5,
      borderColor: t.mint,
      backgroundColor: t.surface,
    },
    constellationDot: {
      position: 'absolute',
      width: 11,
      height: 11,
      borderRadius: 6,
      backgroundColor: t.mint,
      opacity: 0.42,
    },
    welcomeActions: { marginTop: 'auto', paddingBottom: space.xxl },
    welcomeError: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: space.sm,
      padding: space.md,
      marginBottom: space.md,
      borderWidth: 1,
      borderColor: t.danger,
      borderRadius: radius.md,
      backgroundColor: t.dangerWash,
    },
    pageTitle: { fontSize: 34, lineHeight: 40 },
    pageSubtitle: { marginTop: space.sm, marginBottom: space.xl },
    fieldLabel: { marginBottom: space.sm, fontFamily: fonts.bodyMedium },
    inputShell: {
      minHeight: 60,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.elevated,
      borderWidth: 1,
      borderColor: t.line2,
      borderRadius: radius.md,
      paddingHorizontal: space.md,
    },
    inputIcon: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.mintWash,
      marginRight: space.sm,
    },
    input: {
      flex: 1,
      alignSelf: 'stretch',
      color: t.text,
      fontFamily: fonts.body,
      fontSize: 15,
    },
    googleButton: {
      height: 50,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: t.googleButtonBorder,
      borderRadius: radius.pill,
      backgroundColor: t.googleButtonBg,
      paddingHorizontal: 12,
    },
    googleButtonContent: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
    },
    googleLogoBackground: {
      width: 20,
      height: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.googleLogoBg,
    },
    googleLogo: { width: 18, height: 18 },
    googleButtonText: {
      fontFamily: fonts.googleButton,
      fontSize: 14,
      lineHeight: 20,
    },
    googleButtonSpinner: { position: 'absolute', right: 12 },
    orRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      marginVertical: space.xl,
    },
    orLine: { flex: 1, height: 1, backgroundColor: t.line },
    switchMode: { alignItems: 'center', paddingVertical: space.xl },
    infoCard: {
      minHeight: 92,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: space.md,
      borderWidth: 1,
      borderColor: t.line,
      borderRadius: radius.md,
      backgroundColor: t.surface,
      padding: space.lg,
      overflow: 'hidden',
    },
    infoAccent: {
      position: 'absolute',
      left: 0,
      top: space.lg,
      bottom: space.lg,
      width: 3,
      borderRadius: 2,
    },
    error: { textAlign: 'center', marginTop: space.md },
    serverLink: { alignItems: 'center', paddingVertical: space.xl },
    mailIllustration: {
      width: 112,
      height: 112,
      borderRadius: 56,
      alignSelf: 'center',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.mintWash,
      marginTop: space.lg,
    },
    mailCheck: {
      position: 'absolute',
      right: 13,
      bottom: 16,
      width: 26,
      height: 26,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.mint,
      borderWidth: 2,
      borderColor: t.surface,
    },
    sentEmail: { textAlign: 'center', marginTop: space.lg },
    inboxInstruction: {
      textAlign: 'center',
      marginTop: space.sm,
      maxWidth: 310,
      alignSelf: 'center',
    },
    actionList: {
      marginTop: space.lg,
      borderWidth: 1,
      borderColor: t.line2,
      borderRadius: radius.md,
      backgroundColor: t.surface,
      overflow: 'hidden',
    },
    actionRow: {
      minHeight: 64,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
    },
    actionDivider: { borderBottomWidth: 1, borderBottomColor: t.line },
    actionIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.mintWash,
    },
    pressed: { opacity: 0.82 },
    disabled: { opacity: 0.5 },
    centerCard: { flex: 1, justifyContent: 'center', paddingBottom: space.xxl },
    stateIcon: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'center',
      backgroundColor: t.mintWash,
      marginBottom: space.lg,
    },
    stateBody: {
      textAlign: 'center',
      marginTop: space.md,
      marginBottom: space.xl,
    },
  });
