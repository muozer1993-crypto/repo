import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { Colors, Radius, Shadow, Spacing } from '@/theme';

export interface CardProps {
  children: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  /** colored left edge, e.g. accent when you are losing */
  edgeColor?: string;
  padded?: boolean;
  glow?: boolean;
  /**
   * Clip children to the rounded box. On by default — a few cards hold
   * something that would otherwise spill past the corner.
   *
   * A card that changes size or border WHILE IT IS ON SCREEN has to turn this
   * off. On Android the clip is a canvas clipPath rebuilt every frame from the
   * view's bounds, its border insets and its radius (ReactViewGroup.dispatchDraw
   * → BackgroundStyleApplicator.clipToPaddingBox). Mutating the border and the
   * height in the same commit is what made a tapped row in the çelınc picker
   * stop painting altogether — and stay that way.
   */
  clip?: boolean;
  /**
   * Drop the shadow. Android draws it from an elevation outline that is rebuilt
   * whenever the box changes, and on a #0B0B0F page a black shadow is invisible
   * anyway, so a card that resizes pays the whole cost for nothing.
   */
  flat?: boolean;
}

export function Card({
  children,
  onPress,
  style,
  edgeColor,
  padded = true,
  glow,
  clip = true,
  flat,
}: CardProps) {
  const inner = (
    <View
      style={[
        styles.card,
        clip && styles.clipped,
        padded && { padding: Spacing.lg },
        edgeColor ? { borderLeftWidth: 4, borderLeftColor: edgeColor } : null,
        flat ? null : glow ? Shadow.glowAccent : Shadow.card,
        style,
      ]}>
      {children}
    </View>
  );

  if (!onPress) return inner;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => (pressed ? styles.pressed : undefined)}>
      {inner}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  clipped: { overflow: 'hidden' },
  pressed: { opacity: 0.85, transform: [{ scale: 0.995 }] },
});
