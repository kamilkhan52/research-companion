import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
} from '@expo-google-fonts/manrope';
import {
  Newsreader_400Regular,
  Newsreader_400Regular_Italic,
  Newsreader_500Medium,
  Newsreader_500Medium_Italic,
  Newsreader_600SemiBold,
} from '@expo-google-fonts/newsreader';
import { Feather } from '@expo/vector-icons';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
// Theme APIs come from expo-router itself: as of SDK 56 the bundler rejects any direct
// `@react-navigation/*` import in application code (expo-router vendors react-navigation).
import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider as NavThemeProvider,
  usePathname,
} from 'expo-router';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';

import { loadConfig } from '@/api/config';
import { useActiveQueryClient } from '@/api/queryClient';
import { AudioProvider } from '@/audio/AudioProvider';
import { PaperSummaryOfferHost } from '@/components/PaperSummaryOffer';
import { ExistingPaperOfferHost } from '@/components/ExistingPaperOffer';
import { NowPlaying } from '@/components/NowPlaying';
import { PaperEntityProvider } from '@/components/PaperEntityProvider';
import { SpendRefusalHost } from '@/components/SpendRefusalSheet';
import { shouldShowStackNowPlaying } from '@/lib/nowPlayingVisibility';
import { useDevMode } from '@/api/queries';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { AuthGate } from '@/components/AuthGate';
import { ProjectProvider } from '@/store/project';
import { ListeningProvider } from '@/store/listening';
import { GraphSettingsProvider } from '@/store/graphSettings';
import { ThemeProvider, useThemeMode } from '@/theme/ThemeProvider';
import { ToastProvider } from '@/ui/Toast';

SplashScreen.preventAutoHideAsync().catch(() => {});

// The four tab screens render NowPlaying inside the tab bar (above the tab row); the root
// copy covers only stack screens pushed over the tabs, so the card never doubles up.
function DevTestOverlay() {
  // Dev builds only, twice over: the server's RC_DEV flag is the runtime gate (production
  // reports dev:false, and every /api/devtest route 404s there regardless), and the __DEV__
  // guard keeps the component — and react-native-view-shot — out of the release bundle
  // entirely (Metro strips the conditional require when __DEV__ is false).
  const dev = useDevMode();
  if (!__DEV__ || !dev) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DevTestBubble } = require('@/components/DevTestBubble');
  return <DevTestBubble />;
}

function StackNowPlaying() {
  const pathname = usePathname();
  if (!shouldShowStackNowPlaying(pathname)) return null;
  return <NowPlaying />;
}

// Everything below the ThemeProvider that must repaint with the active palette: status bar
// icons, the navigator's own theme (screen/transition backgrounds — the default dark
// contentStyle otherwise flashes during pushes on Light), the root native view
// (expo-system-ui — the flash surface behind modals/over-scroll), and the Android
// navigation bar.
function ThemedShell() {
  const { theme, themeName } = useThemeMode();
  const isLight = themeName === 'light';

  useEffect(() => {
    // Paints the root native view — the flash surface behind modals, keyboard dismissal and
    // over-scroll. On edge-to-edge Android (SDK 54) the transparent navigation bar rides
    // this same background, so no separate nav-bar color is needed. try/catch on top of
    // .catch: on a dev build predating this native module the CALL itself throws
    // synchronously — the JS must keep working over Metro until the next build bakes it in.
    try {
      SystemUI.setBackgroundColorAsync(theme.bg).catch(() => {});
    } catch { /* native module absent in older dev builds */ }
  }, [theme]);

  const navTheme = useMemo(() => {
    const base = isLight ? DefaultTheme : DarkTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: theme.mint,
        background: theme.bg,
        card: theme.surface,
        text: theme.text,
        border: theme.line2,
        notification: theme.danger,
      },
    };
  }, [theme, isLight]);

  return (
    <NavThemeProvider value={navTheme}>
      <StatusBar style={isLight ? 'dark' : 'light'} />
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <View style={{ flex: 1 }}>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: theme.bg },
              animation: 'slide_from_right',
            }}>
            <Stack.Screen name="(tabs)" />
            {/* The sign-in callback lands here before bouncing home. No animation: it is a
                transit screen, and sliding it in makes a successful sign-in look like a
                navigation the user did not ask for. */}
            <Stack.Screen name="auth" options={{ animation: 'none' }} />
            <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
            <Stack.Screen name="delete-account" />
            <Stack.Screen
              name="player"
              options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
            />
          </Stack>
        </View>
        <StackNowPlaying />
        <DevTestOverlay />
        {/* Cross-project duplicate preflight raised by useAddPaper from every add surface. */}
        <ExistingPaperOfferHost />
        {/* Global "start the paper summary?" offer, raised by useAddPaper from any add site. */}
        <PaperSummaryOfferHost />
        {/* 402/429 admission refusals interrupt the action that caused them, app-wide. */}
        <SpendRefusalHost />
      </View>
    </NavThemeProvider>
  );
}

