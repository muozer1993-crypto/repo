import { useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { StorageKeys, getItem, setItem } from '@/lib/storage';
import { openAppSettings } from '@/services/deviceHealth';
import { pushPermissionStatus } from '@/services/notifications';
import { useLevel } from '@/store/auth';
import { Colors, Spacing } from '@/theme';
import { byLevel } from '@/utils/levelCopy';

/**
 * "Bildirim izni kapalı" — on the home screen, for a phone that said no.
 *
 * Without the permission every notification is dropped on the floor, the
 * phone's own ones too: "KOYDUM MU?" never rings, the check-in reminder never
 * goes off, and the user finds out only by opening the app. Android also stops
 * asking after the second no, so the dialog cannot fix it any more; KOYDUM's
 * page in the phone's settings can, and this card opens it. The status is read
 * without ever asking (on mount and every time the app comes back to the
 * front), so switching it on there hides the card on return. "Kalsın" hides it
 * for good; Ayarlar → Bildirimler keeps the same button.
 */
export function PermissionBanner() {
  const level = useLevel();
  const toast = useToast();
  const [show, setShow] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const [dismissed, status] = await Promise.all([
        getItem(StorageKeys.dismissedNotifCard),
        pushPermissionStatus(),
      ]);
      if (!alive) return;
      setShow(dismissed !== '1' && status === 'denied');
    };
    void check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  if (!show) return null;

  const close = () => {
    setShow(false);
    void setItem(StorageKeys.dismissedNotifCard, '1');
  };

  const fix = async () => {
    if (await openAppSettings()) return;
    toast({
      title: 'Ayarlar açılamadı',
      body: 'Ayarlar → Uygulamalar → KOYDUM → Bildirimler yolundan aç.',
      kind: 'danger',
    });
  };

  return (
    <Card edgeColor={Colors.danger} style={styles.card}>
      <Text variant="body" bold>
        {byLevel(level, 'Bildirim izni kapalı', 'Bildirimlerin kapalı', 'Sana koyanı duyamazsın 🍆')}
      </Text>
      <Text variant="tiny" muted style={styles.body}>
        {byLevel(
          level,
          'Kazanan sana mesaj gönderince telefonun ötmez, check-in hatırlatmaları da çalmaz. Mesajları ancak uygulamayı açınca görürsün.',
          'Kazanan sana laf sokunca telefonun ötmez, check-in hatırlatmaları da çalmaz. Lafları ancak uygulamayı açınca görürsün.',
          'Kazanan sana koyunca telefonun ötmez, check-in hatırlatması da çalmaz. Yediğini ancak uygulamayı açınca öğrenirsin.'
        )}
      </Text>
      <View style={styles.row}>
        <Button title="Ayarları aç" size="sm" style={styles.grow} onPress={() => void fix()} />
        <Button title="Kalsın" variant="ghost" size="sm" onPress={close} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: Spacing.md },
  body: { marginTop: 2 },
  row: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  grow: { flex: 1 },
});
