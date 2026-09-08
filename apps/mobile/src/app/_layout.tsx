import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/Toast';
import { queryClient } from '@/lib/query';
import { NotificationBridge } from '@/providers/NotificationBridge';
import { useAuth } from '@/store/auth';
import { Colors } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const hydrated = useAuth((s) => s.hydrated);
  const hydrate = useAuth((s) => s.hydrate);
  const token = useAuth((s) => s.token);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (hydrated) SplashScreen.hideAsync().catch(() => {});
  }, [hydrated]);

  if (!hydrated) {
    return <View style={styles.splash} />;
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <StatusBar style="light" />
            <NotificationBridge />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: Colors.bg },
                animation: Platform.OS === 'web' ? 'none' : 'default',
              }}>
              <Stack.Protected guard={!token}>
                <Stack.Screen name="(auth)" />
              </Stack.Protected>

              <Stack.Protected guard={!!token}>
                <Stack.Screen name="(app)" />
                <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
              </Stack.Protected>
            </Stack>
          </ToastProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** Sends the user to the right stack whenever the session appears or disappears. */
export function useSessionRedirect(token: string | null) {
  useEffect(() => {
    router.replace(token ? '/(app)/(tabs)' : '/(auth)/login');
  }, [token]);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  splash: { flex: 1, backgroundColor: Colors.bg },
});
