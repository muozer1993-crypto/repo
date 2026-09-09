import type { ChallengeSummary, ChallengeType, VulgarityLevel } from '@koydum/shared';
import { getChallengeType, t } from '@koydum/shared';
import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { Countdown } from '@/components/Countdown';
import { Standings } from '@/components/Standings';
import { Text } from '@/components/Text';
import { Colors, Spacing } from '@/theme';

export interface ChallengeCardProps {
  summary: ChallengeSummary;
  level: VulgarityLevel;
  meId?: string | null;
  onPress?: () => void;
}

/** One challenge as it appears in the home list. */
export function ChallengeCard({ summary, level, meId, onPress }: ChallengeCardProps) {
  const { challenge, participants, me } = summary;
  const type: ChallengeType | undefined = getChallengeType(challenge.typeKey);
  const status = statusOf(summary);

  return (
    <Card onPress={onPress} edgeColor={status.color} glow={status.key === 'losing'}>
      <View style={styles.header}>
        <Text style={styles.emoji}>{type?.emoji ?? '🎯'}</Text>
        <View style={styles.headerBody}>
          <Text variant="lead" numberOfLines={1}>
            {challenge.title || type?.nameTr || 'Çelınc'}
          </Text>
          <Text variant="tiny" muted numberOfLines={1}>
            {participants.filter((p) => p.status === 'accepted').length} kişi
            {challenge.rewardText ? ` · 🎁 ${challenge.rewardText}` : ''}
          </Text>
        </View>
        <Chip label={status.label} color={status.color} size="sm" filled={status.key === 'won'} />
      </View>

      {challenge.status !== 'pending' ? (
        <Standings
          participants={participants}
          type={type}
          meId={meId}
          limit={3}
          finished={challenge.status === 'finished'}
          style={styles.standings}
        />
      ) : null}

      <View style={styles.footer}>
        {challenge.status === 'active' ? (
          <Countdown target={challenge.endsAt} prefix="⏳" variant="tiny" bold />
        ) : challenge.status === 'pending' ? (
          <Countdown target={challenge.startsAt} prefix="🚦 başlıyor:" variant="tiny" muted />
        ) : (
          <Text variant="tiny" muted>
            {challenge.isTie ? '🤝 Berabere' : challenge.winnerId ? '🏁 Bitti' : '🚫 İptal'}
          </Text>
        )}
        {me && challenge.status === 'active' ? (
          <Text variant="tiny" muted numberOfLines={1} style={styles.hint}>
            {t(me.rank === 1 ? 'challenge_active_leading' : 'challenge_active_losing', level)}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

interface StatusView {
  key: 'invited' | 'pending' | 'leading' | 'losing' | 'won' | 'lost' | 'tie' | 'cancelled';
  label: string;
  color: string;
}

function statusOf(summary: ChallengeSummary): StatusView {
  const { challenge, me } = summary;
  if (me?.status === 'invited') return { key: 'invited', label: 'DAVET', color: Colors.yellow };
  if (challenge.status === 'cancelled') return { key: 'cancelled', label: 'İPTAL', color: Colors.textFaint };
  if (challenge.status === 'pending') return { key: 'pending', label: 'BAŞLAMADI', color: Colors.info };
  if (challenge.status === 'finished') {
    if (challenge.isTie) return { key: 'tie', label: 'BERABERE', color: Colors.info };
    if (me && challenge.winnerId === me.user.id) return { key: 'won', label: 'KOYDUN', color: Colors.success };
    return { key: 'lost', label: 'YEDİN', color: Colors.danger };
  }
  if (me && me.rank === 1) {
    // rank 1 is shared on equal scores, so "ÖNDESİN" would be a lie in a dead heat
    const leaderScore = me.score;
    const shared = summary.participants.some(
      (p) => p.status === 'accepted' && p.user.id !== me.user.id && p.score === leaderScore
    );
    if (shared) {
      return leaderScore === 0
        ? { key: 'tie', label: 'HENÜZ 0-0', color: Colors.info }
        : { key: 'tie', label: 'BAŞA BAŞ', color: Colors.info };
    }
    return { key: 'leading', label: 'ÖNDESİN', color: Colors.success };
  }
  return { key: 'losing', label: 'GERİDESİN', color: Colors.accent };
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  headerBody: { flex: 1, gap: 2 },
  emoji: { fontSize: 28 },
  standings: { marginTop: Spacing.lg },
  footer: {
    marginTop: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  hint: { flexShrink: 1, textAlign: 'right' },
});
