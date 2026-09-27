import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { Loading } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { ApiClient, type InviteLookup } from '@/lib/api';
import { normalizeServerUrl, serverUrlIsEditable } from '@/lib/config';
import { qk, queryClient } from '@/lib/query';
import { normalizeInviteCode, savePendingInvite, sendInvite, type InviteOutcome } from '@/services/invite';
import { useAuth } from '@/store/auth';
import { Colors, Spacing } from '@/theme';

/**
 * Where an invite link lands: `koydum://davet/ABC123?server=http://...`, opened
 * from the server's /davet page (or pasted anywhere the OS turns into a link).
 *
 * Signed in: the friend request goes out at once — tapping the link WAS the
 * decision. Not signed in: the code is parked and spent right after login or
 * registration (services/invite.ts).
 *
 * The link may name a server. The app never switches on its own: it shows the
 * address and asks, because a link can come from anyone and an account created
 * on the wrong server hands that server a password.
 */
function hostOf(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

export default function InviteScreen() {
  const params = useLocalSearchParams<{ code?: string; server?: string }>();
  const code = normalizeInviteCode(params.code);
  const token = useAuth((s) => s.token);
  const serverUrl = useAuth((s) => s.serverUrl);
  const setServerUrl = useAuth((s) => s.setServerUrl);
  const logout = useAuth((s) => s.logout);
  const makeClient = useAuth((s) => s.client);

  const linkServer = typeof params.server === 'string' ? normalizeServerUrl(params.server) : null;
  const current = normalizeServerUrl(serverUrl);
  // a build with a baked-in server never moves; everywhere else a link may suggest one
  const otherServer = !!linkServer && serverUrlIsEditable() && linkServer !== current;

  const [inviter, setInviter] = useState<InviteLookup['inviter'] | null>(null);
  const [outcome, setOutcome] = useState<InviteOutcome | null>(null);
  const [sending, setSending] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const sentOnce = useRef(false);

  // who invites — asked of the server the link belongs to
  useEffect(() => {
    if (!code) return;
    let alive = true;
    const base = otherServer && linkServer ? linkServer : serverUrl;
    new ApiClient({ baseUrl: base, timeoutMs: 8000 })
      .invite(code)
      .then((found) => {
        if (alive) setInviter(found.inviter);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code, otherServer, linkServer, serverUrl]);

  // signed in on the same server: the tap was the decision, send it now
  useEffect(() => {
    if (!code || !token || otherServer || sentOnce.current) return;
    sentOnce.current = true;
    let alive = true;
    void (async () => {
      setSending(true);
      const result = await sendInvite(makeClient(), code);
      if (!alive) return;
      setOutcome(result);
      setSending(false);
      if (result.kind === 'sent' || result.kind === 'accepted') {
        void queryClient.invalidateQueries({ queryKey: qk.friends });
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, token, otherServer, makeClient]);

  const home = () => router.replace(token ? '/(app)/(tabs)' : '/(auth)/login');

  if (!code) {
    return (
      <Screen contentStyle={styles.center}>
        <EmptyState
          emoji="🫥"
          title="Bu davet bağlantısı bozuk"
          subtitle="Kod eksik ya da yanlış gelmiş. Arkadaşından bağlantıyı tekrar göndermesini iste."
          actionLabel="Ana ekrana dön"
          onAction={home}
        />
      </Screen>
    );
  }

  const name = inviter?.displayName ?? null;
  const emoji = inviter?.avatarEmoji ?? '🍆';

  /** Not signed in: park the code and go to login or registration. */
  const continueTo = async (target: '/(auth)/register' | '/(auth)/login') => {
    await savePendingInvite(code, linkServer ?? current);
    router.replace(target);
  };

  /** Point the app at the link's server, after checking that it answers. */
  const switchServer = async (then: 'register' | 'login') => {
    if (!linkServer) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      await new ApiClient({ baseUrl: linkServer, timeoutMs: 8000 }).health();
    } catch {
      setSwitchError('Bu sunucuya ulaşamadım. Açık mı, aynı Wi-Fi’da mısınız? Bir de öyle dene.');
      setSwitching(false);
      return;
    }
    if (token) await logout();
    await setServerUrl(linkServer);
    await savePendingInvite(code, linkServer);
    setSwitching(false);
    router.replace(then === 'register' ? '/(auth)/register' : '/(auth)/login');
  };

  return (
    <Screen scroll contentStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.emoji}>{emoji}</Text>
        <Text variant="big">{name ? `${name} seni çağırıyor` : 'Davet geldi'}</Text>
        <Text variant="small" muted>
          Davet kodu <Text variant="small" bold color={Colors.yellow}>{code}</Text>
        </Text>
      </View>

      {otherServer && linkServer ? (
        <Card edgeColor={Colors.yellow}>
          <Text variant="body" bold>
            Bu davet başka bir sunucudan
          </Text>
          <Text variant="small" muted style={styles.gap}>
            Davet {hostOf(linkServer)} sunucusunda. Sen şu an {hostOf(serverUrl)} sunucusuna bağlısın. Aynı oyunda olmanız için ikinizin aynı sunucuda olması lazım.
          </Text>
          {token ? (
            <Text variant="tiny" faint style={styles.gap}>
              Geçersen bu hesaptan çıkış yapılır, o sunucuda ayrı bir hesap açarsın.
            </Text>
          ) : null}
          {switchError ? (
            <Text variant="small" color={Colors.danger} style={styles.gap}>
              {switchError}
            </Text>
          ) : null}
          <View style={styles.buttons}>
            <Button
              title={token ? 'Çıkış yap ve o sunucuya geç' : 'O sunucuya bağlan ve kayıt ol'}
              fullWidth
              loading={switching}
              onPress={() => void switchServer('register')}
            />
            {!token ? (
              <Button
                title="Orada hesabım var, giriş yap"
                variant="secondary"
                fullWidth
                disabled={switching}
                onPress={() => void switchServer('login')}
              />
            ) : null}
            <Button title="Vazgeç" variant="ghost" fullWidth disabled={switching} onPress={home} />
          </View>
        </Card>
      ) : token ? (
        <Card>
          {sending || !outcome ? (
            <Loading label="Kanka isteği gidiyor..." />
          ) : (
            <OutcomeText outcome={outcome} fallbackName={name} />
          )}
          <View style={styles.buttons}>
            {outcome?.kind === 'failed' ? (
              <Button
                title="Tekrar dene"
                variant="secondary"
                fullWidth
                onPress={() => {
                  sentOnce.current = false;
                  setOutcome(null);
                  void sendInvite(makeClient(), code).then(setOutcome);
                }}
              />
            ) : null}
            <Button title="Kankalara git" fullWidth onPress={() => router.replace('/(app)/(tabs)/friends')} />
          </View>
        </Card>
      ) : (
        <Card>
          <Text variant="small">
            Hesabın yoksa kayıt ol, varsa giriş yap. Kanka isteğin kendiliğinden gider.
          </Text>
          <View style={styles.buttons}>
            <Button title="Kayıt ol" fullWidth onPress={() => void continueTo('/(auth)/register')} />
            <Button
              title="Giriş yap"
              variant="secondary"
              fullWidth
              onPress={() => void continueTo('/(auth)/login')}
            />
          </View>
        </Card>
      )}
    </Screen>
  );
}

function OutcomeText({ outcome, fallbackName }: { outcome: InviteOutcome; fallbackName: string | null }) {
  const who = ('name' in outcome && outcome.name) || fallbackName;
  switch (outcome.kind) {
    case 'sent':
      return (
        <Text variant="small">
          İstek gitti. {who ? `${who} kabul edince` : 'Kabul edilince'} kanka olursunuz, sonra çelınc açarsınız.
        </Text>
      );
    case 'accepted':
      return <Text variant="small">Artık kankasınız. İlk çelıncı aç, kim kime koyacak görelim.</Text>;
    case 'already':
      return <Text variant="small">Zaten kankasınız ya da isteğin cevap bekliyor.</Text>;
    case 'self':
      return <Text variant="small">Bu senin kendi davetin. Bağlantıyı arkadaşına gönder.</Text>;
    case 'missing':
      return <Text variant="small">Bu davet kodu geçersiz. Kod yanlış olabilir ya da hesap silinmiş.</Text>;
    case 'later':
      return <Text variant="small">Sunucuya ulaşamadım. İnternet gelince bağlantıya tekrar dokun.</Text>;
    case 'failed':
      return (
        <Text variant="small" color={Colors.danger}>
          {outcome.message}
        </Text>
      );
  }
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center' },
  content: { gap: Spacing.lg, paddingVertical: Spacing.xl },
  hero: { alignItems: 'flex-start', gap: Spacing.sm },
  emoji: { fontSize: 56, lineHeight: 66 },
  gap: { marginTop: Spacing.sm },
  buttons: { gap: Spacing.sm, marginTop: Spacing.lg },
});
