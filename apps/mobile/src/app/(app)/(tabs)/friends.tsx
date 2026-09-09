import type { PublicUser } from '@koydum/shared';
import { t } from '@koydum/shared';
import { useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, Share, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { Input } from '@/components/Input';
import { Loading, Skeleton } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { useFriendAction, useFriends } from '@/hooks/queries';
import { useApi } from '@/hooks/useApi';
import { ApiError } from '@/lib/api';
import { qk } from '@/lib/query';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/theme';
import { byLevel } from '@/utils/levelCopy';

const MONO = Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' });

export default function FriendsScreen() {
  const level = useLevel();
  const me = useAuth((s) => s.me);
  const api = useApi();
  const toast = useToast();
  const friends = useFriends();
  const action = useFriendAction();

  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setQuery(term.trim()), 350);
    return () => clearTimeout(id);
  }, [term]);

  const search = useQuery({
    queryKey: qk.search(query.toLocaleLowerCase('tr-TR')),
    queryFn: () => api.searchUsers(query),
    enabled: query.length >= 2,
    staleTime: 30_000,
  });

  const data = friends.data;
  const friendIds = new Set((data?.friends ?? []).map((u) => u.id));
  const outgoingIds = new Set((data?.outgoing ?? []).map((r) => r.user.id));
  const incomingByUser = new Map((data?.incoming ?? []).map((r) => [r.user.id, r.id]));
  const results = (search.data ?? []).filter((u) => u.id !== me?.id);

  const fail = (error: unknown) => {
    toast({
      title: 'Olmadı',
      body: error instanceof ApiError ? error.message : 'Bir şeyler ters gitti.',
      kind: 'danger',
    });
  };

  const addByUsername = (user: PublicUser) => {
    setBusyKey(user.id);
    action.mutate(
      { kind: 'request', username: user.username },
      {
        onSuccess: () =>
          toast({
            title: 'İstek gitti',
            body: `${user.displayName} kabul edince kanka olursunuz.`,
            kind: 'success',
          }),
        onError: fail,
        onSettled: () => setBusyKey(null),
      }
    );
  };

  const addByCode = () => {
    const code = query.trim();
    setBusyKey('code');
    action.mutate(
      { kind: 'request', inviteCode: code },
      {
        onSuccess: () => {
          setTerm('');
          toast({ title: 'Kod tuttu', body: 'İstek gönderildi.', kind: 'success' });
        },
        onError: fail,
        onSettled: () => setBusyKey(null),
      }
    );
  };

  const respond = (friendshipId: string, kind: 'accept' | 'decline', name: string) => {
    setBusyKey(friendshipId);
    action.mutate(
      { kind, friendshipId },
      {
        onSuccess: () =>
          toast({
            title: kind === 'accept' ? 'Kanka oldunuz' : 'Reddettin',
            body: kind === 'accept' ? `${name} artık listende. Aç bir çelınc.` : `${name} eklenmedi.`,
            kind: kind === 'accept' ? 'success' : 'info',
          }),
        onError: fail,
        onSettled: () => setBusyKey(null),
      }
    );
  };

  const copyCode = async () => {
    if (!me?.inviteCode) return;
    try {
      await Clipboard.setStringAsync(me.inviteCode);
      toast({ title: 'Kopyalandı', body: 'Kodu kankana gönder.', kind: 'success' });
    } catch {
      toast({ title: 'Kopyalanamadı', body: 'Kodu elle yaz gitsin.', kind: 'danger' });
    }
  };

  const shareCode = async () => {
    if (!me?.inviteCode) return;
    const message = `KOYDUM'da bana kanka ekle. Davet kodum: ${me.inviteCode} (@${me.username})`;
    if (Platform.OS === 'web') {
      // react-native-web's Share is not reliable in every browser; copying always works
      await copyCode();
      return;
    }
    try {
      await Share.share({ message });
    } catch {
      toast({ title: 'Paylaşılamadı', body: 'Kodu kopyalayıp yollayabilirsin.', kind: 'danger' });
    }
  };

  const nothingYet =
    !!data &&
    data.friends.length === 0 &&
    data.incoming.length === 0 &&
    data.outgoing.length === 0;

  const showCodeButton =
    query.length >= 4 && !query.includes(' ') && !search.isFetching && results.length === 0;

  return (
    <Screen
      glow
      keyboard
      onRefresh={() => void friends.refetch()}
      refreshing={friends.isRefetching}>
      <View style={styles.header}>
        <Text variant="big">Kankalar</Text>
        <Text variant="tiny" faint>
          {byLevel(
            level,
            'Kanka listen. Yarışacak birini buradan ekleyebilirsin.',
            'Kurban listen. Boşsa aşağıdan birini ekle.',
            'Kurban listen 🍆 Boşsa önce birini bul.'
          )}
        </Text>
      </View>

      <Input
        label="Kanka ara"
        placeholder="kullanıcı adı veya davet kodu"
        autoCapitalize="none"
        autoCorrect={false}
        value={term}
        onChangeText={setTerm}
        returnKeyType="search"
        containerStyle={styles.search}
      />

      {query.length >= 2 ? (
        <View style={styles.section}>
          <SectionHeader title="Sonuçlar" emoji="🔎" />
          {search.isPending ? (
            <Loading label="Aranıyor..." />
          ) : search.isError ? (
            <Card edgeColor={Colors.danger}>
              <Text variant="small" muted>
                {search.error instanceof ApiError ? search.error.message : 'Arama yapılamadı.'}
              </Text>
            </Card>
          ) : results.length === 0 ? (
            <Card>
              <Text variant="small" muted>
                “{query}” diye biri yok. Kullanıcı adını doğru yazdın mı?
              </Text>
              {showCodeButton ? (
                <Button
                  title="Kod ile ekle"
                  variant="secondary"
                  size="sm"
                  style={styles.codeTry}
                  loading={action.isPending && busyKey === 'code'}
                  onPress={addByCode}
                />
              ) : null}
            </Card>
          ) : (
            results.map((user) => {
              const incomingId = incomingByUser.get(user.id);
              return (
                <UserRow
                  key={user.id}
                  user={user}
                  onPress={() => router.push({ pathname: '/user/[id]', params: { id: user.id } })}
                  right={
                    friendIds.has(user.id) ? (
                      <Chip label="KANKA" color={Colors.success} size="sm" />
                    ) : outgoingIds.has(user.id) ? (
                      <Chip label="BEKLİYOR" color={Colors.yellow} size="sm" />
                    ) : incomingId ? (
                      <Button
                        title="Kabul"
                        size="sm"
                        variant="success"
                        loading={action.isPending && busyKey === incomingId}
                        onPress={() => respond(incomingId, 'accept', user.displayName)}
                      />
                    ) : (
                      <Button
                        title="Ekle"
                        size="sm"
                        loading={action.isPending && busyKey === user.id}
                        onPress={() => addByUsername(user)}
                      />
                    )
                  }
                />
              );
            })
          )}
        </View>
      ) : null}

      {friends.isPending ? (
        <View style={styles.section}>
          <Skeleton height={64} style={styles.skeleton} />
          <Skeleton height={64} style={styles.skeleton} />
          <Skeleton height={64} style={styles.skeleton} />
        </View>
      ) : null}

      {friends.isError ? (
        <Card edgeColor={Colors.danger} style={styles.section}>
          <Text variant="lead">Liste gelmedi</Text>
          <Text variant="small" muted style={styles.errorBody}>
            {friends.error instanceof ApiError ? friends.error.message : 'Kankalar yüklenemedi.'}
          </Text>
          <Button
            title="Tekrar dene"
            variant="secondary"
            size="sm"
            style={styles.errorAction}
            onPress={() => void friends.refetch()}
          />
        </Card>
      ) : null}

      {data && data.incoming.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="Gelen istekler" count={data.incoming.length} emoji="📥" />
          {data.incoming.map((request) => (
            <UserRow
              key={request.id}
              user={request.user}
              onPress={() =>
                router.push({ pathname: '/user/[id]', params: { id: request.user.id } })
              }
              right={
                <View style={styles.rowActions}>
                  <Button
                    title="Kabul"
                    size="sm"
                    variant="success"
                    loading={action.isPending && busyKey === request.id}
                    disabled={action.isPending && busyKey === request.id}
                    onPress={() => respond(request.id, 'accept', request.user.displayName)}
                  />
                  <Button
                    title="Reddet"
                    size="sm"
                    variant="ghost"
                    disabled={action.isPending && busyKey === request.id}
                    onPress={() => respond(request.id, 'decline', request.user.displayName)}
                  />
                </View>
              }
            />
          ))}
        </View>
      ) : null}

      {data && data.outgoing.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="Gönderilen istekler" count={data.outgoing.length} emoji="📤" />
          {data.outgoing.map((request) => (
            <UserRow
              key={request.id}
              user={request.user}
              onPress={() =>
                router.push({ pathname: '/user/[id]', params: { id: request.user.id } })
              }
              right={<Chip label="BEKLİYOR" color={Colors.yellow} size="sm" />}
            />
          ))}
        </View>
      ) : null}

      {data && data.friends.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="Kankalar" count={data.friends.length} emoji="🫂" />
          {data.friends.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              onPress={() => router.push({ pathname: '/user/[id]', params: { id: user.id } })}
              right={
                <Text variant="micro" faint>
                  ›
                </Text>
              }
            />
          ))}
        </View>
      ) : null}

      {nothingYet ? (
        <EmptyState
          emoji="🫂"
          title={t('add_friend_empty', level)}
          subtitle="Yukarıdan kullanıcı adını ara ya da davet kodunu paylaş."
          actionLabel={t('invite_friends_cta', level)}
          onAction={() => void shareCode()}
        />
      ) : null}

      <Card style={styles.codeCard} edgeColor={Colors.accent}>
        <Text variant="label">Davet kodun</Text>
        <Text style={styles.code} numberOfLines={1} adjustsFontSizeToFit>
          {me?.inviteCode ?? '········'}
        </Text>
        <Text variant="tiny" muted style={styles.codeHint}>
          Kankan bu kodu arama kutusuna yazıp “Kod ile ekle”ye bassın.
        </Text>
        <View style={styles.codeActions}>
          <Button
            title="Kopyala"
            icon="📋"
            variant="secondary"
            size="sm"
            style={styles.codeButton}
            disabled={!me?.inviteCode}
            onPress={() => void copyCode()}
          />
          <Button
            title="Paylaş"
            icon="📨"
            size="sm"
            style={styles.codeButton}
            disabled={!me?.inviteCode}
            onPress={() => void shareCode()}
          />
        </View>
      </Card>
    </Screen>
  );
}

