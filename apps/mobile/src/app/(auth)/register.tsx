import {
  formatNumberTr,
  pickTaunt,
  renderTaunt,
  t,
  type TauntVars,
  type VulgarityLevel,
} from '@koydum/shared';
import { Link, router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { TauntBubble } from '@/components/TauntBubble';
import { Text } from '@/components/Text';
import { ApiError } from '@/lib/api';
import { serverUrlIsEditable } from '@/lib/config';
import { deviceTimezone, useAuth } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';

/** The names and scores used in the live taunt preview — nobody real gets hurt. */
const PREVIEW_VARS: TauntVars = {
  winner: 'Mustafa',
  loser: 'sen',
  metric: 'adım',
  winnerScore: formatNumberTr(12430),
  loserScore: formatNumberTr(4201),
  diff: formatNumberTr(12430 - 4201),
  unit: 'adım',
  challenge: 'Haftalık Adım',
};

const LEVELS: { value: VulgarityLevel; label: string; emoji: string }[] = [
  { value: 1, label: 'Nazik', emoji: '🙂' },
  { value: 2, label: 'Delikanlı', emoji: '😏' },
  { value: 3, label: 'Ağır Abi', emoji: '🍆' },
];

const LEVEL_NOTE: Record<VulgarityLevel, string> = {
  1: 'Kibar takılırız. Bildirimlerde argo, küfür olmaz.',
  2: 'Kanka ağzı. Laf sokar ama küfretmez.',
  3: 'Ağır abi modu 🍆 Sana gelen bildirimler de bu ağızdan olur.',
};

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export default function RegisterScreen() {
  const setSession = useAuth((s) => s.setSession);
  const makeClient = useAuth((s) => s.client);
  const serverUrl = useAuth((s) => s.serverUrl);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [level, setLevel] = useState<VulgarityLevel>(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // React Compiler memoises this for us: the preview follows the picker live.
  const preview = renderTaunt(pickTaunt('win', level, 1), PREVIEW_VARS);

  const submit = async () => {
    setError(null);
    const name = username.trim().toLowerCase();
    const display = displayName.trim();

    if (!USERNAME_RE.test(name)) {
      setError('Kullanıcı adı 3-20 karakter olmalı. Sadece küçük harf, rakam ve alt çizgi.');
      return;
    }
    if (display.length < 1 || display.length > 30) {
      setError('Görünen adı boş bırakma. En fazla 30 karakter.');
      return;
    }
    if (password.length < 6) {
      setError('Şifre en az 6 karakter olmalı.');
      return;
    }

    setBusy(true);
    try {
      const client = makeClient();
      const result = await client.register({
        username: name,
        password,
        displayName: display,
        timezone: deviceTimezone(),
        vulgarityMax: level,
      });

      let me = result.me;
      if (me.vulgarityMax !== level) {
        // older servers ignore vulgarityMax on register; set it right after
        try {
          me = await client.withToken(result.token).updateMe({ vulgarityMax: level });
        } catch {
          // not worth blocking the sign-up; Ayarlar can fix it
        }
      }

      await setSession(result.token, me);
      router.replace('/onboarding');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kayıt olmadı. Bir daha dene.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen glow scroll keyboard contentStyle={styles.content}>
      <View style={styles.hero}>
        <Text variant="big" style={styles.logo}>
          KOYDUM
        </Text>
        <Text variant="lead" muted center>
          {t('register_title', level)}
        </Text>
      </View>

      <View style={styles.form}>
        <Input
          label="Kullanıcı adı"
          placeholder="mustafa_42"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          value={username}
          onChangeText={setUsername}
          hint="Kankalar seni bu adla bulacak. Küçük harf, rakam, alt çizgi."
          returnKeyType="next"
        />
        <Input
          label="Görünen ad"
          placeholder="Mustafa"
          autoCapitalize="words"
          autoComplete="name"
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={30}
          returnKeyType="next"
        />
        <Input
          label="Şifre"
          placeholder="••••••"
          secureTextEntry
          autoComplete="new-password"
          value={password}
          onChangeText={setPassword}
          hint="En az 6 karakter."
          onSubmitEditing={submit}
          returnKeyType="go"
        />
      </View>

      <View style={styles.levelBlock}>
        <Text variant="label">Adamlık seviyesi</Text>
        <SegmentedControl options={LEVELS} value={level} onChange={setLevel} />
        <Text variant="tiny" muted>
          {LEVEL_NOTE[level]}
        </Text>

        <View style={styles.previewWrap}>
          <Text variant="micro" faint style={styles.previewLabel}>
            SANA BÖYLE BİR BİLDİRİM GELİR
          </Text>
          <TauntBubble
            title={preview.title}
            body={preview.body}
            fromName="Mustafa"
            fromEmoji="🔥"
            timeLabel="az önce"
            loud={level === 3}
          />
          <Text variant="micro" faint center>
            Seviyeyi sonra Ayarlar’dan değiştirebilirsin. Hazır laflar seviyeni aşmaz. Kankanın
            kendi yazdığı cümle ise sadece yasaklı kelime filtresinden geçer.
          </Text>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text variant="small" color={Colors.danger}>
            {error}
          </Text>
        </View>
      ) : null}

      <Button title="Kaydol ve başla" size="lg" fullWidth loading={busy} onPress={submit} />

      <View style={styles.footer}>
        <Link href="/(auth)/login" asChild>
          <Text variant="small" style={styles.link}>
            Hesabın var mı?{' '}
            <Text variant="small" color={Colors.accent} bold>
              Giriş yap
            </Text>
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
  content: { gap: Spacing.xl, paddingVertical: Spacing.xl },
  hero: { alignItems: 'center', gap: Spacing.xs },
  logo: { color: Colors.accent, letterSpacing: -1 },
  form: { gap: Spacing.lg },
  levelBlock: { gap: Spacing.sm },
  previewWrap: { gap: Spacing.sm, marginTop: Spacing.sm },
  previewLabel: { letterSpacing: 1.2 },
  errorBox: {
    backgroundColor: Colors.dangerDim,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  footer: { alignItems: 'center', gap: Spacing.md },
  link: { textAlign: 'center' },
});
