import type { RecapData } from '@koydum/shared';
import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/Card';
import { Stat } from '@/components/Stat';
import { Text } from '@/components/Text';
import { useLevel } from '@/store/auth';
import { Colors, FontSize, Radius, Spacing } from '@/theme';
import { formatNumber, formatWeekRange } from '@/utils/format';

export interface RecapCardProps {
  title: string;
  recap: RecapData;
  timeLabel: string;
  unread: boolean;
  onPress: () => void;
}

/**
 * The Sunday "haftanın hesabı" in the inbox: the week's score as tiles, then
 * the lines the server wrote at the reader's level (the king of the week, who
 * walked the most, the last word).
 */
export function RecapCard({ title, recap, timeLabel, unread, onPress }: RecapCardProps) {
  const level = useLevel();
  const polite = level === 1;

  return (
    <Card
      onPress={onPress}
      padded={false}
      edgeColor={unread ? Colors.yellow : undefined}
      style={unread ? styles.cardUnread : styles.cardRead}>
      <View style={styles.inner}>
        <View style={styles.top}>
          <View style={[styles.emojiWrap, unread && { borderColor: Colors.yellow }]}>
            <Text style={styles.emoji}>📊</Text>
          </View>
          <View style={styles.heading}>
            <Text variant="small" bold={unread} muted={!unread} numberOfLines={1}>
              {title}
            </Text>
            <Text variant="micro" faint>
              {formatWeekRange(recap.weekStart, recap.weekEnd)}
            </Text>
          </View>
          <Text variant="micro" faint>
            {timeLabel}
          </Text>
        </View>

        <View style={styles.tiles}>
          <Stat
            compact
            label={polite ? 'Galibiyet' : 'Koydun'}
            value={recap.wins}
            emoji={polite ? '🏆' : '🍆'}
            color={Colors.success}
          />
          <Stat
            compact
            label={polite ? 'Yenilgi' : 'Yedin'}
            value={recap.losses}
            emoji="😵"
            color={Colors.danger}
          />
          {recap.ties > 0 ? <Stat compact label="Berabere" value={recap.ties} emoji="🤝" /> : null}
          {recap.steps > 0 ? (
            <Stat compact label="Adım" value={formatNumber(recap.steps)} emoji="👟" color={Colors.info} />
          ) : null}
        </View>

        {recap.highlights.map((line) => (
          <Text key={line} variant="small" muted={!unread}>
            {line}
          </Text>
        ))}
        {recap.active > 0 ? (
          <Text variant="tiny" faint>
            ⏳ {recap.active} çelınc hâlâ sürüyor
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  cardUnread: { marginBottom: Spacing.md, backgroundColor: Colors.surfaceHigh },
  cardRead: { marginBottom: Spacing.md, opacity: 0.82 },
  inner: { padding: Spacing.md, gap: Spacing.sm },
  top: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  heading: { flex: 1, gap: 2 },
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
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
});