/* -------------------------------------------------------------- pieces */

function SectionHeader({ title, count, emoji }: { title: string; count?: number; emoji?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text variant="label">
        {emoji ? `${emoji} ` : ''}
        {title}
      </Text>
      {typeof count === 'number' ? (
        <Text variant="micro" faint>
          {count}
        </Text>
      ) : null}
    </View>
  );
}

function UserRow({
  user,
  right,
  onPress,
}: {
  user: PublicUser;
  right?: ReactNode;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <Avatar emoji={user.avatarEmoji} name={user.displayName} size={40} />
      <View style={styles.rowBody}>
        <Text variant="small" bold numberOfLines={1}>
          {user.displayName}
        </Text>
        <Text variant="tiny" faint numberOfLines={1}>
          @{user.username}
        </Text>
      </View>
      {right}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: Spacing.md, marginBottom: Spacing.lg, gap: 2 },
  search: { marginBottom: Spacing.xl },
  section: { gap: Spacing.sm, marginBottom: Spacing.xl },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  skeleton: { borderRadius: Radius.md },
  errorBody: { marginTop: Spacing.xs },
  errorAction: { marginTop: Spacing.md, alignSelf: 'flex-start' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
  },
  rowPressed: { opacity: 0.85 },
  rowBody: { flex: 1, gap: 1 },
  rowActions: { flexDirection: 'row', gap: Spacing.sm },
  codeTry: { marginTop: Spacing.md, alignSelf: 'flex-start' },
  codeCard: { marginBottom: Spacing.xl },
  code: {
    fontFamily: MONO,
    fontSize: FontSize.huge,
    // a monospace cap at 36px needs the room spelled out, or Android slices the
    // top and bottom off the code people are supposed to read out loud
    lineHeight: Math.round(FontSize.huge * 1.35),
    fontWeight: FontWeight.black,
    letterSpacing: 4,
    color: Colors.yellow,
    marginTop: Spacing.xs,
    paddingVertical: 2,
  },
  codeHint: { marginTop: Spacing.sm },
  codeActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg },
  codeButton: { flex: 1 },
});
