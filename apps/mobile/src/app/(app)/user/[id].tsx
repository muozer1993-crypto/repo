import { LIMITS, getBadge } from '@koydum/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { Input } from '@/components/Input';
import { Loading } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { Stat } from '@/components/Stat';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { useChallenges, useFriendAction, useFriends, useProfile } from '@/hooks/queries';
import { useApi } from '@/hooks/useApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';
import { confirmTr } from '@/utils/confirm';

interface HeadToHead {
  mine: number;
  theirs: number;
  ties: number;
  total: number;
}

export default function UserProfileScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const myId = useAuth((s) => s.me?.id ?? null);
  const api = useApi();
  const toast = useToast();

  const profile = useProfile(id);
  const friends = useFriends();
  const finished = useChallenges('finished');
  const friendAction = useFriendAction();

  const [reportOpen, setReportOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<null | 'block' | 'report'>(null);

  const isMe = !!myId && myId === id;
  const isFriend = (friends.data?.friends ?? []).some((friend) => friend.id === id);

  // Head-to-head: in every finished challenge we both played, whoever ranked
  // higher took that round. Works for 1v1 and for crowded çelinçs alike.
  const head: HeadToHead = { mine: 0, theirs: 0, ties: 0, total: 0 };
  for (const summary of finished.data ?? []) {
    if (summary.challenge.status !== 'finished') continue;
    const mineSide = summary.participants.find((p) => p.user.id === myId);
    const theirSide = summary.participants.find((p) => p.user.id === id);
    if (!mineSide || !theirSide) continue;
    head.total += 1;
    if (mineSide.rank < theirSide.rank) head.mine += 1;
    else if (mineSide.rank > theirSide.rank) head.theirs += 1;
    else head.ties += 1;
  }

  const headLine =
    head.total === 0
      ? 'Henüz karşı karşıya gelmediniz. Bir çelinç aç da görelim.'
      : head.mine > head.theirs
        ? `${head.mine}-${head.theirs} öndesin. Koymaya devam.`
        : head.mine < head.theirs
          ? `${head.mine}-${head.theirs} geridesin. Bu böyle kalmasın.`
          : `${head.mine}-${head.theirs} başa baş. Biri birine koyacak, kim olacak?`;

  const openChallenge = () => {
    router.push({ pathname: '/(app)/challenge/new', params: { friend: id } });
  };

  const removeFriend = async () => {
    const ok = await confirmTr(
      'Arkadaşlıktan çıkar',
      `${profile.data?.displayName ?? 'Bu kanka'} listenden çıkacak. Ortak çelinçler kalır ama yenisini açamazsınız.`,
      'Çıkar'
    );
    if (!ok) return;
    friendAction.mutate(
      { kind: 'remove', userId: id },
      {
        onSuccess: () => {
          toast({ title: 'Listeden çıkarıldı', kind: 'info' });
          if (router.canGoBack()) router.back();
        },
        onError: (err) =>
          toast({
            title: 'Olmadı',
            body: err instanceof ApiError ? err.message : undefined,
            kind: 'danger',
          }),
      }
    );
  };

  const block = async () => {
    const ok = await confirmTr(
      'Engelle',
      'Bu kişi sana çelinç açamaz, laf sokamaz, arkadaşlık isteği gönderemez. Emin misin?',
      'Engelle'
    );
    if (!ok) return;
    setBusy('block');
    try {
      await api.blockUser(id);
      toast({ title: 'Engellendi', kind: 'info' });
      await friends.refetch();
      if (router.canGoBack()) router.back();
    } catch (err) {
      toast({
        title: 'Engellenemedi',
        body: err instanceof ApiError ? err.message : undefined,
        kind: 'danger',
      });
    } finally {
      setBusy(null);
    }
  };

  const report = async () => {
    const text = reason.trim();
    if (text.length < 1) {
      toast({ title: 'Sebep yaz', body: 'Ne oldu, iki kelimeyle anlat.', kind: 'danger' });
      return;
    }
    setBusy('report');
    try {
      await api.reportUser(id, text);
      setReportOpen(false);
      setReason('');
      toast({ title: 'Şikayet alındı', body: 'Bakacağız.', kind: 'success' });
    } catch (err) {
      toast({
        title: 'Şikayet gönderilemedi',
        body: err instanceof ApiError ? err.message : undefined,
        kind: 'danger',
      });
    } finally {
      setBusy(null);
    }
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/(app)/(tabs)'));

  // a link without an id leaves the query disabled, so the spinner would never end
  if (!id) {
    return (
      <Screen contentStyle={styles.content}>
        <EmptyState
          emoji="🫥"
          title="Profil bulunamadı"
          subtitle="Bu bağlantıda kullanıcı numarası yok. Kankalar listesinden birine dokun."
          actionLabel="Geri dön"
          onAction={back}
        />
      </Screen>
    );
  }

  if (profile.isLoading) {
    return (
      <Screen>
        <Loading label="Profil geliyor…" />
      </Screen>
    );
  }

  if (profile.isError || !profile.data) {
    const err = profile.error;
    return (
      <Screen contentStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={back} hitSlop={12}>
          <Text variant="small" color={Colors.accent} bold>
            ‹ Geri
          </Text>
        </Pressable>
        <EmptyState
          emoji="🫥"
          title="Profil açılmadı"
          subtitle={
            err instanceof ApiError
              ? err.message
              : 'Bu kişiye şu an bakamıyorum. Bağlantını kontrol et.'
          }
          actionLabel="Tekrar dene"
          onAction={() => void profile.refetch()}
        />
      </Screen>
    );
  }

  const user = profile.data;
  const badges = user.badges.map((key) => getBadge(key)).filter((badge) => !!badge);

  return (
    <Screen scroll onRefresh={() => void profile.refetch()} refreshing={profile.isRefetching} contentStyle={styles.content}>
      <Pressable accessibilityRole="button" onPress={back} hitSlop={12}>
        <Text variant="small" color={Colors.accent} bold>
          ‹ Geri
        </Text>
      </Pressable>

      <View style={styles.hero}>
        <Avatar emoji={user.avatarEmoji} name={user.displayName} size={92} ring={Colors.accent} />
        <Text variant="big" center>
          {user.displayName}
        </Text>
        <Text variant="small" muted>
          @{user.username}
        </Text>
        {isFriend ? <Chip label="Kanka" icon="🫂" color={Colors.success} size="sm" /> : null}
      </View>

      <View style={styles.statsRow}>
        <Stat label="Koydu" value={user.stats.wins} emoji="🍆" color={Colors.success} compact />
        <Stat label="Yedi" value={user.stats.losses} emoji="🍽️" color={Colors.danger} compact />
        <Stat label="Laf soktu" value={user.stats.tauntsSent} emoji="🗣️" color={Colors.yellow} compact />
        <Stat label="Laf yedi" value={user.stats.tauntsReceived} emoji="🛡️" compact />
      </View>

      {!isMe ? (
        <Card edgeColor={head.mine >= head.theirs ? Colors.success : Colors.danger}>
          <Text variant="label">Aranızdaki hesap</Text>
          <View style={styles.headRow}>
            <View style={styles.headCell}>
              <Text variant="huge" color={Colors.success}>
                {head.mine}
              </Text>
              <Text variant="micro" muted>
                SEN
              </Text>
            </View>
            <Text variant="title" faint>
              –
            </Text>
            <View style={styles.headCell}>
              <Text variant="huge" color={Colors.danger}>
                {head.theirs}
              </Text>
              <Text variant="micro" muted numberOfLines={1}>
                {user.displayName.toLocaleUpperCase('tr-TR')}
              </Text>
            </View>
            {head.ties > 0 ? (
              <View style={styles.headCell}>
                <Text variant="huge" muted>
                  {head.ties}
                </Text>
                <Text variant="micro" muted>
                  BERABERE
                </Text>
              </View>
            ) : null}
          </View>
          <Text variant="small" muted>
            {finished.isLoading ? 'Biten çelinçlere bakıyorum…' : headLine}
          </Text>
        </Card>
      ) : null}

      <Card>
        <Text variant="label">Rozetler</Text>
        {badges.length === 0 ? (
          <Text variant="small" muted style={styles.badgeEmpty}>
            Henüz rozet yok. Demek ki daha çok koyması lazım.
          </Text>
        ) : (
          <View style={styles.badges}>
            {badges.map((badge) => (
              <Chip key={badge.key} label={badge.nameTr} icon={badge.emoji} color={Colors.yellow} />
            ))}
          </View>
        )}
      </Card>

      {!isMe ? (
        <View style={styles.actions}>
          <Button title="Çelinç aç" size="lg" icon="🔥" fullWidth onPress={openChallenge} />
          {isFriend ? (
            <Button
              title="Arkadaşlıktan çıkar"
              variant="secondary"
              fullWidth
              loading={friendAction.isPending}
              onPress={() => void removeFriend()}
            />
          ) : null}
          <View style={styles.dangerRow}>
            <Button
              title="Engelle"
              variant="ghost"
              size="sm"
              loading={busy === 'block'}
              onPress={() => void block()}
              style={styles.flexButton}
            />
            <Button
              title="Şikayet et"
              variant="ghost"
              size="sm"
              onPress={() => setReportOpen(true)}
              style={styles.flexButton}
            />
          </View>
        </View>
      ) : (
        <Text variant="small" muted center>
          Bu sensin. Kendine koyamazsın.
        </Text>
      )}

      <Sheet visible={reportOpen} onClose={() => setReportOpen(false)} title="Şikayet et">
        <Text variant="small" muted>
          Şaka ile hakaret arasındaki farkı biliyoruz. Ne olduğunu yaz, bakalım.
        </Text>
        <Input
          label="Sebep"
          placeholder="Ne oldu?"
          value={reason}
          onChangeText={setReason}
          multiline
          numberOfLines={4}
          maxLength={LIMITS.REPORT_REASON_MAX}
          style={styles.reportInput}
          hint={`${reason.trim().length}/${LIMITS.REPORT_REASON_MAX}`}
        />
        <Button
          title="Gönder"
          fullWidth
          loading={busy === 'report'}
          onPress={() => void report()}
        />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.lg, paddingVertical: Spacing.lg },
  hero: { alignItems: 'center', gap: Spacing.sm },
  statsRow: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  headCell: { alignItems: 'center', gap: 2, minWidth: 64 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  badgeEmpty: { marginTop: Spacing.sm },
  actions: { gap: Spacing.md },
  dangerRow: { flexDirection: 'row', gap: Spacing.sm },
  flexButton: { flex: 1 },
  reportInput: { minHeight: 96, textAlignVertical: 'top', borderRadius: Radius.md },
});
