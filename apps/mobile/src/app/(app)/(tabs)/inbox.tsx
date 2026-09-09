import { addDays, getChallengeType, type Notification, type NotificationType } from '@koydum/shared';
import { router } from 'expo-router';
import { Pressable, SectionList, type SectionListData, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { TauntBubble } from '@/components/TauntBubble';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { useChallenges, useInbox, useMarkInboxRead } from '@/hooks/queries';
import { useTimezone } from '@/hooks/useTimezone';
import { ApiError } from '@/lib/api';
import { useLevel } from '@/store/auth';
import { Colors, FontSize, Radius, Spacing } from '@/theme';
import { safeDayKey, safeTodayKey } from '@/utils/datetime';
import { formatDayKeyFriendly, relativeTime } from '@/utils/format';

const TYPE_EMOJI: Record<NotificationType, string> = {
  friend_request: '👋',
  friend_accepted: '🫂',
  challenge_invite: '🎯',
  challenge_started: '🚀',
  challenge_cancelled: '🚫',
  challenge_finished: '🏁',
  taunt: '🍆',
  poke: '👉',
  dispute: '⚖️',
  entry_rejected: '❌',
  reminder: '⏰',
  badge: '🏅',
  rematch: '🔁',
};

const TYPE_COLOR: Partial<Record<NotificationType, string>> = {
  friend_request: Colors.info,
  friend_accepted: Colors.success,
  challenge_invite: Colors.yellow,
  challenge_started: Colors.success,
  challenge_cancelled: Colors.textFaint,
  challenge_finished: Colors.accent,
  taunt: Colors.accent,
  poke: Colors.yellow,
  dispute: Colors.danger,
  entry_rejected: Colors.danger,
  reminder: Colors.info,
  badge: Colors.yellow,
  rematch: Colors.accent,
};

const EMPTY_TITLE: Record<1 | 2 | 3, string> = {
  1: 'Henüz bildirim yok',
  2: 'Kutu bomboş lan',
  3: 'KUTU BOMBOŞ 🍆',
};

const EMPTY_BODY: Record<1 | 2 | 3, string> = {
  1: 'Bir çelınc açtığında ya da bir kanka seni davet ettiğinde burada görürsün.',
  2: 'Ne laf var ne bildirim. Git bir çelınc aç da ortalık hareketlensin.',
  3: 'Kimse sana koymamış, sen de kimseye koymamışsın. Aç bir çelınc, birine sapla.',
};

/**
 * What a taunt bubble needs in its header. The server's taunt notification only
 * carries `{ challengeId, tauntId }`, so the sender is resolved from the
 * çelınc itself — only its winner is allowed to send one.
 */
interface TauntContextInfo {
  title: string;
  fromName: string;
  fromEmoji: string | null;
}

interface DaySection {
  dayKey: string;
  title: string;
  data: Notification[];
}

/** Reads a string field out of a notification's free-form `data` bag. */
function dataString(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Where a row goes when tapped — `null` means "stay here". */
function targetFor(item: Notification): string | null {
  const challengeId = dataString(item.data, 'challengeId');
  switch (item.type) {
    case 'friend_request':
    case 'friend_accepted':
      return '/(app)/(tabs)/friends';
    case 'badge':
      return '/(app)/(tabs)/profile';
    case 'taunt':
    case 'challenge_finished':
      return challengeId ? `/challenge/${challengeId}/results` : null;
    default:
      return challengeId ? `/challenge/${challengeId}` : null;
  }
}

/** Newest first, split into day buckets (the API already sorts, we stay defensive). */
function groupByDay(items: Notification[], tz: string, today: string, yesterday: string): DaySection[] {
  const sections: DaySection[] = [];
  const byKey = new Map<string, DaySection>();
  const sorted = [...items].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  for (const item of sorted) {
    const dayKey = safeDayKey(item.createdAt, tz) ?? today;
    let section = byKey.get(dayKey);
    if (!section) {
      section = { dayKey, title: formatDayKeyFriendly(dayKey, today, yesterday), data: [] };
      byKey.set(dayKey, section);
      sections.push(section);
    }
    section.data.push(item);
  }
  return sections;
}

export default function InboxScreen() {
  const level = useLevel();
  const toast = useToast();
  const inbox = useInbox();
  const markRead = useMarkInboxRead();

  const tz = useTimezone();
  const today = safeTodayKey(tz);
  const yesterday = addDays(today, -1);

  const challenges = useChallenges();
  const tauntContext = new Map<string, TauntContextInfo>();
  for (const summary of challenges.data ?? []) {
    const type = getChallengeType(summary.challenge.typeKey);
    const title = summary.challenge.title || type?.nameTr || 'Çelınc';
    const winner = summary.challenge.winnerId
      ? summary.participants.find((p) => p.user.id === summary.challenge.winnerId)?.user
      : undefined;
    tauntContext.set(summary.challenge.id, {
      title,
      fromName: winner?.displayName ?? title,
      fromEmoji: winner?.avatarEmoji ?? type?.emoji ?? null,
    });
  }

  const items = inbox.data ?? [];
  const unreadCount = items.filter((item) => !item.readAt).length;
  const sections = groupByDay(items, tz, today, yesterday);

  const open = (item: Notification) => {
    if (!item.readAt) markRead.mutate({ ids: [item.id] });
    const target = targetFor(item);
    if (target) router.push(target);
  };

  const markAll = () => {
    if (unreadCount === 0) return;
    markRead.mutate(
      { all: true },
      {
        onSuccess: () =>
          toast({
            title: level === 1 ? 'Hepsi okundu' : 'Hepsini okudun say',
            kind: 'success',
          }),
        onError: (err) =>
          toast({
            title: 'Olmadı',
            body: err instanceof ApiError ? err.message : undefined,
            kind: 'danger',
          }),
      }
    );
  };

  const header = (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <Text variant="big">Gelen Kutusu</Text>
        {unreadCount > 0 ? (
          <Chip label={`${unreadCount} yeni`} color={Colors.accent} filled size="sm" />
        ) : null}
      </View>
      {unreadCount > 0 ? (
        <Button
          title="Hepsini okundu yap"
          variant="ghost"
          size="sm"
          icon="✅"
          onPress={markAll}
          loading={markRead.isPending && markRead.variables?.all === true}
          style={styles.markAll}
        />
      ) : (
        <Text variant="tiny" faint>
          {level === 3 ? 'Temiz. Şimdilik 🍆' : 'Okunmamış bildirim yok.'}
        </Text>
      )}
    </View>
  );

  if (inbox.isLoading) {
    return (
      <Screen padded={false}>
        <View style={styles.padded}>{header}</View>
        <View style={[styles.padded, styles.skeletons]}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={i === 0 ? 116 : 74} style={styles.skeleton} />
          ))}
        </View>
      </Screen>
    );
  }

  if (inbox.isError) {
    const err = inbox.error;
    const isNetwork = err instanceof ApiError && err.isNetwork;
    return (
      <Screen padded={false}>
        <View style={styles.padded}>{header}</View>
        <EmptyState
          emoji={isNetwork ? '📡' : '💥'}
          title={isNetwork ? 'Sunucuya ulaşamadım' : 'Bildirimler gelmedi'}
          subtitle={err instanceof ApiError ? err.message : 'Bilinmeyen bir hata çıktı.'}
          actionLabel="Tekrar dene"
          onAction={() => void inbox.refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <SectionList<Notification, DaySection>
        sections={sections}
        keyExtractor={(item) => item.id}
        style={styles.list}
        stickySectionHeadersEnabled
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.listContent, sections.length === 0 && styles.listEmpty]}
        ListHeaderComponent={header}
        refreshing={inbox.isRefetching}
        onRefresh={() => void inbox.refetch()}
        ListEmptyComponent={
          <EmptyState
            emoji="📭"
            title={EMPTY_TITLE[level]}
            subtitle={EMPTY_BODY[level]}
            actionLabel="Çelınc aç"
            onAction={() => router.push('/challenge/new')}
          />
        }
        renderSectionHeader={({ section }: { section: SectionListData<Notification, DaySection> }) => (
          <View style={styles.dayHeader}>
            <Text variant="label">{section.title}</Text>
            <View style={styles.dayLine} />
          </View>
        )}
        renderItem={({ item }) => (
          <InboxRow
            item={item}
            onPress={open}
            context={tauntContext.get(dataString(item.data, 'challengeId') ?? '')}
          />
        )}
      />
    </Screen>
  );
}

