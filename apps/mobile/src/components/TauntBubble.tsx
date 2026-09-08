import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Text } from '@/components/Text';
import { Colors, Radius, Shadow, Spacing } from '@/theme';

export interface TauntBubbleProps {
  title: string;
  body: string;
  fromName?: string;
  fromEmoji?: string | null;
  timeLabel?: string;
  /** dial the drama up: used on the shame screen */
  loud?: boolean;
  style?: ViewStyle;
}

/** The centrepiece of the app: the "KOYDUM MU?" card. */
export function TauntBubble({
  title,
  body,
  fromName,
  fromEmoji,
  timeLabel,
  loud,
  style,
}: TauntBubbleProps) {
  return (
    <View style={[styles.shell, loud ? Shadow.glowAccent : Shadow.card, style]}>
      <LinearGradient
        colors={loud ? [Colors.accent, '#B5164A'] : ['#2A1520', '#1B1119']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.gradient}>
        <View style={styles.header}>
          {fromName ? (
            <View style={styles.from}>
              <Avatar emoji={fromEmoji} name={fromName} size={28} ring={loud ? Colors.white : Colors.accent} />
              <Text variant="tiny" bold style={styles.fromName} numberOfLines={1}>
                {fromName}
              </Text>
            </View>
          ) : (
            <View />
          )}
          {timeLabel ? (
            <Text variant="micro" color={loud ? 'rgba(255,255,255,0.8)' : Colors.textFaint}>
              {timeLabel}
            </Text>
          ) : null}
        </View>

        <Text variant={loud ? 'huge' : 'title'} upper style={styles.title}>
          {title}
        </Text>
        <Text variant={loud ? 'lead' : 'body'} style={styles.body}>
          {body}
        </Text>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderRadius: Radius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.accentDim,
  },
  gradient: { padding: Spacing.lg, gap: Spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  from: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flexShrink: 1 },
  fromName: { flexShrink: 1 },
  title: { color: Colors.white },
  body: { color: 'rgba(255,255,255,0.94)' },
});
