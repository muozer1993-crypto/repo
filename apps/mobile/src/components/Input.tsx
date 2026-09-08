import { forwardRef, useState } from 'react';
import {
  StyleSheet,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';

import { Text } from '@/components/Text';
import { Colors, FontSize, Radius, Spacing } from '@/theme';

export interface InputProps extends TextInputProps {
  label?: string;
  error?: string | null;
  hint?: string;
  containerStyle?: ViewStyle;
  suffix?: string;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  { label, error, hint, containerStyle, suffix, style, onFocus, onBlur, ...rest },
  ref
) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.wrap, containerStyle]}>
      {label ? (
        <Text variant="label" style={styles.label}>
          {label}
        </Text>
      ) : null}
      <View
        style={[
          styles.field,
          focused && { borderColor: Colors.accent },
          error ? { borderColor: Colors.danger } : null,
        ]}>
        <TextInput
          ref={ref}
          placeholderTextColor={Colors.textFaint}
          selectionColor={Colors.accent}
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, style]}
        />
        {suffix ? (
          <Text variant="small" muted style={styles.suffix}>
            {suffix}
          </Text>
        ) : null}
      </View>
      {error ? (
        <Text variant="tiny" color={Colors.danger} style={styles.helper}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="tiny" faint style={styles.helper}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch' },
  label: { marginBottom: Spacing.xs, marginLeft: 2 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
  },
  input: {
    flex: 1,
    color: Colors.text,
    fontSize: FontSize.body,
    paddingVertical: Spacing.md,
    minHeight: 48,
  },
  suffix: { marginLeft: Spacing.sm },
  helper: { marginTop: Spacing.xs, marginLeft: 2 },
});
