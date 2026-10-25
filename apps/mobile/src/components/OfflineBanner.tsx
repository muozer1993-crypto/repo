import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/Text';
import { useConnection } from '@/hooks/useConnection';
import { serverUrlIsEditable } from '@/lib/config';
import { useAuth } from '@/store/auth';
import { Colors, Spacing } from '@/theme';

/**
 * A thin strip at the top of the app when the server cannot be reached. Tapping
 * it opens the server-address screen, because on a home network that is almost
 * always the actual problem.
 *
 * Signed in and gone for minutes, the likeliest story is `npm run internet`
 * restarted under a new tunnel address. Only the friend who runs it knows the
 * new one, so the strip says to ask for the new link, which Ayarlar → Sunucu
 * takes without logging out.
 *
 * The strip reaches up under the status bar and pads itself clear of it: the
 * Android build is edge-to-edge, so a strip that started at y = 0 sat behind
 * the clock and the camera cutout, and a tap there pulled the shade down
 * instead. Everything below it (the Stack) is told the top inset is already
 * taken, or each screen would leave that room a second time.
 */
export function OfflineFrame({ children }: { children: ReactNode }) {
  const { online, checked, longOffline } = useConnection();
  // (auth) is guarded off once a token exists, so a signed-in user has to go
  // through Ayarlar to change the address
  const signedIn = useAuth((state) => !!state.token);
  const insets = useSafeAreaInsets();
  const shown = checked && !online;
  const moved = signedIn && longOffline && serverUrlIsEditable();

  return (
    <>
      {shown ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={moved ? 'Sunucunun adresi değişmiş olabilir, yeni adresi yaz' : 'Sunucuya ulaşılamıyor, adresi düzenle'}
          onPress={() => router.push(signedIn ? '/settings' : '/(auth)/server')}
          style={[styles.wrap, { paddingTop: insets.top + STRIP_PADDING }]}>
          <View style={styles.dot} />
          <Text variant="micro" color={Colors.white} numberOfLines={1} style={styles.text}>
            {moved
              ? 'Adres değişmiş olabilir. Kankandan yeni bağlantıyı iste →'
              : 'Sunucuya bağlanamıyorum. Girdiklerin kaydedildi, bağlanınca gönderilir. Adresi düzelt →'}
          </Text>
        </Pressable>
      ) : null}
      {/* Mounted whether or not the strip shows: putting it in and taking it
          out would remount the Stack below and lose where the user was. */}
      <SafeAreaInsetsContext.Provider value={shown ? { ...insets, top: 0 } : insets}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </>
  );
}

const STRIP_PADDING = 6;

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.dangerDim,
    paddingHorizontal: Spacing.lg,
    paddingBottom: STRIP_PADDING,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.danger },
  text: { flex: 1 },
});
