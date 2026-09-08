import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Colors, Radius } from '@/theme';

export interface ProgressBarProps {
  /** 0..1 */
  value: number;
  color?: string;
  track?: string;
  height?: number;
  style?: ViewStyle;
}

export function ProgressBar({
  value,
  color = Colors.accent,
  track = Colors.surfaceHigh,
  height = 8,
  style,
}: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <View style={[styles.track, { backgroundColor: track, height, borderRadius: height / 2 }, style]}>
      <View
        style={{
          width: `${pct * 100}%`,
          backgroundColor: color,
          height: '100%',
          borderRadius: Radius.pill,
          minWidth: pct > 0 ? height : 0,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { width: '100%', overflow: 'hidden' },
});
