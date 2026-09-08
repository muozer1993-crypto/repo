import type { ChallengeType, ParticipantView } from '@koydum/shared';
import { scoreLabel } from '@koydum/shared';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { ProgressBar } from '@/components/ProgressBar';
import { Text } from '@/components/Text';
import { Colors, Radius, Spacing } from '@/theme';
import { formatNumber } from '@/utils/format';

export interface StandingsProps {
  participants: ParticipantView[];
  type: ChallengeType | undefined;
  meId?: string | null;
  /** show only this many rows (plus me if I fall outside) */
  limit?: number;
  /** the challenge is over: rank 1 gets the crown treatment */
  finished?: boolean;
  style?: ViewStyle;
}

const MEDALS = ['🥇', '🥈', '🥉'];

/** Ranked bar chart of everyone's score — the heart of every challenge screen. */
export function Standings({ participants, type, meId, limit, finished, style }: StandingsProps) {
  const playing = participants.filter((p) => p.status === 'accepted' || p.status === 'invited');
  const ranked = [...playing].sort((a, b) => a.rank - b.rank);
  const shown = limit ? takeWithMe(ranked, limit, meId) : ranked;

  // In a lower-is-better çelinç rank 1 holds the SMALLEST number, so a raw
  // score/max ratio would hand the last-placed player the fullest bar.
  const lower = type?.direction === 'lower';
  const scores = ranked.filter((p) => p.status !== 'invited').map((p) => p.score);
  const worst = scores.length ? Math.max(...scores) : 0;
  const bestLow = scores.length ? Math.min(...scores) : 0;
  const fillFor = (score: number): number => {
    if (!lower) return worst > 0 ? score / worst : 0;
    // everybody at zero, or a dead heat: nobody is behind, so nobody gets a stub
    if (worst <= 0 || worst === bestLow) return 1;
    // keep a sliver of colour on the last row so the bar never reads as "missing"
    return Math.max(0.05, (worst - score) / worst);
  };

  return (
    <View style={[styles.wrap, style]}>
      {shown.map((participant) => {
        const isMe = participant.user.id === meId;
        const pending = participant.status === 'invited';
        const leading = participant.rank === 1 && !pending;
        const fill = fillFor(participant.score);
        const barColor = leading ? Colors.yellow : isMe ? Colors.accent : Colors.surfaceHigh;

        return (
          <View key={participant.user.id} style={[styles.row, isMe && styles.rowMe]}>
            <Text variant="tiny" style={styles.rank} muted={!leading}>
              {finished && participant.rank <= 3 ? MEDALS[participant.rank - 1] : `${participant.rank}.`}
            </Text>
            <Avatar
              emoji={participant.user.avatarEmoji}
              name={participant.user.displayName}
              size={30}
              ring={leading ? Colors.yellow : isMe ? Colors.accent : null}
            />
            <View style={styles.body}>
              <View style={styles.line}>
                <Text variant="small" bold numberOfLines={1} style={styles.name}>
                  {participant.user.displayName}
                  {isMe ? ' (sen)' : ''}
                </Text>
                <Text
                  variant="small"
                  bold
                  color={leading ? Colors.yellow : Colors.text}
                  numberOfLines={1}>
                  {pending
                    ? 'bekliyor'
                    : type
                      ? scoreLabel(type, participant.score)
                      : formatNumber(participant.score)}
                </Text>
              </View>
              <ProgressBar value={pending ? 0 : fill} color={barColor} height={6} />
            </View>
          </View>
        );
      })}
      {shown.length === 0 ? (
        <Text variant="small" faint>
          Henüz kimse giriş yapmadı.
        </Text>
      ) : null}
    </View>
  );
}

/** Keeps the top rows but always includes the reader, even in last place. */
function takeWithMe(ranked: ParticipantView[], limit: number, meId?: string | null): ParticipantView[] {
  const head = ranked.slice(0, limit);
  if (!meId || head.some((p) => p.user.id === meId)) return head;
  const mine = ranked.find((p) => p.user.id === meId);
  return mine ? [...head.slice(0, Math.max(1, limit - 1)), mine] : head;
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  rowMe: {
    backgroundColor: 'rgba(255,61,113,0.07)',
    borderRadius: Radius.sm,
    marginHorizontal: -Spacing.xs,
    paddingHorizontal: Spacing.xs,
    paddingVertical: 2,
  },
  rank: { width: 20, textAlign: 'center' },
  body: { flex: 1, gap: 4 },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  name: { flexShrink: 1 },
});
