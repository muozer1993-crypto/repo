import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';

import { Text } from '@/components/Text';
import { Colors, Radius, Spacing } from '@/theme';

export function Loading({ label, style }: { label?: string; style?: ViewStyle }) {
  return (
    <View style={[styles.wrap, style]}>
      <ActivityIndicator color={Colors.accent} />
      {label ? (
        <Text variant="small" muted style={styles.label}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

/** Grey block used while data loads, sized by the caller. */
export function Skeleton({ height = 16, width = '100%', style }: { height?: number; width?: number | `${number}%`; style?: ViewStyle }) {
  return <View style={[styles.skeleton, { height, width }, style]} />;
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, gap: Spacing.sm },
  label: {},
  skeleton: { backgroundColor: Colors.surfaceHigh, borderRadius: Radius.sm, opacity: 0.6 },
});
