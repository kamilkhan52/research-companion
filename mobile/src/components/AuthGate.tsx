// Stands between the app and its content whenever the backend demands authentication.
//
// The states are deliberately four, not two. "I don't know yet" must not render a sign-in form
// (it would flash on every cold start), and "I can't reach the server" must not render one either
// — telling someone to sign in when the real problem is a wrong server URL or a stopped backend
// sends them to fix the wrong thing, and there is no password they can type that will help.

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
import { MIN_PASSWORD_LENGTH, useAuth } from '@/auth/AuthProvider';
import { AccountDeletionGuard } from '@/components/AccountDeletionGuard';
import { Button, Card, Icon, IconButton, Screen, Text, type IconName } from '@/ui';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';

/** Whether to offer the "change server" controls at all.
 *
 *  Kamil's device-pass note: these are development affordances — pointing the app at localhost,
 *  the tailnet, or a quick tunnel — and a released build has exactly one correct server baked
 *  into app.json. Showing a reader a server-URL field invites them to break their own install.
 *
 *  Gated on `__DEV__`, a BUILD-time constant, and deliberately not on the backend's `dev` flag
 *  from /api/health: that flag can only be read from a server we can reach, and the one moment
 *  a server control could matter is when we cannot reach one. A server-provided gate would be
 *  unreadable in exactly the state it is meant to govern. */
const SERVER_TOOLS_VISIBLE = __DEV__;

type AuthFlow = 'welcome' | 'sign-in' | 'create-account' | 'check-inbox';
type EntryFlow = Extract<AuthFlow, 'sign-in' | 'create-account'>;

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, accountDeleted } = useAuth();

  if (status === 'unknown') {
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={common.centered}>
          <ActivityIndicator />
        </View>
      </Screen>
    );
  }
  if (status === 'cleanup-required') return <LocalCleanupRequired />;
  // After `cleanup-required`, because an incomplete purge is the more urgent thing to say. Before
  // everything else, because the alternative is what this exists to stop: the completion screen
  // flashes past and the user lands on the sign-in form, with no durable confirmation that an
  // irreversible action worked — and an invitation to create a fresh empty account under the same
  // address, since Supabase sign-up is self-service.
  if (accountDeleted) return <AccountDeleted />;
  // `disabled` is a local backend with no auth configured — the normal development case, and the
  // only one where showing content without a token is correct.
  if (status === 'disabled') return <>{children}</>;
  if (status === 'signed-in') {
    return <AccountDeletionGuard>{children}</AccountDeletionGuard>;
  }
  return <SignedOutExperience />;
}

function LocalCleanupRequired() {
  const t = useTheme();
  const { error, retry } = useAuth();
  return (
    <Screen edges={['top', 'bottom']}>
      <View style={common.centered}>
        <Card style={{ margin: space.xl }}>
          <Icon name="alert-triangle" size={28} color={t.danger} />
          <Text variant="title" style={{ marginTop: space.lg }}>
            Local data needs attention
          </Text>
          <Text color={t.muted} style={{ marginTop: space.sm }}>
            {error ?? 'Some deleted-account data could not be cleared from this device.'}
          </Text>
          <Text variant="caption" color={t.muted} style={{ marginTop: space.md }}>
            Seminar will not load private content while cleanup is incomplete. Clear the app’s
            storage in device settings, or try the cleanup again.
          </Text>
          <Button title="Try cleanup again" onPress={retry} style={{ marginTop: space.lg }} />
        </Card>
      </View>
    </Screen>
  );
}

/** Terminal acknowledgement of a completed deletion. Deliberately plain — it is seen once, by
 *  someone who is leaving. Reuses `UnsupportedServer`'s layout rather than introducing styles. */
