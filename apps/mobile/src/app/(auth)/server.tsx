import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Input } from '@/components/Input';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { ApiClient, ApiError } from '@/lib/api';
import { DEFAULT_PORT, guessServerUrl, normalizeServerUrl } from '@/lib/config';
import { useAuth } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; url: string; ms: number; version: string }
  | { kind: 'error'; message: string };

/** How to find the laptop's LAN address, per platform. */
const HOW_TO: { emoji: string; title: string; body: string }[] = [
  {
    emoji: '📶',
    title: 'Aynı Wi-Fi',
    body: 'Telefon ile sunucunun çalıştığı bilgisayar aynı Wi-Fi ağında olmalı. Mobil veriyle olmaz.',
  },
  {
    emoji: '🍎',
    title: 'Mac',
    body: 'Sistem Ayarları → Wi-Fi → Ayrıntılar → IP adresi. Ya da Terminal’de: ipconfig getifaddr en0',
  },
  {
    emoji: '🪟',
    title: 'Windows',
    body: 'Komut İstemi’ni aç, ipconfig yaz. “IPv4 Adresi” satırındaki 192.168… ile başlayan sayı senin adresin.',
  },
  {
    emoji: '🐧',
    title: 'Linux',
    body: 'Terminal’de: hostname -I  (ilk sayı yeter) ya da ip addr show.',
  },
];

export default function ServerScreen() {
  const serverUrl = useAuth((s) => s.serverUrl);
  const setServerUrl = useAuth((s) => s.setServerUrl);

  const [value, setValue] = useState(serverUrl);
  const [state, setState] = useState<TestState>({ kind: 'idle' });
  const [saved, setSaved] = useState(false);

  const guessed = guessServerUrl();

  const change = (next: string) => {
    setValue(next);
    setState({ kind: 'idle' });
    setSaved(false);
  };

  const test = async () => {
    const normalized = normalizeServerUrl(value);
    if (!normalized) {
      setState({ kind: 'error', message: 'Bu adresi anlayamadım. Örnek: 192.168.1.20:4000' });
      return;
    }
    setValue(normalized);
    setState({ kind: 'testing' });
    const started = Date.now();
    try {
      const probe = new ApiClient({ baseUrl: normalized, timeoutMs: 8000 });
      const health = await probe.health();
      setState({
        kind: 'ok',
        url: normalized,
        ms: Date.now() - started,
        version: health.version,
      });
    } catch (err) {
      setState({
        kind: 'error',
        message:
          err instanceof ApiError
            ? err.message
            : 'Sunucuya ulaşamadım. Adres doğru mu, sunucu açık mı?',
      });
    }
  };

  const save = async () => {
    const normalized = normalizeServerUrl(value);
    if (!normalized) {
      setState({ kind: 'error', message: 'Bu adresi anlayamadım. Örnek: 192.168.1.20:4000' });
      return;
    }
    setValue(normalized);
    await setServerUrl(normalized);
    setSaved(true);
    if (router.canGoBack()) router.back();
  };

  return (
    <Screen scroll keyboard contentStyle={styles.content}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(auth)/login'))}
          hitSlop={12}>
          <Text variant="small" color={Colors.accent} bold>
            ‹ Geri
          </Text>
        </Pressable>
        <Text variant="title">Sunucu adresi</Text>
        <Text variant="small" muted>
          KOYDUM kendi sunucunda çalışır. Sunucunun çalıştığı bilgisayarın adresini buraya yaz.
        </Text>
      </View>

      <Input
        label="Adres"
        placeholder={`192.168.1.20:${DEFAULT_PORT}`}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={Platform.OS === 'web' ? 'default' : 'url'}
        value={value}
        onChangeText={change}
        onSubmitEditing={test}
        returnKeyType="go"
        hint={`Port yazmazsan ${DEFAULT_PORT} kabul ediyorum. http:// yazmana gerek yok.`}
      />

      <View style={styles.actions}>
        <Button
          title="Bağlantıyı test et"
          variant="secondary"
          fullWidth
          loading={state.kind === 'testing'}
          onPress={test}
        />
        <Button title="Kaydet" size="lg" fullWidth onPress={save} />
      </View>

      {state.kind === 'ok' ? (
        <View style={[styles.result, styles.resultOk]}>
          <Text variant="small" color={Colors.success} bold>
            ✅ Sunucu ayakta · {state.ms} ms
          </Text>
          <Text variant="tiny" muted>
            Sürüm {state.version} · {state.url}
          </Text>
        </View>
      ) : null}

      {state.kind === 'error' ? (
        <View style={[styles.result, styles.resultError]}>
          <Text variant="small" color={Colors.danger} bold>
            ⛔ Olmadı
          </Text>
          <Text variant="tiny" muted>
            {state.message}
          </Text>
        </View>
      ) : null}

      {saved ? (
        <Text variant="tiny" color={Colors.success}>
          Adres kaydedildi.
        </Text>
      ) : null}

      <Card>
        <Text variant="label">LAN adresi nasıl bulunur?</Text>
        <View style={styles.howList}>
          {HOW_TO.map((item) => (
            <View key={item.title} style={styles.howRow}>
              <Text style={styles.howEmoji}>{item.emoji}</Text>
              <View style={styles.howText}>
                <Text variant="small" bold>
                  {item.title}
                </Text>
                <Text variant="tiny" muted>
                  {item.body}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </Card>

      <View style={styles.footer}>
        <Text variant="tiny" faint>
          Şu an kayıtlı: {serverUrl}
        </Text>
        <Pressable accessibilityRole="button" onPress={() => change(guessed)} hitSlop={8}>
          <Text variant="tiny" color={Colors.accent} bold>
            Tahminimi kullan: {guessed}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.lg, paddingVertical: Spacing.lg },
  header: { gap: Spacing.xs },
  actions: { gap: Spacing.md },
  result: { borderRadius: Radius.md, padding: Spacing.md, gap: 2 },
  resultOk: { backgroundColor: Colors.successDim },
  resultError: { backgroundColor: Colors.dangerDim },
  howList: { gap: Spacing.md, marginTop: Spacing.sm },
  howRow: { flexDirection: 'row', gap: Spacing.md, alignItems: 'flex-start' },
  howEmoji: { fontSize: 20, width: 26 },
  howText: { flex: 1, gap: 2 },
  footer: { gap: Spacing.xs, alignItems: 'center', paddingTop: Spacing.sm },
});
