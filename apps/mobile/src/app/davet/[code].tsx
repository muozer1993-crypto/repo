import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
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
import { isLoopbackUrl } from '@/utils/url';

/**
 * Where an invite link lands: `koydum://davet/ABC123?server=http://...`, opened
 * from the server's /davet page (or pasted anywhere the OS turns into a link).
 *
 * Signed in: the reader sees who invites and sends the request with a tap —
 * never on arrival, since a link can come from any page or app, and a request
 * from that person already waiting would be accepted by it. Not signed in: the
 * code is parked and spent right after login or registration
 * (services/invite.ts).
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
  const editable = serverUrlIsEditable();
  // A fresh install still sits on the http://localhost fallback: it has not
  // chosen a server, so the link's server is not "another" one — it is the
  // only one on offer. Adopting it still goes through the health check below.
  const unchosen = !token && !!current && isLoopbackUrl(current);
  const differs = !!linkServer && editable && linkServer !== current;
  const conflict = differs && !unchosen;
  const adopt = differs && unchosen;

  const [inviter, setInviter] = useState<InviteLookup['inviter'] | null>(null);
  const [outcome, setOutcome] = useState<InviteOutcome | null>(null);
  const [sending, setSending] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // A second link opened while this screen is on top reuses it with new
  // params: nothing from the previous code may leak into the new one.
  const [shownFor, setShownFor] = useState(code);
  if (shownFor !== code) {
    setShownFor(code);
    setInviter(null);
    setOutcome(null);
    setSwitchError(null);
  }

  // who invites — asked of the server the link belongs to
  useEffect(() => {
    if (!code) return;
    let alive = true;
    const base = differs && linkServer ? linkServer : serverUrl;
    new ApiClient({ baseUrl: base, timeoutMs: 8000 })
      .invite(code)
      .then((found) => {
        if (alive) setInviter(found.inviter);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code, differs, linkServer, serverUrl]);

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

  /**
   * Signed in: send only on a tap. A link can come from any page or app on the
   * phone, and a request from the code's owner that is already waiting would
   * be ACCEPTED by this call — that decision belongs to the reader.
   */
  const send = async () => {
    setSending(true);
    const result = await sendInvite(makeClient(), code);
    setOutcome(result);
    setSending(false);
    if (result.kind === 'sent' || result.kind === 'accepted') {
      void queryClient.invalidateQueries({ queryKey: qk.friends });
    }
  };

  /** Not signed in, same server: park the code under THIS server and go on. */
  const continueTo = async (target: '/(auth)/register' | '/(auth)/login') => {
    await savePendingInvite(code, current);
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

      {conflict && linkServer ? (
        <Card edgeColor={Colors.yellow}>
          <Text variant="body" bold>
            Bu davet başka bir sunucudan
          </Text>
          <Text variant="small" muted style={styles.gap}>
            Davet {hostOf(linkServer)} sunucusunda. Sen şu an {hostOf(serverUrl)} sunucusuna bağlısın. Aynı oyunda olmanız için ikinizin aynı sunucuda olması lazım.
          </Text>
          {token ? (
            <Text variant="tiny" faint style={styles.gap}>
              Geçersen bu hesaptan çıkış yapılır. O sunucuda hesabın varsa giriş yaparsın, yoksa yeni hesap açarsın.
            </Text>
          ) : null}
          {switchError ? (
            <Text variant="small" color={Colors.danger} style={styles.gap}>
              {switchError}
            </Text>
          ) : null}
          <View style={styles.buttons}>
            <Button
              title={token ? 'Çıkış yap, orada kayıt ol' : 'O sunucuya bağlan ve kayıt ol'}
              fullWidth
              loading={switching}
              onPress={() => void switchServer('register')}
            />
            <Button
              title={token ? 'Çıkış yap, orada giriş yap' : 'Orada hesabım var, giriş yap'}
              variant="secondary"
              fullWidth
              disabled={switching}
              onPress={() => void switchServer('login')}
            />
            <Button title="Vazgeç" variant="ghost" fullWidth disabled={switching} onPress={home} />
          </View>
        </Card>
      ) : token ? (
        <Card>
          {sending ? (
            <Loading label="Kanka isteği gidiyor..." />
          ) : outcome ? (
            <OutcomeText outcome={outcome} fallbackName={name} />
          ) : (
            <Text variant="small">
              {name ? `${name} ile kanka olmak için isteği gönder.` : 'Kanka olmak için isteği gönder.'} Kabul edince çelınc açabilirsiniz.
            </Text>
          )}
          <View style={styles.buttons}>
            {!outcome || outcome.kind === 'failed' || outcome.kind === 'later' ? (
              <Button
                title={outcome ? 'Tekrar dene' : 'Kanka isteği gönder'}
                variant={outcome ? 'secondary' : 'primary'}
                fullWidth
                loading={sending}
                onPress={() => void send()}
              />
            ) : null}
            {outcome ? (
              <Button title="Kankalara git" fullWidth onPress={() => router.replace('/(app)/(tabs)/friends')} />
            ) : (
              <Button title="Vazgeç" variant="ghost" fullWidth disabled={sending} onPress={home} />
            )}
          </View>
        </Card>
      ) : (
        <Card>
          <Text variant="small">
            Hesabın yoksa kayıt ol, varsa giriş yap. Kanka isteğin kendiliğinden gider.
          </Text>
          {adopt && linkServer ? (
            <Text variant="tiny" faint style={styles.gap}>
              Sunucu: {hostOf(linkServer)}
            </Text>
          ) : null}
          {switchError ? (
            <Text variant="small" color={Colors.danger} style={styles.gap}>
              {switchError}
            </Text>
          ) : null}
          <View style={styles.buttons}>
            <Button
              title="Kayıt ol"
              fullWidth
              loading={switching}
              onPress={() => void (adopt ? switchServer('register') : continueTo('/(auth)/register'))}
            />
            <Button
              title="Giriş yap"
              variant="secondary"
              fullWidth
              disabled={switching}
              onPress={() => void (adopt ? switchServer('login') : continueTo('/(auth)/login'))}
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
      return <Text variant="small">Sunucuya ulaşamadım. İnternet gelince “Tekrar dene”ye bas.</Text>;
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
