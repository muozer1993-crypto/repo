import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/Text';
import { useConnection } from '@/hooks/useConnection';
import { useAuth } from '@/store/auth';
import { Colors, Spacing } from '@/theme';

/**
 * A thin strip under the status bar when the server cannot be reached. Tapping
 * it opens the server-address screen, because on a home network that is almost
 * always the actual problem.
 */
export function OfflineBanner() {
  const { online, checked } = useConnection();
  // (auth) is guarded off once a token exists, so a signed-in user has to go
  // through Ayarlar to change the address
  const signedIn = useAuth((state) => !!state.token);
  if (!checked || online) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Sunucuya ulaşılamıyor, adresi düzenle"
      onPress={() => router.push(signedIn ? '/settings' : '/(auth)/server')}
      style={styles.wrap}>
      <View style={styles.dot} />
      <Text variant="micro" color={Colors.white} numberOfLines={1} style={styles.text}>
        Sunucuya bağlanamıyorum. Girdiklerin kaydedildi, bağlanınca gönderilir. Adresi düzelt →
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.dangerDim,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 6,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.danger },
  text: { flex: 1 },
});