function AccountDeleted() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { dismissAccountDeleted } = useAuth();
  return (
    <AuthCanvas>
      <View style={styles.centerCard}>
        <View style={styles.stateIcon}>
          <Icon name="check" size={28} color={t.mint} />
        </View>
        <Text variant="editorial" style={{ textAlign: 'center' }}>
          Your account was deleted
        </Text>
        <Text variant="body" color={t.muted} style={styles.stateBody}>
          Your projects, papers, notes, and sign-in have been permanently removed. Nothing is kept
          on this device.
        </Text>
        <Button title="Done" onPress={dismissAccountDeleted} />
      </View>
    </AuthCanvas>
  );
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

  // In development this is the editable URL field. In a release build it must NOT be: the server
  // is baked into app.json, and letting someone save a different one here is how they strand
  // themselves — a wrong-but-reachable URL leaves them on a screen whose escape hatches are all
  // hidden (welcome gear, unsupported-server button, Settings). Not offering the edit is what
  // makes the stranded state unreachable, rather than adding another way out of it.
  if (status === 'unreachable' || changingServer) {
    return SERVER_TOOLS_VISIBLE ? (
      <ServerUrlRecovery
        onCancel={changingServer ? () => setChangingServer(false) : undefined}
      />
    ) : (
      <ServerUnreachable />
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
  const localDataWarning = error?.includes('Clear the app') ?? false;
  return (
    <AuthCanvas>
      <View style={styles.welcomeContent}>
        {SERVER_TOOLS_VISIBLE ? (
          <IconButton
            name="settings"
            accessibilityLabel="Server settings"
            onPress={onChangeServer}
            style={styles.welcomeServerButton}
          />
        ) : null}
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
                  {localDataWarning
                    ? 'Local data needs attention'
                    : 'That sign-in link couldn’t be used'}
                </Text>
                <Text variant="caption" color={t.muted} style={{ marginTop: 2 }}>
                  {error}{localDataWarning ? '' : ' Request a new link below.'}
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
  const {
    error, signInWithGoogle, signInWithMagicLink,
    signInWithPassword, signUpWithPassword, sendPasswordReset,
  } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'google' | 'magic' | 'password' | 'reset' | null>(null);
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
    setNotice(null);
    setBusy('magic');
    try {
      if (await signInWithMagicLink(address)) onEmailSent(address);
    } finally {
      setBusy(null);
    }
  }

  async function submitPassword() {
    const address = email.trim();
    if (!address || !password) return;
    setNotice(null);
    setBusy('password');
    try {
      if (!creating) {
        await signInWithPassword(address, password);
        return;   // a success flips the whole gate; a failure surfaces through `error`
      }
      const result = await signUpWithPassword(address, password);
      if (result === 'already-registered') {
        // No mail was sent and none is coming, so "check your inbox" would be a lie. Move them to
        // the sign-in form with the address they typed still in place. The reset hint matters:
        // an account created by magic link or Google has no password to sign in with yet.
        onChangeMode('sign-in');
        setNotice(
          `${address} already has an account. Sign in below — or use “Forgot your password?” to `
          + 'set a password if you have only ever used a sign-in link or Google.',
        );
        return;
      }
      if (result === 'confirm-email') {
        // NOT a sign-in. The account exists but is inert until the address is confirmed, so
        // sending the user back to a password field would just reject the password they chose.
        onEmailSent(address);
      }
    } finally {
      setBusy(null);
    }
  }

  async function forgotPassword() {
    const address = email.trim();
    if (!address) {
      setNotice('Enter your email address first.');
      return;
    }
    setNotice(null);
    setBusy('reset');
    try {
      if (await sendPasswordReset(address)) {
        // Deliberately says nothing about whether that address has an account — the response is
        // identical either way, so this message must be too.
        setNotice(`If ${address} has an account, a reset link is on its way.`);
      }
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
          ? 'Start your research journey with Seminar.'
          : 'Sign in with your password, or have us email you a link.'}
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
          returnKeyType="next"
          style={styles.input}
        />
      </View>

      <Text variant="label" color={t.text} style={styles.fieldLabel}>
        Password
      </Text>
      <View style={styles.inputShell}>
        <View style={styles.inputIcon}>
          <Icon name="lock" size={15} color={t.mint} />
        </View>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder={creating ? `At least ${MIN_PASSWORD_LENGTH} characters` : 'Your password'}
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          // `newPassword` lets a password manager offer to generate and save one; `password` on
          // sign-in lets it autofill. Getting these backwards is why saved credentials sometimes
          // never reappear.
          textContentType={creating ? 'newPassword' : 'password'}
          returnKeyType="go"
          onSubmitEditing={() => void submitPassword()}
          style={styles.input}
        />
      </View>

      <Button
        title={creating ? 'Create account' : 'Sign in'}
        icon="lock"
        onPress={() => void submitPassword()}
        loading={busy === 'password'}
        disabled={busy !== null || !email.trim() || !password}
        style={{ marginTop: space.lg }}
      />

      <Button
        title="Email me a sign-in link instead"
        icon="at-sign"
        variant="ghost"
        onPress={() => void sendLink()}
        loading={busy === 'magic'}
        disabled={busy !== null || !email.trim()}
        style={{ marginTop: space.sm }}
      />

      {!creating ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void forgotPassword()}
          disabled={busy !== null}
          style={styles.switchMode}>
          <Text variant="caption" color={t.mint}>
            {busy === 'reset' ? 'Sending…' : 'Forgot your password?'}
          </Text>
        </Pressable>
      ) : null}

      {notice ? (
        <Text variant="caption" color={t.muted} style={styles.error}>
          {notice}
        </Text>
      ) : null}

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
          {creating ? 'Already have an account? ' : 'New to Seminar? '}
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

  async function resend() {
    setResending(true);
    try {
      await signInWithMagicLink(email);
    } finally {
      setResending(false);
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

      {/* No "Open email app" button. `Linking.openURL('mailto:')` is a COMPOSE intent, not an
          inbox one — on Outlook it opened a blank new-message screen, which is the opposite of
          what someone waiting for a verification link needs. Android exposes no portable
          open-my-inbox intent, so the honest move is to not offer the button at all. */}

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
          // Closes the list when the development-only "Change server" row below is absent —
          // otherwise ActionRow keeps drawing a divider under the last visible row.
          last={!SERVER_TOOLS_VISIBLE}
        />
        {SERVER_TOOLS_VISIBLE ? (
          <ActionRow
            icon="external-link"
            title="Change server"
            subtitle="Use another Scholiast server"
            onPress={onChangeServer}
            last
          />
        ) : null}
      </View>


      {error ? (
        <Text variant="caption" color={t.danger} style={styles.error}>
          {error}
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
        {SERVER_TOOLS_VISIBLE ? (
          <Button
            title="Change server"
            variant="ghost"
            onPress={onChangeServer}
            style={{ marginTop: space.md }}
          />
        ) : null}
      </View>
    </AuthCanvas>
  );
}

/** Shown when the backend cannot be reached: the reason, plus the one setting that can fix it. */
/** The release-build answer to "cannot reach the server".
 *
 *  Deliberately has NO url field. The server is baked into app.json, so an unreachable server is
 *  an outage or a dead network — not something the reader can fix by typing. Offering an editor
 *  here only lets them save a wrong URL and strand themselves somewhere with no way back. */
function ServerUnreachable() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { retry } = useAuth();
  return (
    <AuthCanvas>
      <View style={styles.centerCard}>
        <View style={styles.stateIcon}>
          <Icon name="alert-triangle" size={28} color={t.amber} />
        </View>
        <Text variant="editorial" style={{ textAlign: 'center' }}>
          Can’t reach Seminar
        </Text>
        <Text variant="body" color={t.muted} style={styles.stateBody}>
          Check your connection and try again. If this keeps happening, the service may be
          temporarily unavailable.
        </Text>
        <Button title="Try again" onPress={retry} />
      </View>
    </AuthCanvas>
  );
}

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
        S
      </Text>
      <Text variant="title" color={t.mint} style={{ fontFamily: fonts.bodyBold }}>
        Seminar
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
