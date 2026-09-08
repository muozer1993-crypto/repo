import { Stack } from 'expo-router';

import { Colors } from '@/theme';

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Colors.bg },
      }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="challenge/new" options={{ presentation: 'modal' }} />
      <Stack.Screen name="challenge/[id]/entry" options={{ presentation: 'modal' }} />
      <Stack.Screen name="challenge/[id]/taunt" options={{ presentation: 'modal' }} />
      <Stack.Screen name="settings" />
    </Stack>
  );
}
