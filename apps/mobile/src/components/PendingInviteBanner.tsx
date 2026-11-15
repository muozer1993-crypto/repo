import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { readPendingInvite } from '@/services/invite';
import { useAuth } from '@/store/auth';
import { Colors, Spacing } from '@/theme';

/**
 * On the login and register screens: "Ali seni çağırdı", when the reader
 * arrived through an invite link. The request itself is sent after sign-in by
 * the notification bridge; this only says it will be. A new account is a
 * friend at once (the server accepts an invite code from an account in its
 * first week), so on login the banner points a newcomer to register: making
 * up a username there only ever ended in "şifre yanlış".
 */
export function PendingInviteBanner({ action }: { action: 'register' | 'login' }) {
  const makeClient = useAuth((s) => s.client);
  const serverUrl = useAuth((s) => s.serverUrl);
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  // Read again when the address changes: a link pasted into "Önce sunucuyu
  // seç" parks its code while this banner is already on screen.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const pending = await readPendingInvite();
      if (!alive || !pending) return;
      setCode(pending.code);
      // the name found for an earlier code must not stay on a new one
      setName(null);
      try {
        const found = await makeClient().invite(pending.code);
        if (alive) setName(found.inviter.displayName);
      } catch {
        // the code alone is enough to say something useful
      }
    })();
    return () => {
      alive = false;
    };
  }, [makeClient, serverUrl]);

  if (!code) return null;
  return (
    <Card edgeColor={Colors.yellow} style={styles.card}>
      <Text variant="small" bold>
        {name ? `${name} seni çağırdı 🍆` : 'Davetle geldin 🍆'}
      </Text>
      <Text variant="tiny" muted style={styles.body}>
        {action === 'register'
          ? 'Kayıt olunca kanka olursunuz.'
          : 'Hesabın yoksa önce kayıt ol, kanka olursunuz. Varsa giriş yap, istek kendiliğinden gider.'}
      </Text>
      {action === 'login' ? (
        <Button
          title="Hesabım yok, kayıt ol"
          size="sm"
          fullWidth
          style={styles.register}
          onPress={() => router.replace('/(auth)/register')}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: Spacing.sm },
  body: { marginTop: 2 },
  register: { marginTop: Spacing.sm },
});
