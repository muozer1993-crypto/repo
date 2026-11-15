import { StyleSheet, type ViewStyle } from 'react-native';

import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { useLevel } from '@/store/auth';
import { Colors } from '@/theme';
import { clockGapTr } from '@/utils/format';
import { byLevel } from '@/utils/levelCopy';
import { CLOCK_SKEW_WARN_MS, useClockSkew } from '@/utils/serverClock';

const FIX =
  'Çelıncların başlayıp bitmesi, check-in’lerin hangi güne yazılacağı sunucunun saatine bakar; saatlerden ' +
  'biri yanlışsa hepsi kayar. Telefonunda otomatik tarih ve saat kapalıysa önce onu aç. Açıksa yanlış olan ' +
  'sunucunun saati: sunucuyu kim açıyorsa Windows’ta Ayarlar → Zaman ve dil → Tarih ve saat bölümünde ' +
  '“Saati otomatik olarak ayarla”yı açıp “Şimdi eşitle”ye bassın.';

/**
 * "Saatler tutmuyor": the phone and the server read different times.
 *
 * The server runs every çelınc on its own clock, so a wrong one on either side
 * breaks things nobody can explain from the screen: "Hemen" refused, an evening
 * check-in counted for the wrong day, a çelınc ending hours early. A phone with
 * automatic time is almost never the wrong one, which points at the PC the
 * server runs on (a Windows next to a Linux install is 3 hours off until it
 * resyncs), so the card says how to set that one right. It goes once the
 * clocks agree again; there is nothing to close.
 */
export function ClockSkewCard({ style }: { style?: ViewStyle }) {
  const level = useLevel();
  const skew = useClockSkew();
  if (skew === null || Math.abs(skew) <= CLOCK_SKEW_WARN_MS) return null;

  return (
    <Card edgeColor={Colors.yellow} style={style}>
      <Text variant="body" bold>
        {byLevel(level, 'Telefonunla sunucunun saati farklı', 'Saatler tutmuyor', 'Saatler şaşmış, çelınc yanar 🍆')}
      </Text>
      <Text variant="tiny" muted style={styles.body}>
        {`Sunucunun saati seninkinden ${clockGapTr(skew)} ${skew > 0 ? 'ileri' : 'geri'}. ${FIX}`}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { marginTop: 2 },
});
