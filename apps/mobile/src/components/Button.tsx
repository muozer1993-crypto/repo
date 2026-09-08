import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  type PressableProps,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import { Text } from '@/components/Text';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/theme';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'yellow';
type Size = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  title: string;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: string;
  fullWidth?: boolean;
  style?: ViewStyle;
  haptic?: boolean;
}

const BG: Record<Variant, string> = {
  primary: Colors.accent,
  secondary: Colors.surfaceHigh,
  ghost: 'transparent',
  danger: Colors.danger,
  success: Colors.success,
  yellow: Colors.yellow,
};

const FG: Record<Variant, string> = {
  primary: Colors.white,
  secondary: Colors.text,
  ghost: Colors.textMuted,
  danger: Colors.white,
  success: Colors.black,
  yellow: Colors.black,
};

const PAD: Record<Size, { v: number; h: number; font: number }> = {
  sm: { v: Spacing.sm, h: Spacing.md, font: FontSize.tiny },
  md: { v: Spacing.md, h: Spacing.lg, font: FontSize.small },
  lg: { v: Spacing.lg - 2, h: Spacing.xl, font: FontSize.body },
  xl: { v: Spacing.lg + 2, h: Spacing.xl, font: FontSize.lead },
};

export function Button({
  title,
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  fullWidth,
  style,
  haptic = true,
  disabled,
  onPress,
  ...rest
}: ButtonProps) {
  const pad = PAD[size];
  const isDisabled = disabled || loading;

  const handlePress = useCallback<NonNullable<PressableProps['onPress']>>(
    (event) => {
      if (haptic && Platform.OS !== 'web') {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
      onPress?.(event);
    },
    [haptic, onPress]
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      disabled={isDisabled}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: BG[variant],
          paddingVertical: pad.v,
          paddingHorizontal: pad.h,
        },
        variant === 'ghost' && styles.ghost,
        fullWidth && styles.fullWidth,
        pressed && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator color={FG[variant]} size="small" />
      ) : (
        <View style={styles.row}>
          {icon ? (
            <Text style={{ fontSize: pad.font + 2, marginRight: Spacing.sm }}>{icon}</Text>
          ) : null}
          <Text
            numberOfLines={1}
            style={{
              color: FG[variant],
              fontSize: pad.font,
              fontWeight: FontWeight.black,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
            }}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  ghost: {
    borderWidth: 1,
    borderColor: Colors.border,
  },
  fullWidth: { alignSelf: 'stretch' },
  pressed: { opacity: 0.75, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
