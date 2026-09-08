import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Text } from '@/components/Text';
import { Colors, Radius } from '@/theme';

export interface AvatarProps {
  emoji?: string | null;
  name?: string;
  size?: number;
  ring?: string | null;
  style?: ViewStyle;
}

/** Emoji-first avatar; falls back to the first letter of the display name. */
export function Avatar({ emoji, name, size = 44, ring, style }: AvatarProps) {
  const fallback = (name ?? '?').trim().charAt(0).toLocaleUpperCase('tr-TR') || '?';
  return (
    <View
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: Radius.pill,
          borderWidth: ring ? 2 : 1,
          borderColor: ring ?? Colors.border,
        },
        style,
      ]}>
      <Text style={{ fontSize: size * 0.5, lineHeight: size * 0.62 }}>{emoji || fallback}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: Colors.surfaceHigh,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
