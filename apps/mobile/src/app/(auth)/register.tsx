import {
  foldUsername,
  formatNumberTr,
  pickTaunt,
  renderTaunt,
  t,
  USERNAME_REGEX,
  type AuthResponse,
  type TauntVars,
  type VulgarityLevel,
} from '@koydum/shared';
import { Link, router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { PendingInviteBanner } from '@/components/PendingInviteBanner';
import { Button } from '@/components/Button';
import { ChooseServerCard, needsServerChoice } from '@/components/ChooseServerCard';
import { Input } from '@/components/Input';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { TauntBubble } from '@/components/TauntBubble';
import { Text } from '@/components/Text';
import { ApiError, type ApiClient } from '@/lib/api';
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

/**
 * No answer, or one from a gateway rather than our server: the request may
 * have reached it all the same.
 */
function unanswered(err: unknown): boolean {
  return err instanceof ApiError && (err.isNetwork || err.code === 'server_down');
}

const LEVEL_NOTE: Record<VulgarityLevel, string> = {
  1: 'Kibar takılırız. Bildirimlerde argo, küfür olmaz.',
  2: 'Kanka ağzı. Laf sokar ama küfretmez.',
  3: 'Ağır abi modu 🍆 Sana gelen bildirimler de bu ağızdan olur.',
};

export default function RegisterScreen() {
  const setSession = useAuth((s) => s.setSession);
  const setOnboarding = useAuth((s) => s.setOnboarding);
  const makeClient = useAuth((s) => s.client);
  const serverUrl = useAuth((s) => s.serverUrl);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [level, setLevel] = useState<VulgarityLevel>(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const displayNameRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  // the name and password of a sign-up whose answer never came (see signUp)
  const lostTry = useRef<{ name: string; password: string } | null>(null);
  const chooseFirst = needsServerChoice(serverUrl);

  // React Compiler memoises this for us: the preview follows the picker live.
  const preview = renderTaunt(pickTaunt('win', level, 1), PREVIEW_VARS);

  /**
   * A tunnel or a mobile link can deliver the sign-up and lose its answer: the
   * account is made, the app says "Sunucu cevap vermedi", and the next tap
   * heard "kapılmış" about the friend's own new account. They signed up as
   * zeynep2 and left an empty zeynep where their kankas search for them. So a
   * "kapılmış" for the very name and password of a try that got no answer
   * signs in to that account, through the plain login and its limits: only
   * whoever typed that password gets in, and a name somebody else holds still
   * says "kapılmış". The app does it because only the app knows what it sent:
   * the server cannot tell a retry from a stranger who wants the same name.
   */
  const signUp = async (
    client: ApiClient,
    body: Parameters<ApiClient['register']>[0]
  ): Promise<AuthResponse> => {
    try {
      return await client.register(body);
    } catch (err) {
      if (unanswered(err)) lostTry.current = { name: body.username, password: body.password };
      const lost = lostTry.current;
      if (
        err instanceof ApiError &&
        err.code === 'username_taken' &&
        lost?.name === body.username &&
        lost.password === body.password
      ) {
        try {
          return await client.login({ username: body.username, password: body.password });
        } catch (loginErr) {
          // no answer this time either: that is what to say, and the next tap tries again
          if (unanswered(loginErr)) throw loginErr;
          // a wrong password: the name is somebody else's after all
        }
      }
      throw err;
    }
  };

  const submit = async () => {
    setError(null);
    // the keyboard's "go" still reaches here while the button is disabled
    if (chooseFirst) {
      setError('Önce yukarıdan sunucuyu seç.');
      return;
    }
    const name = foldUsername(username);
    const display = displayName.trim();

    if (!USERNAME_REGEX.test(name)) {
      setError('Kullanıcı adı 3-20 karakter olmalı. Harf, rakam ve alt çizgi olur; nokta, tire, emoji olmaz.');
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
      const result = await signUp(client, {
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

      // before the token lands: the bridge must not ask for notifications and
      // steps over the first slide, the last one explains both
      setOnboarding(true);
      await setSession(result.token, me);
      router.replace('/onboarding');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kayıt olmadı. Bir daha dene.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen glow scroll keyboard safeBottom contentStyle={styles.content}>
      <View style={styles.hero}>
        <Text variant="big" style={styles.logo}>
          KOYDUM
        </Text>
        <Text variant="lead" muted center>
          {t('register_title', level)}
        </Text>
      </View>

      {chooseFirst ? <ChooseServerCard /> : null}

      <PendingInviteBanner action="register" />

      <View style={styles.form}>
        {/* folded as typed, so the field already shows what gets saved: "Şeyma" → seyma */}
        <Input
          label="Kullanıcı adı"
          placeholder="mustafa_42"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          value={username}
          onChangeText={(text) => setUsername(foldUsername(text))}
          hint="Kankalar seni bu adla bulacak. Türkçe harfler çevrilir (ş→s, ı→i). Görünen adında Türkçe harf kullanabilirsin."
          returnKeyType="next"
          // "İleri" goes on to the next field with the keyboard still up (on its own it only closed it)
          submitBehavior="submit"
          onSubmitEditing={() => displayNameRef.current?.focus()}
        />
        <Input
          ref={displayNameRef}
          label="Görünen ad"
          placeholder="Mustafa"
          autoCapitalize="words"
          autoComplete="name"
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={30}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => passwordRef.current?.focus()}
        />
        <Input
          ref={passwordRef}
          label="Şifre"
          placeholder="••••••"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
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

      <View style={styles.submit}>
        <Button
          title="Kaydol ve başla"
          size="lg"
          fullWidth
          loading={busy}
          disabled={chooseFirst}
          onPress={submit}
        />
        {chooseFirst ? (
          <Text variant="tiny" faint center>
            Önce sunucuyu seç
          </Text>
        ) : null}
      </View>

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
  submit: { gap: Spacing.sm },
  footer: { alignItems: 'center', gap: Spacing.md },
  link: { textAlign: 'center' },
});