function InboxRow({
  item,
  onPress,
  context,
}: {
  item: Notification;
  onPress: (item: Notification) => void;
  context?: TauntContextInfo;
}) {
  const unread = !item.readAt;
  const time = relativeTime(item.createdAt);

  if (item.type === 'taunt') {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => onPress(item)}
        style={({ pressed }) => [styles.rowWrap, pressed && styles.pressed]}>
        <TauntBubble
          title={item.title}
          body={item.body}
          fromName={context?.fromName}
          fromEmoji={context?.fromEmoji}
          timeLabel={time}
          loud={unread}
        />
        {unread ? (
          <View style={styles.tauntFlag}>
            <Text variant="micro" color={Colors.white}>
              YENİ
            </Text>
          </View>
        ) : null}
      </Pressable>
    );
  }

  const accent = TYPE_COLOR[item.type] ?? Colors.textMuted;
  return (
    <Card
      onPress={() => onPress(item)}
      padded={false}
      edgeColor={unread ? accent : undefined}
      style={unread ? styles.cardUnread : styles.cardRead}>
      <View style={styles.row}>
        <View style={[styles.emojiWrap, unread && { borderColor: accent }]}>
          <Text style={styles.emoji}>{TYPE_EMOJI[item.type] ?? '🔔'}</Text>
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text variant="small" bold={unread} muted={!unread} numberOfLines={1} style={styles.rowTitle}>
              {item.title}
            </Text>
            <Text variant="micro" faint>
              {time}
            </Text>
          </View>
          <Text variant="tiny" muted={unread} faint={!unread} numberOfLines={2}>
            {item.body}
          </Text>
        </View>
        {unread ? <View style={[styles.dot, { backgroundColor: accent }]} /> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  padded: { paddingHorizontal: Spacing.lg },
  header: { paddingTop: Spacing.md, paddingBottom: Spacing.md, gap: Spacing.sm },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  markAll: { alignSelf: 'flex-start' },
  list: { flex: 1 },
  listContent: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xxl },
  listEmpty: { flexGrow: 1 },
  skeletons: { gap: Spacing.md, paddingTop: Spacing.sm },
  skeleton: { borderRadius: Radius.lg },
  dayHeader: {
    backgroundColor: Colors.bg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    gap: Spacing.xs,
  },
  dayLine: { height: 1, backgroundColor: Colors.border },
  rowWrap: { marginBottom: Spacing.md },
  pressed: { opacity: 0.85 },
  cardUnread: { marginBottom: Spacing.md, backgroundColor: Colors.surfaceHigh },
  cardRead: { marginBottom: Spacing.md, opacity: 0.82 },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, padding: Spacing.md },
  emojiWrap: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: FontSize.lead },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  rowTitle: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tauntFlag: {
    position: 'absolute',
    top: -6,
    right: Spacing.md,
    backgroundColor: Colors.danger,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
});
