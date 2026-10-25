import type { Challenge, ChallengeType, VulgarityLevel } from '@koydum/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { Colors, Spacing } from '@/theme';
import { safeDayKeysBetween } from '@/utils/datetime';
import { dateRange, formatNumber } from '@/utils/format';
import { typeDescription } from '@/utils/levelCopy';

/**
 * Whether this çelınc wants a photo with every typed number. The flag only
 * binds where a photo can back a number (the server's rule, services/entries):
 * a yes/no day, a check-in or a focus session has no photo step and ignores it.
 */
export function needsProof(challenge: Pick<Challenge, 'proofRequired' | 'metricType'>): boolean {
  return (
    challenge.proofRequired &&
    (challenge.metricType === 'manual_count' ||
      challenge.metricType === 'manual_lower_is_better' ||
      challenge.metricType === 'auto_steps')
  );
}

/**
 * "📅 7 gün · 1 Eylül – 7 Eylül": the days the server scores, in the account's
 * zone, both ends included. Empty for dates it cannot read.
 */
export function scheduleLine(challenge: Pick<Challenge, 'startsAt' | 'endsAt'>, tz: string): string {
  const days = safeDayKeysBetween(challenge.startsAt, challenge.endsAt, tz).length;
  if (days === 0) return '';
  return `📅 ${days} gün · ${dateRange(challenge.startsAt, challenge.endsAt, tz)}`;
}

export interface ChallengeRulesProps {
  challenge: Challenge;
  type: ChallengeType | undefined;
  level: VulgarityLevel;
  /** the account's IANA zone, the one the server counts days in */
  tz: string;
  /** "Nasıl sayılıyor?" starts unfolded: for somebody about to say yes */
  initiallyOpen?: boolean;
}

/**
 * What a çelınc asks of its players, in one card: who wins, for how many days,
 * by what hour, whether a typed number needs a photo, what an empty day costs,
 * and what is at stake. An invitee reads it right above "Varım", so a friend
 * asked into a screen-time çelınc learns about the nightly screenshot and the
 * 1440-minute day before joining, not after; everybody else finds it further
 * down, folded.
 */
export function ChallengeRules({ challenge, type, level, tz, initiallyOpen = false }: ChallengeRulesProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const schedule = scheduleLine(challenge, tz);
  const penalty = type?.missingDayPenalty;
  // a type this app does not know, unreadable dates and no stakes: nothing to say
  const empty =
    !type &&
    !schedule &&
    !challenge.deadlineTime &&
    !needsProof(challenge) &&
    !challenge.rewardText &&
    !challenge.penaltyText;
  if (empty) return null;

  return (
    // "Nasıl sayılıyor?" changes the card's height on screen: no clip (CardProps.clip)
    <Card clip={false}>
      <Text variant="label" style={styles.label}>
        Kurallar
      </Text>
      <View style={styles.lines}>
        {type ? <Text variant="small">{typeDescription(type, level)}</Text> : null}
        {schedule ? <Text variant="small">{schedule}</Text> : null}
        {/* no suffix after the hour: "07:00'den", "23:30'dan" depend on how it is read */}
        {challenge.deadlineTime ? (
          <Text variant="small">{`⏰ Her gün saat ${challenge.deadlineTime} olmadan “Geldim” demen lazım`}</Text>
        ) : null}
        {needsProof(challenge) ? (
          <Text variant="small" color={Colors.yellow}>
            📸 Elle girdiğin her sayıya kanıt fotoğrafı lazım
          </Text>
        ) : null}
        {type && penalty !== undefined ? (
          <Text variant="small">{`⚠️ Girmediğin gün ${formatNumber(penalty)} ${type.unitTr} yazılır`}</Text>
        ) : null}
        {challenge.rewardText ? (
          <Text variant="small">
            🎁 <Text variant="small" bold>{challenge.rewardText}</Text>
          </Text>
        ) : null}
        {challenge.penaltyText ? (
          <Text variant="small" color={Colors.danger}>
            💀 {challenge.penaltyText}
          </Text>
        ) : null}
      </View>
      {type?.howMeasuredTr ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen((prev) => !prev)}
            hitSlop={12}
            style={styles.toggle}>
            <Text variant="small" color={Colors.accent} bold>
              {open ? 'Nasıl sayılıyor? ▴' : 'Nasıl sayılıyor? ▾'}
            </Text>
          </Pressable>
          {open ? (
            <Text variant="tiny" muted>
              {type.howMeasuredTr}
            </Text>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  label: { marginBottom: Spacing.md },
  lines: { gap: Spacing.sm },
  toggle: { alignSelf: 'flex-start', marginTop: Spacing.md, paddingVertical: Spacing.xs },
});
