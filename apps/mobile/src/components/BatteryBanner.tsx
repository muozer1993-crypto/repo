import { useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { StorageKeys, getItem, setItem } from '@/lib/storage';
import { getBackgroundHealth, requestBatteryExemption } from '@/services/deviceHealth';
import { useLevel } from '@/store/auth';
import { Colors, Spacing } from '@/theme';
import { byLevel } from '@/utils/levelCopy';

/**
 * "Laflar geç gelebilir" — once, on the phones that need it most.
 *
 * A build without Firebase ('no-fcm') brings "KOYDUM MU?" to a closed phone
 * only through the 15-minute background check, and battery optimisation is
 * what holds that check back for hours. The fix is one system dialog, but it
 * sits in Ayarlar → Arka plan where nobody goes looking, so the home screen
 * says it once. Closing the card hides it for good; granting the exemption
 * hides it too, checked again every time the app comes back to the front.
 */
export function BatteryBanner() {
  const level = useLevel();
  const toast = useToast();
  const [show, setShow] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const [dismissed, pushReason, health] = await Promise.all([
        getItem(StorageKeys.dismissedBatteryCard),
        getItem(StorageKeys.pushReason),
        getBackgroundHealth(),
      ]);
      if (!alive) return;
      setShow(dismissed !== '1' && pushReason === 'no-fcm' && !!health && !health.batteryUnrestricted);
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
    void setItem(StorageKeys.dismissedBatteryCard, '1');
  };

  const fix = async () => {
    if (await requestBatteryExemption()) return;
    toast({
      title: 'Ayarlar açılamadı',
      body: 'Ayarlar → Uygulamalar → KOYDUM → Pil yolundan “Kısıtlanmamış”ı seç.',
      kind: 'danger',
    });
  };

  return (
    <Card edgeColor={Colors.yellow} style={styles.card}>
      <Text variant="body" bold>
        {byLevel(level, 'Bildirimler geç gelebilir', 'Laflar sana geç gelebilir', 'Sana koyduklarını geç duyarsın 🍆')}
      </Text>
      <Text variant="tiny" muted style={styles.body}>
        Telefonun pil tasarrufu KOYDUM’u arka planda uyutuyor, “KOYDUM MU?” saatler sonra düşebilir.
        Kısıtlamayı kaldırırsan uygulama kapalıyken de aşağı yukarı 15 dakikada bir gelen kutuna bakar.
      </Text>
      <View style={styles.row}>
        <Button title="Kısıtlamayı kaldır" size="sm" style={styles.grow} onPress={() => void fix()} />
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
