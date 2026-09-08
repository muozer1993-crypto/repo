import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Text } from '@/components/Text';
import { Colors, Radius, Spacing } from '@/theme';

export interface StatProps {
  label: string;
  value: string | number;
  emoji?: string;
  color?: string;
  style?: ViewStyle;
  compact?: boolean;
}

export function Stat({ label, value, emoji, color = Colors.text, style, compact }: StatProps) {
  return (
    <View style={[styles.wrap, compact && styles.compact, style]}>
      {emoji ? <Text style={styles.emoji}>{emoji}</Text> : null}
      <Text variant={compact ? 'title' : 'big'} color={color} numberOfLines={1} adjustsFontSizeToFit>
        {typeof value === 'number' ? value.toLocaleString('tr-TR') : value}
      </Text>
      <Text variant="label" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    minWidth: 78,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.sm,
    alignItems: 'center',
    gap: 2,
  },
  compact: { paddingVertical: Spacing.sm },
  emoji: { fontSize: 18 },
});
