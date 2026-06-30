import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { loadConfig } from '@/api/config';
import { queryClient } from '@/api/queryClient';
import { ProjectProvider } from '@/store/project';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [booted, setBooted] = useState(false);

  // Load persisted base URL + auth token before any request fires.
  useEffect(() => {
    loadConfig().finally(() => setBooted(true));
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ProjectProvider>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <AnimatedSplashOverlay />
          {booted && <AppTabs />}
        </ThemeProvider>
      </ProjectProvider>
    </QueryClientProvider>
  );
}
