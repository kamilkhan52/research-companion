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
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack, usePathname } from 'expo-router';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { loadConfig } from '@/api/config';
import { queryClient } from '@/api/queryClient';
import { AudioProvider } from '@/audio/AudioProvider';
import { NowPlaying } from '@/components/NowPlaying';
import { ProjectProvider } from '@/store/project';
import { ListeningProvider } from '@/store/listening';
import { colors } from '@/theme/tokens';

SplashScreen.preventAutoHideAsync().catch(() => {});

// The four tab screens render NowPlaying inside the tab bar (above the tab row); the root
// copy covers only stack screens pushed over the tabs, so the card never doubles up.
const TAB_PATHS = new Set(['/', '/discover', '/notes', '/graph']);

function StackNowPlaying() {
  const pathname = usePathname();
  if (TAB_PATHS.has(pathname)) return null;
  return <NowPlaying />;
}

export default function RootLayout() {
  const [configLoaded, setConfigLoaded] = useState(false);
  const [fontsLoaded] = useFonts({
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
      <SafeAreaProvider>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <ProjectProvider>
              <ListeningProvider>
                <AudioProvider>
                <StatusBar style="light" />
                <View style={{ flex: 1, backgroundColor: colors.bg }}>
                  <View style={{ flex: 1 }}>
                    <Stack
                      screenOptions={{
                        headerShown: false,
                        contentStyle: { backgroundColor: colors.bg },
                        animation: 'slide_from_right',
                      }}>
                      <Stack.Screen name="(tabs)" />
                      <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
                      <Stack.Screen
                        name="player"
                        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                      />
                    </Stack>
                  </View>
                  <StackNowPlaying />
                </View>
                </AudioProvider>
              </ListeningProvider>
            </ProjectProvider>
          </QueryClientProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
