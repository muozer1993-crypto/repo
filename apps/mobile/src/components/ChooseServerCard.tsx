import { useState } from 'react';
import { Platform, StyleSheet } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { ApiClient } from '@/lib/api';
import { serverUrlIsEditable } from '@/lib/config';
import { parsePastedInvite, savePendingInvite } from '@/services/invite';
import { useAuth } from '@/store/auth';
import { Colors, Spacing } from '@/theme';
import { isLocalNetworkUrl, isLoopbackUrl } from '@/utils/url';

/**
 * A phone still on the localhost fallback has picked no server: an APK built
 * without EXPO_PUBLIC_KOYDUM_API_URL and opened from the installer's "Aç",
 * which carries no invite link. Signing up from there can only fail, with an
 * error about Wi-Fi that means nothing to a friend on mobile data. The web
 * build is left out: its guess comes from the page's own address, and on a
 * laptop localhost is the real thing.
 */
export function needsServerChoice(serverUrl: string): boolean {
  return Platform.OS !== 'web' && serverUrlIsEditable() && isLoopbackUrl(serverUrl);
}

/**
 * "Önce sunucuyu seç", on top of login and register while needsServerChoice
 * holds. Takes the invite message as it arrived; the server is adopted once it
 * answers /health, and an invite code inside is parked so the banner below
 * names the inviter and the request goes out right after sign-up.
 */
export function ChooseServerCard() {
  const setServerUrl = useAuth((s) => s.setServerUrl);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    const { server, code } = parsePastedInvite(value);
    if (!server) {
      setError('Bunu adres olarak okuyamadım. Kankanın attığı bağlantıyı olduğu gibi yapıştır.');
      return;
    }
    if (isLoopbackUrl(server)) {
      // copied off the owner's screen: on a phone it points at the phone itself
      setError('Bu adres telefonun kendisi demek. Kankanın attığı davet bağlantısını yapıştır.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await new ApiClient({ baseUrl: server, timeoutMs: 8000 }).health();
    } catch {
      setBusy(false);
      setError(
        isLocalNetworkUrl(server)
          ? 'Bu adrese ulaşamadım. Ev adresleri sadece aynı Wi-Fi’dan açılır, mobil veriyle olmaz. Sunucunun olduğu Wi-Fi’a bağlı mısın?'
          : 'Bu adrese ulaşamadım. Sunucuyu açan kankanın bilgisayarı açık mı? Bağlantı eskiyse yenisini iste.'
      );
      return;
    }
    // parked before the address changes: the banner reads it when it does
    if (code) await savePendingInvite(code, server);
    await setServerUrl(server);
    setBusy(false);
  };

  return (
    <Card edgeColor={Colors.yellow} style={styles.card}>
      <Text variant="body" bold>
        Önce sunucuyu seç
      </Text>
      <Text variant="tiny" muted>
        Kankanın attığı davet bağlantısını olduğu gibi yapıştır.
      </Text>
      <Input
        placeholder="Davet bağlantısı ya da 192.168.1.20"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={value}
        onChangeText={(text) => {
          setValue(text);
          setError(null);
        }}
        returnKeyType="go"
        onSubmitEditing={() => void connect()}
        error={error}
      />
      <Button title="Bağlan" fullWidth loading={busy} onPress={() => void connect()} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.sm },
});
