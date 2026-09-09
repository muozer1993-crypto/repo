import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text as RNText, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { OfflineBanner } from '@/components/OfflineBanner';
import { ToastProvider } from '@/components/Toast';
import { queryClient } from '@/lib/query';
import { NotificationBridge } from '@/providers/NotificationBridge';
import { useAuth } from '@/store/auth';
import { Colors } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Expo Router renders this instead of a red box when a screen below the root
 * throws — including while its module is being evaluated. Deliberately built
 * out of nothing but react-native and the colour tokens: if a component or a
 * service is what blew up, the error screen must not import it and blow up too.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={styles.errorRoot}>
      <ScrollView contentContainerStyle={styles.errorBody}>
        <RNText style={styles.errorTitle}>KOYDUM çuvalladı</RNText>
        <RNText style={styles.errorLead}>
          Bir ekran açılamadı. Aşağıdaki yazıyı bize gösterirsen ne olduğunu anlarız.
        </RNText>
        <RNText style={styles.errorDetail} selectable>
          {error?.message ?? 'Bilinmeyen hata'}
        </RNText>
        <Pressable style={styles.errorButton} onPress={retry}>
          <RNText style={styles.errorButtonText}>Tekrar dene</RNText>
        </Pressable>
      </ScrollView>
    </View>
  );
}

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
            <OfflineBanner />
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  splash: { flex: 1, backgroundColor: Colors.bg },
  errorRoot: { flex: 1, backgroundColor: Colors.bg },
  errorBody: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 14 },
  errorTitle: { color: Colors.text, fontSize: 26, fontWeight: '800' },
  errorLead: { color: Colors.textMuted, fontSize: 15, lineHeight: 22 },
  errorDetail: {
    color: Colors.danger,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  errorButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: Colors.accent,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
  },
  errorButtonText: { color: Colors.bg, fontSize: 15, fontWeight: '800' },
});
