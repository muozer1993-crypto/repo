import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { Text } from '@/components/Text';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/theme';

export interface ChipProps {
  label: string;
  icon?: string;
  color?: string;
  /** filled = solid background of `color`, otherwise tinted outline */
  filled?: boolean;
  selected?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
  size?: 'sm' | 'md';
}

export function Chip({
  label,
  icon,
  color = Colors.textMuted,
  filled,
  selected,
  onPress,
  style,
  size = 'md',
}: ChipProps) {
  const bg = filled || selected ? color : 'transparent';
  const fg = filled || selected ? pickForeground(color) : color;
  const body = (
    <View
      style={[
        styles.chip,
        size === 'sm' ? styles.sm : styles.md,
        { backgroundColor: bg, borderColor: color },
        style,
      ]}>
      {icon ? <Text style={{ fontSize: size === 'sm' ? 11 : 13, marginRight: 4 }}>{icon}</Text> : null}
      <Text
        numberOfLines={1}
        style={{
          color: fg,
          fontSize: size === 'sm' ? FontSize.micro : FontSize.tiny,
          fontWeight: FontWeight.black,
          letterSpacing: 0.4,
        }}>
        {label}
      </Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => (pressed ? { opacity: 0.7 } : undefined)}>
      {body}
    </Pressable>
  );
}

/** black text on light chips, white on dark ones */
function pickForeground(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return Colors.white;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? Colors.black : Colors.white;
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  sm: { paddingVertical: 3, paddingHorizontal: Spacing.sm },
  md: { paddingVertical: 5, paddingHorizontal: Spacing.md },
});
