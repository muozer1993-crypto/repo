import type { ChallengeSummary, VulgarityLevel } from '@koydum/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ChallengeCard } from '@/components/ChallengeCard';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { useChallenges } from '@/hooks/queries';
import { ApiError } from '@/lib/api';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';
import { outcomeOf, pastChallenges, playedTogether, type Outcome } from '@/utils/history';
import { byLevel } from '@/utils/levelCopy';

type Filter = Exclude<Outcome, 'none'> | 'all';

const FILTERS: { value: Filter; label: string; color: string }[] = [
  { value: 'all', label: 'Hepsi', color: Colors.text },
  { value: 'won', label: 'Koyduklarım', color: Colors.success },
  { value: 'lost', label: 'Yediklerim', color: Colors.danger },
  { value: 'tie', label: 'Berabere', color: Colors.yellow },
  { value: 'cancelled', label: 'İptal', color: Colors.textMuted },
];

function isFilter(value: unknown): value is Filter {
  return FILTERS.some((filter) => filter.value === value);
}

/**
 * What an empty chip says; "Hepsi" with nothing at all has its own state below.
 * The rival's name only ever stands on its own: a Turkish suffix after it
 * depends on the name ("Ali'ye", "Mehmet'e"), so the lines say "bu kanka".
 */
function emptyLine(filter: Filter, level: VulgarityLevel, rival: string | null): string {
  switch (filter) {
    case 'won':
      return rival
        ? byLevel(level, 'Bu kanka karşısında henüz kazanmadın.', 'Bu kankaya daha koyamadın. Sıra sende.', 'Bu kankaya daha koyamadın lan 🍆')
        : byLevel(level, 'Henüz kazandığın bir çelınc yok.', 'Daha kimseye koymadın. Sıra sende.', 'Daha kimseye koyamadın lan 🍆');
    case 'lost':
      return rival
        ? byLevel(level, 'Bu kanka karşısında henüz kaybetmedin.', 'Bu kankadan daha yemedin. Böyle devam.', 'Bu kanka sana daha koyamadı 🍆')
        : byLevel(level, 'Henüz kaybettiğin bir çelınc yok.', 'Daha kimseden yemedin. Böyle devam.', 'Daha kimse sana koyamadı. Maşallah 🍆');
    case 'tie':
      return 'Berabere biten çelınc yok.';
    case 'cancelled':
      return 'İptal olan çelınc yok.';
    default:
      return rival ? `${rival} ile bitmiş bir çelıncınız yok.` : 'Daha bitmiş çelıncın yok.';
  }
}

/**
 * Every finished and cancelled çelınc, not just the five the home tab keeps.
 * `with` (from a profile's "Aranızdaki hesap") narrows it to one rival, `show`
 * opens it on a chip (the rövanş badge sends people to their losses).
 */
