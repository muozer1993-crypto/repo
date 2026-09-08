import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors, Layout, Spacing } from '@/theme';

export interface ScreenProps {
  children: ReactNode;
  /** wraps content in a ScrollView */
  scroll?: boolean;
  /** pull-to-refresh handler (implies scroll) */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** dims the top with a pink glow — used on hero screens */
  glow?: boolean;
  padded?: boolean;
  style?: ViewStyle;
  contentStyle?: ViewStyle;
  /** extra bottom padding, e.g. for a floating action button */
  bottomInset?: number;
  keyboard?: boolean;
}

export function Screen({
  children,
  scroll,
  onRefresh,
  refreshing,
  glow,
  padded = true,
  style,
  contentStyle,
  bottomInset = 0,
  keyboard,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const body = (
    <View
      style={[
        styles.inner,
        padded && { paddingHorizontal: Spacing.lg },
        { paddingBottom: bottomInset },
        contentStyle,
      ]}>
      {children}
    </View>
  );

  const content =
    scroll || onRefresh ? (
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={!!refreshing}
              onRefresh={onRefresh}
              tintColor={Colors.accent}
              colors={[Colors.accent]}
              progressBackgroundColor={Colors.surface}
            />
          ) : undefined
        }>
        {body}
      </ScrollView>
    ) : (
      body
    );

  return (
    <View style={[styles.root, { paddingTop: insets.top }, style]}>
      {glow ? (
        <LinearGradient
          colors={['rgba(255,61,113,0.22)', 'rgba(255,61,113,0.02)', 'transparent']}
          style={styles.glow}
          pointerEvents="none"
        />
      ) : null}
      {keyboard ? (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={insets.top}>
          {content}
        </KeyboardAvoidingView>
      ) : (
        content
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  flex: { flex: 1 },
  inner: { flex: 1, width: '100%', maxWidth: Layout.maxWidth, alignSelf: 'center' },
  scrollContent: { flexGrow: 1, paddingBottom: Spacing.xxl },
  glow: { position: 'absolute', top: 0, left: 0, right: 0, height: 280 },
});
