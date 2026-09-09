import { Link, router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { ApiError } from '@/lib/api';
import { serverUrlIsEditable } from '@/lib/config';
import { deviceTimezone, useAuth } from '@/store/auth';
import { Colors, Spacing } from '@/theme';

export default function LoginScreen() {
  const setSession = useAuth((s) => s.setSession);
  const makeClient = useAuth((s) => s.client);
  const serverUrl = useAuth((s) => s.serverUrl);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    const name = username.trim().toLowerCase();
    if (name.length < 3 || password.length < 6) {
      setError('Kullanıcı adı en az 3, şifre en az 6 karakter olmalı.');
      return;
    }
    setBusy(true);
    try {
      const result = await makeClient().login({ username: name, password });
      await setSession(result.token, result.me);
      // keep the server's idea of our timezone honest after travelling
      const tz = deviceTimezone();
      if (result.me.timezone !== tz) {
        try {
          const updated = await makeClient().withToken(result.token).updateMe({ timezone: tz });
          await setSession(result.token, updated);
        } catch {
          // not important enough to block the login
        }
      }
      router.replace('/(app)/(tabs)');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Giriş yapılamadı. Kullanıcı adını ve şifreni kontrol et.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen glow scroll keyboard contentStyle={styles.content}>
      <View style={styles.hero}>
        <Text variant="giant" style={styles.logo}>
          KOYDUM
        </Text>
        <Text variant="lead" muted center>
          Arkadaşına koy. Sapır sapır.
        </Text>
      </View>

      <View style={styles.form}>
        <Input
          label="Kullanıcı adı"
          placeholder="mustafa"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          value={username}
          onChangeText={setUsername}
          returnKeyType="next"
        />
        <Input
          label="Şifre"
          placeholder="••••••"
          secureTextEntry
          autoComplete="current-password"
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
          returnKeyType="go"
          error={error}
        />
        <Button title="Gir bakalım" size="lg" fullWidth loading={busy} onPress={submit} />
      </View>

      <View style={styles.footer}>
        <Link href="/(auth)/register" asChild>
          <Text variant="small" style={styles.link}>
            Hesabın yok mu? <Text variant="small" color={Colors.accent} bold>Kaydol</Text>
          </Text>
        </Link>
        {serverUrlIsEditable() ? (
          <Link href="/(auth)/server" asChild>
            <Text variant="tiny" faint style={styles.link}>
              Sunucu: {serverUrl.replace(/^https?:\/\//, '')} · değiştir
            </Text>
          </Link>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { justifyContent: 'center', gap: Spacing.xxl, paddingVertical: Spacing.xxl },
  hero: { alignItems: 'center', gap: Spacing.sm },
  logo: { color: Colors.accent, letterSpacing: -2 },
  form: { gap: Spacing.lg },
  footer: { alignItems: 'center', gap: Spacing.md },
  link: { textAlign: 'center' },
});