export default function HistoryScreen() {
  const params = useLocalSearchParams<{ with?: string; show?: string }>();
  const level = useLevel();
  const meId = useAuth((s) => s.me?.id ?? null);
  // the list home already holds: opening this costs no request, and its
  // "Hepsini gör (N)" always matches what is here
  const challenges = useChallenges();

  const [filter, setFilter] = useState<Filter>(isFilter(params.show) ? params.show : 'all');
  // kept here rather than in the route, so "Herkesle" can widen it in place
  const [rivalId, setRivalId] = useState<string | null>(
    typeof params.with === 'string' && params.with ? params.with : null
  );

  const back = () => (router.canGoBack() ? router.back() : router.replace('/(app)/(tabs)'));

  const all = pastChallenges(challenges.data ?? []);
  const rivalUser = rivalId
    ? all.flatMap((s) => s.participants).find((p) => p.user.id === rivalId)?.user
    : undefined;
  const rivalName = rivalId ? (rivalUser?.displayName ?? 'Bu kanka') : null;
  const pool = rivalId ? all.filter((s) => playedTogether(s, meId, rivalId)) : all;
  const counts: Record<Filter, number> = { all: pool.length, won: 0, lost: 0, tie: 0, cancelled: 0 };
  for (const summary of pool) {
    const outcome = outcomeOf(summary, meId);
    if (outcome !== 'none') counts[outcome] += 1;
  }
  const shown = filter === 'all' ? pool : pool.filter((s) => outcomeOf(s, meId) === filter);

  const open = (summary: ChallengeSummary) => {
    const id = summary.challenge.id;
    // a cancelled one never got a result; its own screen says why it ended
    if (summary.challenge.status === 'finished') {
      router.push({ pathname: '/challenge/[id]/results', params: { id } });
    } else {
      router.push({ pathname: '/challenge/[id]', params: { id } });
    }
  };

  const header = (
    <View style={styles.header}>
      <Pressable accessibilityRole="button" onPress={back} hitSlop={12}>
        <Text variant="small" color={Colors.accent} bold>
          ‹ Geri
        </Text>
      </Pressable>
      <Text variant="big">Biten çelınclar</Text>
      {rivalName ? (
        <View style={styles.rivalRow}>
          <Text variant="small" muted numberOfLines={1} style={styles.rivalText}>
            {`🆚 ${rivalName} ile oynadıkların`}
          </Text>
          <Chip label="Herkesle" size="sm" color={Colors.textMuted} onPress={() => setRivalId(null)} />
        </View>
      ) : null}
      {all.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {FILTERS.map((option) => (
            <Chip
              key={option.value}
              label={`${option.label} (${counts[option.value]})`}
              color={option.color}
              selected={filter === option.value}
              onPress={() => setFilter(option.value)}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );

  if (challenges.isPending) {
    return (
      <Screen padded={false}>
        <View style={styles.padded}>{header}</View>
        <View style={[styles.padded, styles.skeletons]}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={140} style={styles.skeleton} />
          ))}
        </View>
      </Screen>
    );
  }

  // a failed refetch keeps the list it already had; only an empty screen gives way
  if (challenges.isError && !challenges.data) {
    const err = challenges.error;
    const isNetwork = err instanceof ApiError && err.isNetwork;
    return (
      <Screen padded={false}>
        <View style={styles.padded}>{header}</View>
        <EmptyState
          emoji={isNetwork ? '📡' : '💥'}
          title={isNetwork ? 'Sunucuya ulaşamadım' : 'Çelınclar gelmedi'}
          subtitle={err instanceof ApiError ? err.message : 'Bilinmeyen bir hata oldu.'}
          actionLabel="Tekrar dene"
          onAction={() => void challenges.refetch()}
        />
      </Screen>
    );
  }

  const nothingYet = all.length === 0;

  return (
    <Screen padded={false}>
      <FlatList
        data={shown}
        keyExtractor={(summary) => summary.challenge.id}
        style={styles.list}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.listContent, shown.length === 0 && styles.listEmpty]}
        ListHeaderComponent={header}
        refreshing={challenges.isRefetching}
        onRefresh={() => void challenges.refetch()}
        ListEmptyComponent={
          nothingYet ? (
            <EmptyState
              emoji="🏁"
              title="Daha bitmiş çelıncın yok"
              subtitle={byLevel(
                level,
                'Bir çelınc bitince burada durur, istediğin zaman dönüp bakarsın.',
                'İlk çelıncın bitsin, kim kime koydu hepsi burada birikir.',
                'Ne koydun ne yedin. Aç bir çelınc da burası dolsun 🍆'
              )}
              actionLabel="Çelınc aç"
              onAction={() => router.push('/challenge/new')}
            />
          ) : (
            <EmptyState emoji="🫥" title={emptyLine(filter, level, rivalName)} />
          )
        }
        renderItem={({ item }) => (
          <View style={styles.item}>
            <ChallengeCard summary={item} level={level} meId={meId} onPress={() => open(item)} />
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  padded: { paddingHorizontal: Spacing.lg },
  header: { paddingTop: Spacing.md, paddingBottom: Spacing.md, gap: Spacing.sm },
  rivalRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  rivalText: { flexShrink: 1 },
  chips: { gap: Spacing.sm, paddingVertical: Spacing.xs },
  list: { flex: 1 },
  listContent: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xxl },
  listEmpty: { flexGrow: 1 },
  skeletons: { gap: Spacing.md, paddingTop: Spacing.sm },
  skeleton: { borderRadius: Radius.lg },
  item: { marginBottom: Spacing.md },
});