/** Everything below ProjectProvider holds account-derived in-memory state. Key the boundary to
 *  the Supabase subject so a direct A -> B auth event remounts it even if React batches away the
 *  brief `unknown` gate state. Persisted account state is cleared before `userId` changes. */
function AccountScopedApp() {
  const { userId } = useAuth();
  return (
    <AuthGate>
      <ProjectProvider key={userId ?? 'no-account'}>
        <ListeningProvider>
          <GraphSettingsProvider>
          <AudioProvider>
          <BottomSheetModalProvider>
          <PaperEntityProvider>
          <ThemedShell />
          </PaperEntityProvider>
          </BottomSheetModalProvider>
          </AudioProvider>
          </GraphSettingsProvider>
        </ListeningProvider>
      </ProjectProvider>
    </AuthGate>
  );
}

export default function RootLayout() {
  const [configLoaded, setConfigLoaded] = useState(false);
  // This snapshot rotates for both server and account transitions. Module-level completion
  // chains read the same active object, so their invalidations always target the rendered cache.
  const queryClient = useActiveQueryClient();
  const [fontsLoaded] = useFonts({
    GoogleSans_500Medium: require('../../assets/brand/GoogleSans-Medium.ttf'),
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Newsreader_400Regular,
    Newsreader_400Regular_Italic,
    Newsreader_500Medium,
    Newsreader_500Medium_Italic,
    Newsreader_600SemiBold,
    ...Feather.font,
  });

  useEffect(() => {
    loadConfig().finally(() => setConfigLoaded(true));
  }, []);

  const ready = fontsLoaded && configLoaded;
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return null;

  return (
    // Wrapped explicitly at the true app root (rather than relying on expo-router's internal
    // stack-swipe wrapper, which only covers its own screen transitions) so any screen can use
    // the modern Gesture API (GestureDetector) safely — needed by the reference-graph's
    // pan/zoom canvas. Pure JS: react-native-gesture-handler is already linked into the build.
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* initialMetrics makes the provider's very first frame (app cold start) carry real
          insets instead of zeros — the same class of flash U.16 fixed per-screen. */}
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        {/* ThemeProvider gates on the persisted mode (read before first paint, under the
            splash) so everything below — including the Toast overlay — renders themed. */}
        <ThemeProvider>
        {/* ToastProvider sits just inside the SafeAreaProvider so its overlay reads real insets
            and floats above every screen (R.8). */}
        <ToastProvider>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
            {/* The gate sits ABOVE every API and audio consumer, not just above the screens.
                PaperEntityProvider fetches project state and AudioProvider restores tracks with
                auth headers on mount — below the gate they cannot fire a protected request with a
                stale cached token while Supabase is still restoring the session, which on an
                overnight cold start would cache a 401 or break audio restoration. */}
            {/* Portal hosts stay inside query/project/listening/audio contexts. The modal
                provider remains outside PaperEntityProvider because that provider's app-wide
                RelatedWorksSheet needs BottomSheetModalInternalContext at launch. */}
            <AccountScopedApp />
            </AuthProvider>
          </QueryClientProvider>
        </KeyboardProvider>
        </ToastProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
